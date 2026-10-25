// Credential-free #851 feasibility proof. Runs only on the native macOS matrix.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { run, signingArgs } from "./macos-sign.mjs";

assert.equal(process.platform, "darwin");
assert.equal(process.versions.node.split(".")[0], "24");
const root = resolve(".");
const temporary = await mkdtemp(join(tmpdir(), "foom-sign-spike-"));
const started = performance.now();
try {
  const assets = {};
  for (const name of ["pty.node", "spawn-helper"]) {
    const path = join(temporary, name);
    await copyFile(
      join(root, `node_modules/node-pty/prebuilds/darwin-${process.arch}`, name),
      path,
    );
    run("codesign", signingArgs(path, { identity: "-" }));
    run("codesign", ["--verify", "--strict", path]);
    assets[name] = path;
  }
  const bundle = join(temporary, "host.cjs");
  await build({
    stdin: {
      contents: `import { spawn } from 'node-pty';
const child = spawn('/bin/sh', ['-f', '-c', 'printf foom-native-signing-ok'], {
  name: 'xterm', cols: 80, rows: 24, cwd: ${JSON.stringify(temporary)},
  env: { PATH: '/usr/bin:/bin', HOME: ${JSON.stringify(temporary)} }
});
let output = '';
const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 10000);
child.onData(data => { output += data; });
child.onExit(({exitCode}) => { clearTimeout(timer); if (exitCode !== 0 || output !== 'foom-native-signing-ok') process.exitCode = 1; else console.log(output); });`,
      resolveDir: root,
    },
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    outfile: bundle,
    plugins: [
      {
        name: "sea-pty",
        setup(api) {
          api.onLoad({ filter: /node-pty[\\/]lib[\\/]utils\.js$/ }, () => ({
            contents: `export { loadNativeModule } from ${JSON.stringify(join(root, "src/terminal-host/remote/native.ts"))}; export const assign = Object.assign;`,
            loader: "js",
          }));
        },
      },
    ],
  });
  const blob = join(temporary, "host.blob");
  const config = join(temporary, "sea.json");
  await writeFile(
    config,
    JSON.stringify({
      main: bundle,
      output: blob,
      assets,
      disableExperimentalSEAWarning: true,
      execArgvExtension: "none",
    }),
  );
  run(process.execPath, ["--experimental-sea-config", config]);
  const executable = join(temporary, "foom-host");
  await copyFile(process.execPath, executable);
  await chmod(executable, 0o700);
  run("codesign", ["--remove-signature", executable]);
  run(process.execPath, [
    join(root, "node_modules/postject/dist/cli.js"),
    executable,
    "NODE_SEA_BLOB",
    blob,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    "--macho-segment-name",
    "NODE_SEA",
  ]);
  run(
    "codesign",
    signingArgs(executable, {
      identity: "-",
      entitlements: resolve("scripts/entitlements-adhoc.plist"),
    }),
  );
  run("codesign", ["--verify", "--strict", executable]);
  assert.equal(run(executable, [], { timeout: 20000 }).trim(), "foom-native-signing-ok");
  for (const name of Object.keys(assets))
    run("codesign", ["--verify", "--strict", join(temporary, "native", name)]);
  // Ad-hoc signatures have no Team ID: library validation must reject the addon.
  run(
    "codesign",
    signingArgs(executable, {
      identity: "-",
      entitlements: resolve("scripts/entitlements-runtime.plist"),
    }),
  );
  await rm(join(temporary, "native"), { recursive: true });
  await mkdir(join(temporary, "native"), { mode: 0o700 });
  assert.throws(
    () => run(executable, [], { timeout: 20000 }),
    /Team ID|library load|code signature/,
  );
  console.info(
    JSON.stringify({
      arch: process.arch,
      node: process.version,
      elapsedMs: performance.now() - started,
      result:
        "signed embedded addon and spawn-helper execute; library validation rejects ad-hoc addon as expected",
    }),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
