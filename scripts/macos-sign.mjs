import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { extractFile } from "@electron/asar";
import { hostPlatforms, verifyHostArtifact, writeHostManifest } from "./remote-host-artifacts.mjs";
import { FuseState, FuseV1Options, getCurrentFuseWire, pathToFuseFile } from "@electron/fuses";

// Only Release credentials are secrets; workflow paths and unrelated environment
// values remain useful diagnostics. Short PEM fragments must not mask ordinary text.
export const releaseSecretNames = [
  "MACOS_CERT_P12",
  "MACOS_CERT_PASSWORD",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "APPLE_TEAM_ID",
];
export function redactOutput(output, args, env = process.env, command = "") {
  const sensitiveFlags = new Set(["--key", "--key-id", "--issuer", "--sign"]);
  if (basename(command) === "security") {
    sensitiveFlags.add("-P");
    if (["create-keychain", "unlock-keychain"].includes(args[0])) sensitiveFlags.add("-p");
    if (args[0] === "set-key-partition-list") sensitiveFlags.add("-k");
  }
  const values = [
    // Short argv values (especially the ad-hoc identity "-") would erase common
    // characters in diagnostics. Real Release env secrets remain covered below,
    // even if an import password is short; generated keychain passwords are long.
    ...args.filter((value, index) => sensitiveFlags.has(args[index - 1]) && value.length >= 4),
    ...releaseSecretNames.map((name) => env[name]),
  ].filter((value) => typeof value === "string" && value.length > 0);
  const literals = [
    ...new Set(
      values.flatMap((value) => [
        value,
        ...value.split(/\r?\n/).filter((line) => line.length > 16),
      ]),
    ),
  ]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  return literals.length
    ? output.replace(new RegExp(literals.map(RegExp.escape).join("|"), "g"), "[REDACTED]")
    : output;
}

// Capture failures ourselves: execFile errors include argv. Include only the
// tool's redacted output, never argv or the spawn error's command description.
export function run(command, args, options = {}) {
  // Submit must expose the ID before upload completes; other tools stay synchronous.
  if (options.onOutput) {
    const { onOutput, timeout, ...spawnOptions } = options;
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { ...spawnOptions, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      let failed = false;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeout);
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
          output = (output + chunk).slice(-1024 * 1024);
          onOutput(chunk, stream === child.stdout ? "stdout" : "stderr");
        });
      }
      child.on("error", () => {
        failed = true;
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (failed || code !== 0 || timedOut) {
          const detail = redactOutput(output, args, process.env, command).trim();
          reject(
            new Error(
              `${command} ${timedOut ? "timed out" : "failed"}${detail ? `:\n${detail}` : ""}`,
            ),
          );
        } else resolve(output);
      });
    });
  }
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error || result.status !== 0) {
    const output = redactOutput(
      [result.stderr, result.stdout].filter(Boolean).join("\n"),
      args,
      process.env,
      command,
    ).trim();
    throw Object.assign(
      new Error(
        `${command} ${result.error?.code === "ETIMEDOUT" ? "timed out" : "failed"}${output ? `:\n${output}` : ""}`,
      ),
      { status: result.status, signal: result.signal },
    );
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

// Artifact uploads preserve the path below out/make's first wildcard (zip/darwin/arm64).
// Share discovery between release signing and the PR ad-hoc artifact round trip.
export async function testedZip(directory) {
  const root = resolve(directory);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const zips = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".zip"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  assert.equal(
    zips.length,
    1,
    `Expected exactly one tested ZIP under ${root}; found ${zips.length}${zips.length ? `: ${zips.join(", ")}` : ""}`,
  );
  return zips[0];
}

const magic = new Set([
  "feedface",
  "cefaedfe",
  "feedfacf",
  "cffaedfe",
  "cafebabe",
  "bebafeca",
  "cafebabf",
  "bfbafeca",
]);
export async function signingOrder(app) {
  const targets = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      // Framework aliases must not cause duplicate signing or escape the bundle.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(path);
        if (/\.(app|framework|xpc)$/.test(entry.name)) targets.push(path);
      } else if (entry.isFile()) {
        const file = await open(path, "r");
        try {
          const header = Buffer.alloc(4);
          await file.read(header, 0, 4, 0);
          if (magic.has(header.toString("hex"))) targets.push(path);
        } finally {
          await file.close();
        }
      }
    }
  }
  await visit(app);
  targets.push(app);
  return targets;
}

