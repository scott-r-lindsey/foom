import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FuseState, FuseV1Options, getCurrentFuseWire, pathToFuseFile } from "@electron/fuses";

// Environment credentials include the six Release secrets and conventional CI
// secret/token variables. Match literals, longest first, including PEM lines.
export function redactOutput(output, args, env = process.env) {
  const sensitiveFlags = new Set(["-p", "-P", "-k", "--key-id", "--issuer"]);
  const values = [
    ...args.filter((_value, index) => sensitiveFlags.has(args[index - 1])),
    ...Object.entries(env)
      .filter(([name]) => /SECRET|TOKEN|PASSWORD|PASSWD|KEY|ISSUER|TEAM_ID|CERT/i.test(name))
      .map(([_name, value]) => value),
  ].filter((value) => typeof value === "string" && value.length > 0);
  const literals = [...new Set(values.flatMap((value) => [value, ...value.split(/\r?\n/)]))]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  return literals.length
    ? output.replace(new RegExp(literals.map(RegExp.escape).join("|"), "g"), "[REDACTED]")
    : output;
}

// Capture failures ourselves: execFile errors include argv. Include only the
// tool's redacted output, never argv or the spawn error's command description.
export function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    const output = redactOutput(
      [result.stderr, result.stdout].filter(Boolean).join("\n"),
      args,
    ).trim();
    throw new Error(`${command} failed${output ? `:\n${output}` : ""}`);
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
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

export async function signApp(app, options, execute = run, snapshot = integrity) {
  const before = await snapshot(app, execute);
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

export async function notarizeApp(app, credentials, execute = run) {
  const { notarize } = await import("@electron/notarize");
  await notarize({ appPath: app, ...credentials }); // notarytool API-key mode; also staples.
  execute("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  const assessment = execute("spctl", ["-a", "-t", "exec", "-vv", app]);
  assert.match(assessment, /source=Notarized Developer ID/);
  execute("xcrun", ["stapler", "validate", app]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, input, output] = process.argv.slice(2);
  if (mode === "adhoc" && input && !output) {
    await signApp(resolve(input), { identity: "-" });
  } else if (["release", "adhoc-zip"].includes(mode) && input && output) {
    const { mkdir } = await import("node:fs/promises");
    const directory = join(process.env.RUNNER_TEMP, "foom-signing");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const { identity, keychain } =
      mode === "release"
        ? JSON.parse(await readFile(join(directory, "identity.json"), "utf8"))
        : { identity: "-" };
    const unpack = join(directory, "unpacked");
    await mkdir(unpack);
    run("ditto", ["-x", "-k", resolve(input), unpack]);
    assert.deepEqual(await readdir(unpack), ["Foom.app"]);
    const app = join(unpack, "Foom.app");
    await signApp(app, { identity, keychain });
    if (mode === "release")
      await notarizeApp(app, {
        appleApiKey: join(directory, "AuthKey.p8"),
        appleApiKeyId: process.env.APPLE_API_KEY_ID,
        appleApiIssuer: process.env.APPLE_API_ISSUER,
      });
    await mkdir(resolve(output), { recursive: true });
    run("ditto", ["-c", "-k", "--keepParent", app, join(resolve(output), basename(input))]);
  } else throw new Error("Expected adhoc APP or release/adhoc-zip TESTED_ZIP OUTPUT_DIRECTORY");
}
