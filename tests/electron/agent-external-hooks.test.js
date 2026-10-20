const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, mkdtemp, readFile, writeFile, copyFile, chmod } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { gitSync } = require("../helpers/git.js");
const { deadline, expect } = require("./test-policy.js");
const { boardPage, launchApp, removeAfterApps, stopSession, quitAndWait } = require("./harness.js");

test("a user-authored code extension reports external hooks through the CLI and resumes on close", {
  timeout: deadline(60000),
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-external-hooks-"));
  removeAfterApps(context, root);
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const repo = path.join(root, "repo");
  await Promise.all([home, bin, repo].map((directory) => mkdir(directory)));
  const executable = path.join(
    bin,
    process.platform === "win32" ? "foom-test-agent.exe" : "foom-test-agent",
  );
  await copyFile(process.execPath, executable);
  await chmod(executable, 0o755);
  const extension = path.join(root, "user-extension.js");
  const script = path.join(root, "agent.js");
  // User-owned code extension, outside the Foom manifest. No generated observer.
  await writeFile(
    extension,
    `let sequence = 0;
module.exports = (event) => {
  const result = require('node:child_process').spawnSync('foom', ['hook', event], {
    env: process.env, shell: false,
    input: JSON.stringify({conversationId:'external-conversation', id:'event-'+(++sequence)}),
    encoding:'utf8', timeout:5000,
  });
  if (result.status !== 0 || result.stdout || result.stderr) throw Error('Hook delivery failed');
};`,
  );
  await writeFile(
    script,
    `const report = require(${JSON.stringify(extension)});
require('node:fs').writeFileSync(${JSON.stringify(path.join(root, "launch.json"))}, JSON.stringify({args:process.argv.slice(2), tokenDigest:require('node:crypto').createHash('sha256').update(process.env.FOOM_TOKEN).digest('hex')}));
report('Ready');
process.stdin.on('data', (data) => {
  const command = data.toString().trim();
  if (command === 'work') report('Working');
  if (command === 'permission') report('Permission');
  if (command === 'done') { console.log('Task completed successfully.'); report('Stop'); }
});
console.log('Extension ready');`,
  );
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
  const options = {
    args: ["--user-data-dir=" + path.join(root, "profile")],
    env: { HOME: home, PATH: bin },
  };
  let app = await launchApp(context, { ...options, fixture: "agent" });
  let page = await boardPage(app);
  const manifest = JSON.parse(
    await readFile(path.join(__dirname, "../fixtures/agent-plugins-v2/external.json"), "utf8"),
  );
  manifest.launch.order = [
    "arguments",
    "resume",
    "defaults",
    "display",
    "guidance",
    "mcp",
    "hooks",
    "tools",
    "prompt",
  ];
  manifest.launch.arguments = { arguments: [script] };
  await writeFile(
    path.join(home, ".foom/config/agents/foom-test-agent.json"),
    JSON.stringify(manifest),
  );
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.desktop.scanAgents(true))).agents.some(
        (agent) => agent.id === "foom-test-agent" && agent.path,
      ),
    )
    .toBeTruthy();
  await app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
  }, repo);
  const repository = await page.evaluate(() => window.desktop.addRepository());
  assert.ok(repository);
  await page.evaluate(
    (repository) =>
      window.desktop.sidebarCommand({
        kind: "launch",
        repository,
        worktree: repository,
        run: "foom-test-agent",
      }),
    repository.path,
  );
  const terminal = async () =>
    (await page.evaluate(() => window.desktop.workspace())).terminals.find(
      (entry) => entry.agent === "foom-test-agent",
    );
  await expect.poll(async () => (await terminal())?.conversationId).toBe("external-conversation");
  const first = await terminal();
  const initial = JSON.parse(await readFile(path.join(root, "launch.json"), "utf8"));
  assert.deepEqual(initial.args, []);
  const send = (command) =>
    page.evaluate(({ id, command }) => window.desktop.input(id, command + "\r"), {
      id: first.id,
      command,
    });
  await send("work");
  await expect.poll(async () => (await terminal())?.execution?.phase).toBe("working");
  await send("permission");
  await expect.poll(async () => (await terminal())?.execution?.phase).toBe("blocked");
  await expect(page.locator('.board-row[data-kind="agent"]')).toHaveAttribute(
    "data-state",
    "needs_input",
  );
  await send("work");
  await expect.poll(async () => (await terminal())?.execution?.phase).toBe("working");
  await send("done");
  await expect.poll(async () => (await terminal())?.execution?.phase).toBe("idle");
  await expect(page.locator('.board-row[data-kind="agent"]')).toHaveAttribute("data-state", "done");
  await stopSession(page, first.id);
  await expect.poll(async () => (await terminal())?.exited).toBe(true);
  await quitAndWait(app, () => app.evaluate(({ app }) => app.quit()));
  app = await launchApp(context, { ...options, fixture: "restored" });
  page = await boardPage(app);
  await expect.poll(async () => (await terminal())?.dormant).toBe(true);
  await page.evaluate((id) => window.desktop.sidebarCommand({ kind: "resume", id }), first.id);
  await expect.poll(async () => (await terminal())?.exited).toBe(false);
  await expect
    .poll(async () => JSON.parse(await readFile(path.join(root, "launch.json"), "utf8")).args)
    .toEqual(["--resume", "external-conversation"]);
  const resumed = JSON.parse(await readFile(path.join(root, "launch.json"), "utf8"));
  assert.notEqual(resumed.tokenDigest, initial.tokenDigest);
});
