const { execFileSync } = require("node:child_process");
const { chmod, copyFile, mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");

/** Fixed test-owned source embedded in Node; discovery never reaches a real agent CLI. */
async function fixtureSea(root, executable, source) {
  const stage = path.join(root, "sea");
  await mkdir(stage);
  const main = path.join(stage, "main.cjs");
  const blob = path.join(stage, "main.blob");
  const config = path.join(stage, "sea.json");
  await writeFile(main, source);
  await writeFile(
    config,
    JSON.stringify({
      main,
      output: blob,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
      execArgvExtension: "none",
    }),
  );
  await copyFile(process.execPath, executable);
  await chmod(executable, 0o755);
  execFileSync(process.execPath, ["--experimental-sea-config", config], { stdio: "pipe" });
  if (process.platform === "darwin") execFileSync("codesign", ["--remove-signature", executable]);
  execFileSync(
    process.execPath,
    [
      path.join(__dirname, "../../node_modules/postject/dist/cli.js"),
      executable,
      "NODE_SEA_BLOB",
      blob,
      "--sentinel-fuse",
      "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
      ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : []),
    ],
    { stdio: "pipe" },
  );
  if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", executable]);
}
module.exports = { fixtureSea };