export function signingArgs(target, { identity, keychain, entitlements }) {
  return [
    "--force",
    "--sign",
    identity,
    "--options",
    "runtime",
    ...(identity === "-" ? ["--timestamp=none"] : ["--timestamp"]),
    ...(keychain ? ["--keychain", keychain] : []),
    ...(entitlements ? ["--entitlements", entitlements] : []),
    target,
  ];
}

export function entitlementFor(app, target, adhoc) {
  const path = relative(app, target);
  // Modern Electron/V8 and Node 24's SEA use MAP_JIT. Native addons are
  // re-signed with our identity, so Developer ID needs no library-validation
  // exception. The utility host is Electron Helper (Plugin), also a V8 runtime.
  // node-pty's spawn-helper and native observer executables need no exceptions.
  const runtime =
    target === app ||
    /\.app$/.test(target) ||
    /Contents\/MacOS\//.test(path) ||
    /build\/console\/foom$/.test(path);
  return runtime
    ? resolve("scripts", adhoc ? "entitlements-adhoc.plist" : "entitlements-runtime.plist")
    : undefined;
}

async function integrity(app, execute) {
  const fuses = await getCurrentFuseWire(app);
  for (const [option, expected] of [
    [FuseV1Options.RunAsNode, FuseState.DISABLE],
    [FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
    [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
    [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
  ])
    assert.equal(fuses[option], expected, `Unexpected fuse ${option}`);
  const plist = join(app, "Contents/Info.plist");
  const embedded = execute("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :ElectronAsarIntegrity",
    plist,
  ]);
  assert.ok(embedded.includes("SHA256"), "Missing embedded ASAR integrity");
  // Electron 44 also pins the Info.plist ASAR record in the framework's
  // integrity-digest sentinel. Check the active v1 payload in every slice.
  const framework = await readFile(pathToFuseFile(app));
  const sentinel = Buffer.from("AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A");
  const digests = [];
  for (
    let offset = framework.indexOf(sentinel);
    offset !== -1;
    offset = framework.indexOf(sentinel, offset + sentinel.length)
  ) {
    const payload = framework.subarray(offset + sentinel.length, offset + sentinel.length + 34);
    assert.equal(payload.length, 34, "Truncated embedded ASAR digest");
    assert.equal(payload[0], 1, "Embedded ASAR digest is not enabled");
    assert.equal(payload[1], 1, "Unknown embedded ASAR digest version");
    digests.push(payload.toString("hex"));
  }
  assert.ok(digests.length > 0, "Missing embedded ASAR digest");

  const archive = createHash("sha256")
    .update(await readFile(join(app, "Contents/Resources/app.asar")))
    .digest("hex");
  return { fuses, embedded, digests, archive };
}

// Gzip payloads are invisible to Mach-O discovery, but Apple inspects their
// contents. Complete this pass and refresh unpacked metadata before app sealing.
export async function signBundledRemoteHosts(app, options, execute = run) {
  const archive = join(app, "Contents/Resources/app.asar");
  const { source } = JSON.parse(extractFile(archive, "build/build-metadata.json").toString());
  const { version } = JSON.parse(extractFile(archive, "package.json").toString());
  const catalog = join(app, "Contents/Resources/app.asar.unpacked/build/remote-hosts");
  // Validate all inputs against the sealed app revision before modifying any.
  for (const target of hostPlatforms)
    await verifyHostArtifact(join(catalog, target), target, version, source);
  const temporary = await mkdtemp(join(tmpdir(), "foom-host-sign-"));
  try {
    for (const target of hostPlatforms.filter((target) => target.startsWith("darwin-"))) {
      const directory = join(catalog, target);
      const { manifest, bytes } = await verifyHostArtifact(directory, target, version, source);
      const executable = join(temporary, "foom-host");
      await writeFile(executable, bytes);
      await chmod(executable, 0o700);
      execute(
        "codesign",
        signingArgs(executable, {
          ...options,
          entitlements: resolve("scripts/entitlements-remote-host.plist"),
        }),
      );
      execute("codesign", ["--verify", "--strict", executable]);
      // Write into private scratch first; never leave an expanded host in the app.
      await writeHostManifest(temporary, manifest);
      for (const name of ["foom-host.gz", "manifest.json"])
        await writeFile(join(directory, name), await readFile(join(temporary, name)));
      await verifyHostArtifact(directory, target, version, source);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function signApp(app, options, execute = run, snapshot = integrity) {
  const before = await snapshot(app, execute);
  await signBundledRemoteHosts(app, options, execute);
  for (const target of await signingOrder(app)) {
    execute(
      "codesign",
      signingArgs(target, {
        ...options,
        entitlements: entitlementFor(app, target, options.identity === "-"),
      }),
    );
    if (target === join(app, "Contents/Resources/app.asar.unpacked/build/console/foom")) {
      // Code signing changes the SEA's bytes. Refresh only its unpacked build
      // metadata before the enclosing app seals resources; never rewrite ASAR.
      const manifestPath = join(
        app,
        "Contents/Resources/app.asar.unpacked/build/console/manifest.json",
      );
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.sha256 = createHash("sha256")
        .update(await readFile(target))
        .digest("hex");
      await writeFile(manifestPath, JSON.stringify(manifest));
    }
  }
  execute("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  assert.deepEqual(await snapshot(app, execute), before, "Signing changed fuses or ASAR integrity");
}

// One budget covers both submissions, not 120 minutes per artifact. The workflow
// leaves additional time for signing, image creation, verification and cleanup.
export const notarizationDeadlineMs = 120 * 60 * 1000;
export function notarizationSession({
  deadlineMs = notarizationDeadlineMs,
  pollMs = 30_000,
  queryTimeoutMs = 60_000,
  stapleRetryMs = 30_000,
  now = Date.now,
  wait = sleep,
  log = console.log,
} = {}) {
  let deadline;
  const submissions = [];
  // Stapler operations use the same clock, submission history and redaction as submit.
  return async (artifact, credentials, execute = run, operation = "submit") => {
    deadline ??= now() + deadlineMs;
    const auth = [
      "--key",
      credentials.appleApiKey,
      "--key-id",
      credentials.appleApiKeyId,
      "--issuer",
      credentials.appleApiIssuer,
    ];
    const safe = (text) => redactOutput(text, auth);
    const report = (text) => log(safe(`[${new Date(now()).toISOString()}] ${text}`));
    const history = () =>
      submissions
        .map(({ artifact, id, status }) => `${basename(artifact)}: ${id} (${status})`)
        .join("; ");
    const remaining = () => {
      if (now() >= deadline)
        throw new Error(
          `Notarization deadline exceeded; ${history() || "no submission ID returned"}`,
        );
      return deadline - now();
    };
    const query = async (operation, target) => {
      const output = await execute(
        "xcrun",
        ["notarytool", operation, target, ...auth, "--output-format", "json"],
        { timeout: Math.min(queryTimeoutMs, remaining()), killSignal: "SIGKILL" },
      );
      try {
        return JSON.parse(output);
      } catch {
        throw new Error(`notarytool ${operation} returned invalid JSON`);
      }
    };
    let lastStaplerError;
    try {
      if (operation !== "submit") {
        assert.ok(["staple", "validate"].includes(operation), "Unknown stapler operation");
        for (let attempt = 1; attempt <= 6; attempt++) {
          const timeout = Math.min(queryTimeoutMs, remaining());
          const label = `${basename(artifact)} stapler ${operation} attempt ${attempt}/6`;
          report(`${label}: starting`);
          try {
            await execute("xcrun", ["stapler", operation, artifact], {
              timeout,
              killSignal: "SIGKILL",
            });
            report(`${label}: exit status 0`);
            return;
          } catch (error) {
            lastStaplerError = error;
            report(
              `${label}: exit status ${error.status ?? "unknown"}${error.signal ? ` (${error.signal})` : ""}; ${error.message}`,
            );
            // The domain and stapler's generic 65/68 suffix also accompany
            // permanent failures. Retry only known transport or ticket propagation causes.
            const urlCode = /\bNSURLErrorDomain\s+Code\s*=\s*(-\d+)\b/i.exec(error.message)?.[1];
            const transient =
              ["-1001", "-1003", "-1004", "-1005", "-1009"].includes(urlCode) ||
              /\brecord not found\b|\bticket (?:is )?not (?:yet )?available\b/i.test(error.message);
            if (!transient || attempt === 6) throw error;
          }
          await wait(Math.min(stapleRetryMs, remaining()));
        }
      }
      report(`Submitting ${basename(artifact)} for notarization`);
      let record;
      const remember = (id) => {
        if (record || typeof id !== "string" || !id.length) return;
        record = { artifact, id, status: "Submitted" };
        submissions.push(record);
        report(`${basename(artifact)} submission ID: ${record.id}`);
      };
      const pending = { stdout: "", stderr: "" };
      const onOutput = (chunk, stream = "stdout") => {
        pending[stream] += chunk;
        const lines = pending[stream].split(/\r?\n/);
        pending[stream] = lines.pop().slice(-4096);
        for (const line of lines) {
          const match = /^\s*id:\s*(\S+)\s*$/i.exec(line);
          if (match) remember(match[1]);
        }
      };
      const output = await execute(
        "xcrun",
        ["notarytool", "submit", artifact, ...auth, "--no-progress"],
        { timeout: remaining(), killSignal: "SIGKILL", onOutput },
      );
      // Also accept complete output from injected executors and unterminated lines.
      pending.stdout = "";
      pending.stderr = "";
      onOutput(`${output}\n`);
      if (!record) {
        try {
          remember(JSON.parse(output)?.id);
        } catch {
          /* Validated below. */
        }
      }
      assert.ok(record, "Missing notarization submission ID");
      while (true) {
        const info = await query("info", record.id);
        assert.ok(
          ["In Progress", "Accepted", "Invalid", "Rejected"].includes(info?.status),
          "Unknown notarization status",
        );
        record.status = info.status;
        // A heartbeat even when the status is unchanged shows Apple's queue is
        // still being polled, rather than silently holding a runner.
        report(`${basename(artifact)} ${record.id}: ${record.status}`);
        if (["Invalid", "Rejected"].includes(record.status)) {
          try {
            const detail = await query("log", record.id);
            report(
              `Notarization issues for ${record.id}: ${JSON.stringify({
                statusSummary: detail?.statusSummary,
                issues: detail?.issues,
              })}`,
            );
          } catch (error) {
            report(`Could not retrieve notarization issues for ${record.id}: ${error.message}`);
          }
          throw new Error(`Notarization ${record.status}; ${history()}`);
        }
        if (record.status === "Accepted") return;
        await wait(Math.min(pollMs, remaining()));
      }
    } catch (error) {
      // Include all IDs even on tool errors/timeouts. Never echo unsanitized
      // tool output, JSON parse errors or credentials supplied outside env.
      const message = `${now() >= deadline ? "Notarization deadline exceeded; " : ""}${error.message}${lastStaplerError && lastStaplerError !== error ? `; last stapler error: ${lastStaplerError.message}` : ""}; submissions: ${history() || "none"}`;
      // Deliberately create a sanitized error without the raw tool error as
      // cause: Node prints causes and their argv/stdio in uncaught errors.
      const failure = new Error(safe(message));
      report(failure.message);
      throw failure;
    }
  };
}

export async function notarizeApp(app, credentials, execute = run, submit = notarizationSession()) {
  const directory = await mkdtemp(join(tmpdir(), "foom-notarize-"));
  try {
    const zip = join(directory, "Foom.zip");
    execute("ditto", ["-c", "-k", "--keepParent", app, zip]);
    await submit(zip, credentials, execute);
    await submit(app, credentials, execute, "staple");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  execute("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  const assessment = execute("spctl", ["-a", "-t", "exec", "-vv", app]);
  assert.match(assessment, /source=Notarized Developer ID/);
  await submit(app, credentials, execute, "validate");
}

export async function signDmg(dmg, credentials, execute = run, submit = notarizationSession()) {
  const { identity, keychain } = credentials;
  execute("codesign", ["--force", "--sign", identity, "--timestamp", "--keychain", keychain, dmg]);
  execute("codesign", ["--verify", "--strict", dmg]);
  await submit(dmg, credentials, execute);
  await submit(dmg, credentials, execute, "staple");
  await submit(dmg, credentials, execute, "validate");
  execute("spctl", ["-a", "-t", "open", "--context", "context:primary-signature", "-vv", dmg]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, input, output] = process.argv.slice(2);
  if (mode === "adhoc" && input && !output) {
    await signApp(resolve(input), { identity: "-" });
  } else if (["release", "adhoc-zip"].includes(mode) && input && output) {
    const zip = await testedZip(input);
    const { mkdir } = await import("node:fs/promises");
    const directory = join(process.env.RUNNER_TEMP, "foom-signing");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const { identity, keychain } =
      mode === "release"
        ? JSON.parse(await readFile(join(directory, "identity.json"), "utf8"))
        : { identity: "-" };
    const unpack = join(directory, "unpacked");
    await mkdir(unpack);
    run("ditto", ["-x", "-k", zip, unpack]);
    assert.deepEqual(await readdir(unpack), ["Foom.app"]);
    const app = join(unpack, "Foom.app");
    await signApp(app, { identity, keychain });
    const submit = notarizationSession();
    if (mode === "release")
      await notarizeApp(
        app,
        {
          appleApiKey: join(directory, "AuthKey.p8"),
          appleApiKeyId: process.env.APPLE_API_KEY_ID,
          appleApiIssuer: process.env.APPLE_API_ISSUER,
        },
        run,
        submit,
      );
    await mkdir(resolve(output), { recursive: true });
    run("ditto", ["-c", "-k", "--keepParent", app, join(resolve(output), basename(zip))]);
    // Build the image from the exact signed/stapled app, never the ad-hoc DMG.
    // PRs exercise the same maker after the artifact download without credentials.
    const { default: MakerDMG } = await import("./maker-dmg.cjs");
    const maker = new MakerDMG();
    await maker.prepareConfig(process.arch);
    const version = run("/usr/libexec/PlistBuddy", [
      "-c",
      "Print :CFBundleShortVersionString",
      join(app, "Contents/Info.plist"),
    ]).trim();
    const [dmg] = await maker.make({
      dir: unpack,
      makeDir: resolve(output),
      appName: "Foom",
      packageJSON: { version },
      targetArch: process.arch,
    });
    if (mode === "release")
      await signDmg(
        dmg,
        {
          identity,
          keychain,
          appleApiKey: join(directory, "AuthKey.p8"),
          appleApiKeyId: process.env.APPLE_API_KEY_ID,
          appleApiIssuer: process.env.APPLE_API_ISSUER,
        },
        run,
        submit,
      );
  } else
    throw new Error("Expected adhoc APP or release/adhoc-zip ARTIFACT_DIRECTORY OUTPUT_DIRECTORY");
}
