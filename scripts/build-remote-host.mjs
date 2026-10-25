import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkoutRevision, signRemoteHost, writeHostManifest } from "./remote-host-artifacts.mjs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
if (process.versions.node.split(".")[0] !== "24" || !["linux", "darwin"].includes(process.platform))
  throw new Error("Build foom-host on Linux or macOS with Node 24");
const output = process.env.FOOM_REMOTE_HOST_OUTPUT
  ? join(process.env.FOOM_REMOTE_HOST_OUTPUT, `${process.platform}-${process.arch}`)
  : join(root, "build/remote-host");
const temporary = join(root, "build/remote-sea");
await mkdir(output, { recursive: true, mode: 0o700 });
await mkdir(temporary, { recursive: true });
const bundle = join(temporary, "host.cjs");
await build({
  entryPoints: [join(root, "src/terminal-host/remote/main.ts")],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  outfile: bundle,
  // node-pty dynamically resolves its N-API addon. SEA embeds the exact pinned
  // prebuild; the shim extracts and verifies it before loading, without Electron.
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
const native = join(root, `node_modules/node-pty/prebuilds/${process.platform}-${process.arch}`);
await writeFile(
  config,
  JSON.stringify({
    main: bundle,
    output: blob,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    execArgvExtension: "none",
    assets: {
      "pty.node": join(native, "pty.node"),
      ...(process.platform === "darwin" ? { "spawn-helper": join(native, "spawn-helper") } : {}),
    },
  }),
);
execFileSync(process.execPath, ["--experimental-sea-config", config], { stdio: "inherit" });
const executable = join(output, "foom-host");
await copyFile(process.execPath, executable);
await chmod(executable, 0o700);
if (process.platform === "darwin") execFileSync("codesign", ["--remove-signature", executable]);
execFileSync(
  process.execPath,
  [
    join(root, "node_modules/postject/dist/cli.js"),
    executable,
    "NODE_SEA_BLOB",
    blob,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : []),
  ],
  { stdio: "inherit" },
);
if (process.platform === "darwin") signRemoteHost(executable);
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
await writeHostManifest(output, {
  version,
  platform: process.platform,
  arch: process.arch,
  source: checkoutRevision(root),
});
