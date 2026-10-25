// Exercise production probe preparation as a foreground job, using only fixture shells/CLIs.
const assert = require("node:assert/strict");
const os = require("node:os");
const { readFileSync, writeFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const userInfo = os.userInfo;
os.userInfo = () => ({ ...userInfo(), shell: process.argv[3] });
const { probeEnvironment, probeProvider, prepareProbe, scratchRepository } = require(
  process.argv[2],
);
const root = process.env.HOME;
let environment;
exports.readLoginShell = async () => {
  environment = await probeEnvironment();
  assert.equal(environment.HOME, root);
  return { stdout: "fixture-value" };
};
exports.complete = async () => {
  const request = { action: "start", agent: "copilot-fixture", manifest: "draft.json" };
  const provider = await probeProvider(request, root);
  const cwd = await scratchRepository();
  try {
    const release = setInterval(() => {
      try {
        if (readFileSync(join(root, "metadata-ready"), "utf8").trim().split("\n").length >= 24) {
          writeFileSync(join(root, "metadata-release"), "");
          clearInterval(release);
        }
      } catch {
        /* Metadata readers have not started yet. */
      }
    }, 10);
    let prepared;
    try {
      prepared = await Promise.all(
        Array.from({ length: 24 }, () =>
          prepareProbe(provider, request, cwd, { ...environment, PATH: root }),
        ),
      );
    } finally {
      clearInterval(release);
    }
    const { spec } = prepared[0];
    const pty = require(process.env.FIXTURE_PTY);
    const terminal = pty.spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Fixture screen missing")), 3000);
        terminal.onData((data) => {
          if (data.includes("FIXTURE_CLI_SCREEN")) {
            clearTimeout(timer);
            console.log("FIXTURE_CLI_SCREEN");
            terminal.write("done\r");
          }
        });
        terminal.onExit(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    } finally {
      terminal.kill("SIGKILL");
      await Promise.all(prepared.map((launch) => launch.dispose()));
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
};
