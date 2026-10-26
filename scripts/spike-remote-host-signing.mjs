// Credential-free #851 feasibility proof. Runs only on the native macOS matrix.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { run, signingArgs } from "./macos-sign.mjs";
import { assembleDarwinHost, writeDarwinInputs } from "./remote-host-darwin.mjs";

assert.equal(process.platform, "darwin");
assert.equal(process.versions.node.split(".")[0], "24");
const root = resolve(".");
const temporary = await mkdtemp(join(tmpdir(), "foom-sign-spike-"));
const started = performance.now();
try {
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
  const inputs = join(temporary, "inputs");
  const output = join(temporary, "assembly");
  const source = "0".repeat(40);
  await writeDarwinInputs(inputs, bundle, { arch: process.arch, version: "0.0.0", source });
  const executable = await assembleDarwinHost(
    inputs,
    output,
    `darwin-${process.arch}`,
    "0.0.0",
    source,
    { identity: "-" },
  );
  assert.equal(run(executable, [], { timeout: 20000 }).trim(), "foom-native-signing-ok");
  for (const name of ["pty.node", "spawn-helper"])
    run("codesign", ["--verify", "--strict", join(output, "native", name)]);
  // Ad-hoc behavior is diagnostic, not proof of Developer ID enforcement.
  run(
    "codesign",
    signingArgs(executable, {
      identity: "-",
      entitlements: resolve("scripts/entitlements-runtime.plist"),
    }),
  );
  await rm(join(output, "native"), { recursive: true });
  let adhocWithoutException = "accepted";
  try {
    assert.equal(run(executable, [], { timeout: 20000 }).trim(), "foom-native-signing-ok");
  } catch (error) {
    assert.match(error.message, /Team ID|library load|code signature/);
    adhocWithoutException = "rejected";
  }
  console.info(
    JSON.stringify({
      arch: process.arch,
      node: process.version,
      elapsedMs: performance.now() - started,
      result: "signed embedded addon and spawn-helper execute",
      adhocWithoutException,
    }),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
