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
module.exports = { assertCliPairing };
