import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { packager } from "@electron/packager";
import { flipFuses, FuseV1Options, FuseVersion } from "@electron/fuses";

const root = fileURLToPath(new URL("../../", import.meta.url));
const here = fileURLToPath(new URL("./", import.meta.url));
const require = createRequire(import.meta.url);
const output = resolve(root, "test-results/data-spike");
const scratch = join(output, "scratch");
const native = join(here, `node_modules/better-sqlite3/prebuilds/${process.platform}-${process.arch}.node`);
const electronVersion = require("../../node_modules/electron/package.json").version;
// Read the prepared executable directly: require('electron') can download lazily.
const electron = join(root, "node_modules/electron/dist", (await readFile(join(root, "node_modules/electron/path.txt"), "utf8")).trim());
const report = { platform: process.platform, arch: process.arch, electronVersion, size: {}, runs: {} };
await rm(output, { recursive: true, force: true });
await mkdir(scratch, { recursive: true, mode: 0o700 });
const env = { ...process.env, SPIKE_NATIVE_BINDING: native };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
const execute = (file, args, extra = {}) => execFileSync(file, args, { env, stdio: "inherit", timeout: 120_000, killSignal: "SIGKILL", ...extra });
const bundle = (entry, outfile) => build({
  entryPoints: [join(here, entry)], outfile, bundle: true, platform: "node", format: "cjs", target: "node24",
  external: ["electron"], loader: { ".sql": "text" },
  banner: { js: 'const __non_webpack_require__ = require("node:module").createRequire(process.execPath);' },
});
async function collect(label, executable, prefix = []) {
  const directory = join(scratch, label);
  const result = join(output, `${label}.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  execute(executable, [...prefix, directory, result,
    ...(["electron-main", "packaged-asar"].includes(label) ? [`--user-data-dir=${directory}`] : [])]);
  const rows = JSON.parse(await readFile(result, "utf8"));
  assert.equal(rows.length, 2);
  report.runs[label] = rows;
  await writeFile(join(output, "summary.json"), JSON.stringify(report, null, 2));
}

try {
  // Measure the incremental minified driver + schema payload separately from
  // the benchmark harness. Same entry shape, production esbuild settings.
  for (const engine of ["node-sqlite", "better-sqlite3"]) {
    const result = await build({
      stdin: { contents: `import {drizzle} from 'drizzle-orm/${engine}'; import * as schema from './schema'; export {schema,drizzle};`, resolveDir: here },
      bundle: true, platform: "node", format: "cjs", minify: true, write: false,
      external: ["better-sqlite3"],
    });
    const bytes = result.outputFiles[0].contents;
    const nativeBytes = engine === "better-sqlite3" ? await readFile(native) : Buffer.alloc(0);
    // better-sqlite3's JS is separately bundled for an honest total.
    const driver = engine === "better-sqlite3" ? await build({
      stdin: { contents: "module.exports = require('better-sqlite3')", resolveDir: here },
      bundle: true, platform: "node", format: "cjs", minify: true, write: false,
    }) : undefined;
    const js = Buffer.concat([bytes, driver?.outputFiles[0].contents ?? Buffer.alloc(0)]);
    report.size[engine] = { jsBytes: js.length, nativeBytes: nativeBytes.length, gzipBytes: gzipSync(Buffer.concat([js, nativeBytes])).length };
  }
  const nodeEntry = join(scratch, "node.cjs");
  await bundle("node.ts", nodeEntry);
  await collect("node", process.execPath, [nodeEntry]);

  // This is a spike-only foom-host variant: same Node 24 SEA build recipe,
  // with benchmark entry instead of the daemon. No SSH or ordinary host state.
  const hostEntry = join(scratch, "host.cjs");
  await bundle("host.ts", hostEntry);
  const digest = join(scratch, "native.sha256");
  await writeFile(digest, createHash("sha256").update(await readFile(native)).digest("hex"));
  const blob = join(scratch, "host.blob");
  const config = join(scratch, "sea.json");
  await writeFile(config, JSON.stringify({ main: hostEntry, output: blob, disableExperimentalSEAWarning: true,
    useSnapshot: false, useCodeCache: false, execArgvExtension: "none", assets: { "better_sqlite3.node": native, "native.sha256": digest } }));
  execute(process.execPath, ["--experimental-sea-config", config]);
  const host = join(scratch, process.platform === "win32" ? "foom-host.exe" : "foom-host");
  await copyFile(process.execPath, host);
  await chmod(host, 0o700);
  if (process.platform === "darwin") execute("codesign", ["--remove-signature", host]);
  execute(process.execPath, [join(root, "node_modules/postject/dist/cli.js"), host, "NODE_SEA_BLOB", blob,
    "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2", ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : [])]);
  if (process.platform === "darwin") {
    execute("codesign", ["--force", "--sign", "-", "--entitlements", join(root, "scripts/entitlements-adhoc.plist"), host]);
    execute("codesign", ["--verify", "--strict", host]);
  }
  await collect("foom-host-sea", host);

  const appDir = join(scratch, "app");
  await mkdir(appDir);
  await bundle("electron.ts", join(appDir, "main.cjs"));
  await copyFile(native, join(appDir, "native.node"));
  await writeFile(join(appDir, "package.json"), JSON.stringify({ name: "foom-data-spike", version: "0.0.0", main: "main.cjs" }));
  await collect("electron-main", electron, [appDir]);
  const [packaged] = await packager({ dir: appDir, out: join(scratch, "packaged"),
    name: "FoomDataSpike", executableName: "FoomDataSpike", electronVersion,
    electronZipDir: join(root, ".cache/data-spike-electron"),
    asar: { unpack: "*.node" }, overwrite: true, prune: false });
  assert.ok(packaged);
  const app = join(packaged, "FoomDataSpike.app");
  const executable = process.platform === "darwin" ? join(app, "Contents/MacOS/FoomDataSpike")
    : join(packaged, process.platform === "win32" ? "FoomDataSpike.exe" : "FoomDataSpike");
  await flipFuses(process.platform === "darwin" ? app : executable, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  });
  if (process.platform === "darwin") {
    execute("codesign", ["--force", "--deep", "--sign", "-", "--entitlements", join(root, "scripts/entitlements-adhoc.plist"), app]);
    execute("codesign", ["--verify", "--deep", "--strict", app]);
  }
  const resources = process.platform === "darwin" ? join(app, "Contents/Resources") : join(packaged, "resources");
  report.asar = { archiveBytes: (await stat(join(resources, "app.asar"))).size,
    unpackedNativeBytes: (await stat(join(resources, "app.asar.unpacked/native.node"))).size };
  await collect("packaged-asar", executable);
  report.signing = process.platform === "darwin" ? "ad-hoc app and SEA verified; no notarization claim" : "unsigned fixture";
  report.native = "better-sqlite3 13 N-API prebuild reused unchanged in Node, SEA and Electron; no rebuild";
  await writeFile(join(output, "summary.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
