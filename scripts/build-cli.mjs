import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "build", "console");
const temporary = join(root, "build", "sea");
if (process.versions.node.split(".")[0] !== "24") throw new Error("Build the CLI with Node 24");
await mkdir(output, { recursive: true });
await mkdir(temporary, { recursive: true });
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const bundle = join(temporary, "cli.cjs");
await build({
  entryPoints: [join(root, "src/cli/main.ts")],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  define: { FOOM_VERSION: JSON.stringify(version) },
  outfile: bundle,
});
const blob = join(temporary, "cli.blob");
const config = join(temporary, "sea.json");
await writeFile(
  config,
  JSON.stringify({
    main: bundle,
    output: blob,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    execArgvExtension: "none",
  }),
);
execFileSync(process.execPath, ["--experimental-sea-config", config], { stdio: "inherit" });
const executable = join(output, process.platform === "win32" ? "foom.exe" : "foom");
await copyFile(process.execPath, executable);
await chmod(executable, 0o755);
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
if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", executable]);
// Ship the actual build runtime's notices, including its embedded dependencies.
const runtimeRoot =
  process.platform === "win32" ? dirname(process.execPath) : dirname(dirname(process.execPath));
await copyFile(join(runtimeRoot, "LICENSE"), join(output, "NODE-LICENSE.txt"));
await writeFile(
  join(output, "manifest.json"),
  JSON.stringify({
    version,
    protocol: 1,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    sha256: createHash("sha256")
      .update(await readFile(executable))
      .digest("hex"),
  }),
);
