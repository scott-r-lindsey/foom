// Starts Foom with a brand-new profile, so preflight runs as it would on first launch.
// The profile lives in a temporary folder and is deleted when Foom quits. Your real
// settings, repositories and keys are untouched. Pass --keep to keep the profile.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const electron = createRequire(import.meta.url)("electron");
const keep = process.argv.includes("--keep");
const profile = await mkdtemp(join(tmpdir(), "foom-fresh-"));
console.log(`Fresh profile: ${profile}${keep ? " (kept)" : ""}`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [root, `--user-data-dir=${profile}`], { stdio: "inherit", env });
// Ctrl+C reaches Electron through this wrapper, which stays alive to clean up.
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    child.kill(signal);
  });
child.on("exit", async (code) => {
  if (!keep) await rm(profile, { recursive: true, force: true });
  process.exit(code ?? 1);
});
