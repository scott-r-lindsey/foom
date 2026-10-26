const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, mkdtemp, writeFile, readFile, chmod } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { gitSync } = require("../helpers/git.js");
const { expect } = require("./test-policy.js");
const { boardPage, launchApp, removeAfterApps, stopSession } = require("./harness.js");

test("Pi static-title spinner publishes Working during continuous redraws and resumes its assigned session", {
  skip: process.platform === "win32" && "The fake CLI is a POSIX executable",
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-pi-agent-"));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await Promise.all([bin, repo, home].map((directory) => mkdir(directory)));
  const record = path.join(root, "argv.json");
  const executable = path.join(bin, process.platform === "win32" ? "pi.exe" : "pi");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("1.4.0"); process.exit(0); }
if (args[0] === "--help") { console.log("--session --session-id"); process.exit(0); }
require("node:fs").writeFileSync(process.env.PI_FIXTURE_ARGV, JSON.stringify(args));
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('\\x1b]2;π - fixture\\x07');
const footer = '\\n────────────────\\nfixture\\n0.5%/272k (auto)  fixture-model';
const draw = () => process.stdout.write('\\x1b[2J\\x1b[H── ⠋ Working ─────' + footer);
let timer = setInterval(draw, 100);
draw();
process.stdin.on('data', data => {
  clearInterval(timer);
  if (data.toString().includes('i')) process.stdout.write('\\x1b[2J\\x1b[Hready\\n────────────────' + footer);
  if (data.toString().includes('b')) process.stdout.write('\\x1b[2J\\x1b[HOnly showing models from configured providers.\\nModel Name: Fixture');
  if (data.toString().includes('w')) { timer = setInterval(draw, 100); draw(); }
});
process.stdout.write('\\nSESSION_ARGS:' + JSON.stringify(args));
`,
  );
  await chmod(executable, 0o755);
  gitSync(["init", "-q", "-b", "main"], { cwd: repo });
  gitSync(
    [
      "-c",
      "user.name=Foom",
      "-c",
      "user.email=foom@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "init",
    ],
    { cwd: repo },
  );
  const app = await launchApp(context, {
    fixture: "agent",
    home,
    env: { HOME: home, PATH: bin, PI_FIXTURE_ARGV: record },
  });
  const page = await boardPage(app);
  await app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
  }, repo);
  const repository = await page.evaluate(() => window.desktop.addRepository());
  assert.ok(repository);
  const launched = await page.evaluate(
    (repository) =>
      window.desktop.launchAgent({
        agent: "pi",
        repository,
        worktree: repository,
        cols: 80,
        rows: 24,
      }),
    repository.path,
  );
  const row = page.locator('.board-row[data-kind="agent"]');
  await expect(row).toHaveAttribute("data-state", "working");
  const original = (await page.evaluate(() => window.desktop.workspace())).terminals.find(
    (entry) => entry.id === launched.id,
  );
  assert.match(original.conversationId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(JSON.parse(await readFile(record, "utf8")), [
    "--session-id",
    original.conversationId,
  ]);
  await page.evaluate((id) => window.desktop.input(id, "i"), launched.id);
  await expect(row).toHaveAttribute("data-state", "done");
  await page.evaluate((id) => window.desktop.input(id, "b"), launched.id);
  await expect(row).toHaveAttribute("data-state", "needs_input");
  await expect(row).toContainText("Model selection requested");
  await page.evaluate((id) => window.desktop.input(id, "w"), launched.id);
  await expect(row).toHaveAttribute("data-state", "working");
  await stopSession(page, launched.id);
  await page.evaluate((id) => window.desktop.sidebarCommand({ kind: "resume", id }), launched.id);
  await expect(row).toHaveAttribute("data-state", "working");
  const resumed = (await page.evaluate(() => window.desktop.workspace())).terminals.find(
    (entry) => entry.id === launched.id,
  );
  assert.equal(resumed.conversationId, original.conversationId);
  await expect
    .poll(async () => JSON.parse(await readFile(record, "utf8")))
    .toEqual(["--session", original.conversationId]);
  await stopSession(page, launched.id);
});
