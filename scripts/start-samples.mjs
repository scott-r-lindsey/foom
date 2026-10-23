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
const cwd = fileURLToPath(new URL("../", import.meta.url));
if (capture) {
  const { runCapture } = await import("./capture-session.mjs");
  process.exitCode = await runCapture({ cwd });
} else {
  const child = spawn(
    process.execPath,
    [createRequire(import.meta.url).resolve("@electron-forge/cli/dist/electron-forge.js"), "start"],
    { cwd, stdio: "inherit" },
  );
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
