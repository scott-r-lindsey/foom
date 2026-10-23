// Normal samples stay interactive. Captures always own a private virtual display.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== "--screenshots")) {
  throw new Error("Usage: pnpm run start:samples [--screenshots]");
}
const capture = args[0] === "--screenshots";
if (capture && process.platform !== "linux") {
  throw new Error("Product screenshots require Linux with xvfb-run installed.");
}
const child = spawn(
  capture ? "xvfb-run" : process.execPath,
  capture
    ? [
        "-a",
        "--server-args=-screen 0 1600x1000x24 -dpi 96",
        process.execPath,
        "--require",
        "./tests/helpers/setup.js",
        "--test",
        "tests/electron/product-shots.js",
      ]
    : [
        createRequire(import.meta.url).resolve("@electron-forge/cli/dist/electron-forge.js"),
        "start",
      ],
  {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdio: "inherit",
    env: { ...process.env, FOOM_ELECTRON_SHARD: "" },
  },
);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
