const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { spawn } = require("node:child_process");
const { deadline, expect } = require("./test-policy.js");

async function assertCliPairing(context, executable, profile, repository, confirmation) {
  // Control startup publishes discovery only after native ownership checks finish.
  await expect.poll(() => existsSync(join(profile, "control", "discovery.json"))).toBe(true);
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.toUpperCase().startsWith("FOOM_") || key === "NODE_OPTIONS") delete env[key];
  let child;
  let finished;
  context.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await finished;
  });
  child = spawn(executable, ["pair", "--profile", profile, "--repository", repository, "--json"], {
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  finished = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      resolve(code);
    });
  });
  await expect
    .poll(() => stderr, { timeout: deadline(10000) })
    .toMatch(/Pairing code: [A-F0-9]{8}/);
  const code = /Pairing code: ([A-F0-9]{8})/.exec(stderr)[1];
  await expect(
    confirmation.getByRole("heading", { name: "Pair this CLI with Foom?" }),
  ).toBeVisible();
  await expect(confirmation.getByText(new RegExp(`Check that code ${code}`))).toBeVisible();
  await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await confirmation.getByRole("button", { name: "Grant read-only access for 10 minutes" }).click();
  await expect.poll(() => stdout).toContain('"ready":true');
  child.stdin.write('["whoami"]\n["sessions"]\n');
  await expect.poll(() => stdout.split("\n").filter(Boolean).length).toBe(3);
  const records = stdout.trim().split("\n").map(JSON.parse);
  assert.equal(records[1].result.role, "cli");
  assert.deepEqual(records[1].result.capabilities, ["whoami", "sessions", "session_state"]);
  assert.ok(Array.isArray(records[2].result.sessions));
  assert.ok(!stdout.includes('"token"'));
  child.stdin.end('["operation-status","--operation-id","foreign"]\n');
  assert.equal(await finished, 3);
  assert.ok(stderr.includes('"error":"forbidden"'));
}
function assertConfigValidation(executable, scratch) {
  const { writeFileSync, mkdirSync } = require("node:fs");
  const { spawnSync } = require("node:child_process");
  const directory = join(scratch, "config-validation");
  mkdirSync(directory, { recursive: true });
  const valid = join(directory, "valid.json");
  const broken = join(directory, "broken.json");
  writeFileSync(valid, '{"kind":"settings","terminalFontSize":16}');
  writeFileSync(broken, '{"kind":"settings","agentArguments":{}}');
  const env = { ...process.env, FOOM_CONTROL_URL: "invalid", FOOM_CONTROL_TOKEN: "must-not-use" };
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  for (const json of [false, true]) {
    for (const [file, code] of [
      [valid, 0],
      [broken, 1],
    ]) {
      const result = spawnSync(
        executable,
        ["config", "validate", file, ...(json ? ["--json"] : [])],
        {
          env,
          encoding: "utf8",
          timeout: deadline(10000),
          windowsHide: true,
        },
      );
      assert.equal(result.status, code, result.stderr);
      assert.equal(result.stderr, "");
      if (json)
        assert.deepEqual(
          JSON.parse(result.stdout),
          code ? [{ file: "broken.json", path: "$.agentArguments", reason: "unknown-key" }] : [],
        );
      else if (code) assert.match(result.stdout, /broken.json.*\$\.agentArguments.*unknown-key/);
    }
  }
  return { valid, broken };
}
module.exports = { assertCliPairing, assertConfigValidation };
