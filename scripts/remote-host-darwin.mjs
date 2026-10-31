import assert from "node:assert/strict";
import { chmod, copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digest } from "./remote-host-artifacts.mjs";
import { run, signingArgs } from "./macos-sign.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
export const darwinInputNames = ["node", "host.cjs", "pty.node", "spawn-helper"];

/** Copy, never sign the shared dependency store or the installed Node executable. */
export async function writeDarwinInputs(directory, bundle, metadata) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const native = join(root, `node_modules/node-pty/prebuilds/darwin-${metadata.arch}`);
  const sources = [
    process.execPath,
    bundle,
    join(native, "pty.node"),
    join(native, "spawn-helper"),
  ];
  const files = {};
  for (const [index, name] of darwinInputNames.entries()) {
    const path = join(directory, name);
    await copyFile(sources[index], path);
    const bytes = await readFile(path);
    files[name] = { size: bytes.length, sha256: digest(bytes) };
  }
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({
      ...metadata,
      format: 1,
      protocol: 3,
      platform: "darwin",
      nodeVersion: process.version,
      files,
    }),
  );
}

/** Inputs come only from this run's artifacts, pinned to the app's sealed revision. */
export async function verifyDarwinInputs(directory, target, version, source) {
  assert.ok(["darwin-arm64", "darwin-x64"].includes(target), "Invalid Darwin target");
  assert.match(source ?? "", /^[a-f0-9]{40}$/, "Invalid input source revision");
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  assert.equal(manifest?.format, 1, "Unsupported Darwin input format");
  assert.equal(manifest.protocol, 3, "Input protocol mismatch");
  assert.equal(`${manifest.platform}-${manifest.arch}`, target, "Input target mismatch");
  assert.equal(manifest.version, version, "Input version mismatch");
  assert.equal(manifest.source, source, "Input source revision mismatch");
  assert.equal(
    manifest.nodeVersion,
    process.version,
    "SEA assembly requires the exact input Node version",
  );
  assert.ok(process.version.startsWith("v24."), "SEA assembly requires Node 24");
  assert.deepEqual(
    Object.keys(manifest.files ?? {}).sort(),
    [...darwinInputNames].sort(),
    "Invalid input file set",
  );
  const files = {};
  for (const name of darwinInputNames) {
    const expected = manifest.files[name];
    assert.ok(
      Number.isSafeInteger(expected?.size) &&
        expected.size > 0 &&
        expected.size <= 200 * 1024 * 1024,
      "Invalid input size",
    );
    assert.match(expected.sha256 ?? "", /^[a-f0-9]{64}$/, "Invalid input hash");
    const path = join(directory, name);
    const info = await lstat(path);
    assert.ok(info.isFile() && info.size === expected.size, "Input file size/type mismatch");
    const bytes = await readFile(path);
    assert.equal(bytes.length, expected.size, "Input size mismatch");
    assert.equal(digest(bytes), expected.sha256, "Input hash mismatch");
    files[name] = bytes;
  }
  return { manifest, files };
}

function teamIdentifier(path, execute) {
  const output = execute("codesign", ["--display", "--verbose=4", path]);
  const team = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(output)?.[1];
  assert.ok(team, "Missing signing Team ID");
  return team;
}

/** The same function serves native PR/dev assembly and the main-only signer. */
export async function assembleDarwinHost(
  directory,
  output,
  target,
  version,
  source,
  options,
  execute = run,
) {
  const started = performance.now();
  const { files } = await verifyDarwinInputs(directory, target, version, source);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const assets = {};
  const teams = [];
  for (const name of ["pty.node", "spawn-helper"]) {
    const path = join(output, name);
    await writeFile(path, files[name], { mode: name === "spawn-helper" ? 0o700 : 0o600 });
    execute("codesign", signingArgs(path, options));
    execute("codesign", ["--verify", "--strict", path]);
    if (options.identity !== "-") teams.push(teamIdentifier(path, execute));
    assets[name] = path;
  }
  const bundle = join(output, "host.cjs");
  await writeFile(bundle, files["host.cjs"]);
  const blob = join(output, "host.blob");
  const config = join(output, "sea.json");
  await writeFile(
    config,
    JSON.stringify({
      main: bundle,
      output: blob,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
      execArgvExtension: "none",
      assets,
    }),
  );
  // No target executable runs during cross-architecture assembly. Both Node
  // versions are identical; snapshots and V8 code cache are disabled.
  execute(process.execPath, ["--experimental-sea-config", config]);
  const executable = join(output, "foom-host");
  await writeFile(executable, files.node);
  await chmod(executable, 0o700);
  execute("codesign", ["--remove-signature", executable]);
  execute(process.execPath, [
    join(root, "node_modules/postject/dist/cli.js"),
    executable,
    "NODE_SEA_BLOB",
    blob,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    "--macho-segment-name",
    "NODE_SEA",
  ]);
  execute(
    "codesign",
    signingArgs(executable, {
      ...options,
      entitlements: resolve(
        root,
        "scripts",
        options.identity === "-" ? "entitlements-adhoc.plist" : "entitlements-remote-host.plist",
      ),
    }),
  );
  execute("codesign", ["--verify", "--strict", executable]);
  const entitlements = execute("codesign", ["--display", "--entitlements", ":-", executable]);
  assert.match(
    entitlements,
    /<key>com\.apple\.security\.cs\.allow-jit<\/key>\s*<true\s*\/>/,
    "Missing host allow-jit entitlement",
  );
  assert.equal(
    entitlements.includes("com.apple.security.cs.disable-library-validation"),
    options.identity === "-",
    "Unexpected host library validation entitlement",
  );
  if (options.identity !== "-") {
    const team = teamIdentifier(executable, execute);
    assert.ok(
      teams.every((nativeTeam) => nativeTeam === team),
      "Native assets and host must share a Team ID",
    );
  }
  console.info(
    JSON.stringify({
      target,
      assemblyMs: performance.now() - started,
      nativeSigning: options.identity === "-" ? "ad-hoc" : "team-validated",
    }),
  );
  return executable;
}
