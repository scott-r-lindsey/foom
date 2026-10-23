const { codexFixture } = require("./agent-fixture.js");
const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { realpath } = require("node:fs/promises");
const { deadline, expect } = require("./test-policy.js");
const { openSettingsScreen } = require("./harness.js");

test("agent hooks and titles publish execution transitions independently of terminal output", {
  timeout: deadline(30000),
  skip: process.platform === "win32" && "The fake CLI is a POSIX executable",
}, async (context) => {
  const { page, repository, repo } = await codexFixture(context, {
    helpText: "--no-alt-screen -c, --config <value>",
    source: ({ help }) => `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === '--version') console.log('codex-cli 0.159.3');
else if (process.argv[2] === '--help') console.log(fs.readFileSync(${JSON.stringify(help)}, 'utf8'));
else {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write('\\x1b]2;⠋ codex\\x07');
  process.stdin.on('data', data => {
    if (data.toString().includes('w')) process.stdout.write('\\x1b[2J\\x1b[H\\x1b]2;⠙ codex\\x07');
    if (data.toString().includes('n')) {
      const command = JSON.parse(process.argv.find(arg => arg.startsWith('notify=')).slice(7));
      require('node:child_process').spawnSync(command[0], [...command.slice(1), JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'fake-thread', 'turn-id': 'fake-turn' })]);
      process.stdout.write('NOTIFIED\\n');
    }
    if (data.toString().includes('a')) process.stdout.write('\\x1b]2;Action Required | codex\\x07');
    if (data.toString().includes('i')) process.stdout.write('\\x1b[2J\\x1b[HWhich file should I edit?\\x1b]2;codex\\x07');
  });
}
`,
  });
  assert.equal(repository.path, await realpath(repo));
  await expect(page.getByRole("treeitem", { name: "repo", exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.executionEvents = [];
    window.desktop.onExecution((event) => window.executionEvents.push(event));
  });
  const id = await page.evaluate(async (repo) => {
    await window.desktop.scanAgents(true);
    const tree = await window.desktop.createWorktree(repo, "titles", "adjacent");
    return (
      await window.desktop.launchAgent({
        agent: "codex",
        repository: repo,
        worktree: tree.path,
        cols: 80,
        rows: 24,
      })
    ).id;
  }, repository.path);
  const row = page.locator('.board-row[data-kind="agent"]');
  await expect(row).toHaveAttribute("data-state", "working");
  await expect(row).toContainText("rules:codex:osc_title_working");
  await page.evaluate((id) => window.desktop.input(id, "a"), id);
  await expect(row).toHaveAttribute("data-state", "needs_input");
  await expect(row).toContainText("Approval requested");
  await expect(row).toContainText("rules:codex:osc_title_blocked");
  await page.evaluate((id) => window.desktop.input(id, "i"), id);
  await expect(row).toHaveAttribute("data-state", "needs_input");
  await expect(row).toContainText("Agent asks a question");
  await expect(row).toContainText("pattern:question");
  await page.evaluate((id) => window.desktop.input(id, "w"), id);
  await expect(row).toHaveAttribute("data-state", "working");
  await page.evaluate((id) => window.desktop.input(id, "n"), id);
  await expect(row).toHaveAttribute("data-state", "done");
  const events = await page.evaluate(() => window.executionEvents);
  assert.deepEqual(
    events.map((event) => event.to),
    ["working", "blocked", "idle", "blocked", "working", "idle"],
  );
  assert.equal(events.at(-1).source, "hook");
  assert.equal(events.at(-1).turn, 2);
  assert.ok(
    events.every((event) => event.terminalId === id && !("tail" in event) && !("prompt" in event)),
  );
});

test("stable Codex observers drive execution and retire the notifier after a verified turn", {
  timeout: deadline(30000),
  skip:
    process.platform === "win32" &&
    "The fake CLI is a POSIX executable; native Windows observers have unit integration coverage",
}, async (context) => {
  const { page, repository } = await codexFixture(context, {
    prefix: "foom-codex-hooks-",
    source: () => `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 0.161.0'); process.exit(0); }
if (args[0] === '--help') { console.log('-c, --config <value> --no-alt-screen'); process.exit(0); }
const notify = args.find(arg => arg.startsWith('notify='));
const hooks = args.filter(arg => arg.startsWith('hooks.'));
if (hooks.length !== 6) throw new Error('Missing lifecycle hooks');
const emit = (event) => {
  const definition = hooks.find(arg => arg.startsWith('hooks.' + event + '='));
  const command = JSON.parse(definition.match(/command=("(?:[^"\\\\]|\\\\.)*")/)[1]);
  const payload = { session_id: 'fake-conversation', hook_event_name: event, turn_id: 'turn', source: 'startup', tool_name: 'Bash', stop_hook_active: false, prompt: 'DISCARDED', transcript_path: '/never-read' };
  const result = spawnSync('sh', ['-c', command], { input: JSON.stringify(payload), encoding: 'utf8' });
  if (result.status !== 0 || result.stdout || result.stderr) throw new Error('Observer emitted output or failed');
};
console.log(notify ? 'NOTIFIER FALLBACK' : 'USER NOTIFIER PRESERVED');
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', data => {
  const key = data.toString();
  if (key === 's') emit('SessionStart');
  if (key === 'w') emit('UserPromptSubmit');
  if (key === 'b') emit('PermissionRequest');
  if (key === 'p') emit('PostToolUse');
  if (key === 'e') { console.log('Completed.'); emit('Stop'); }
  if (key === 'n') {
    const command = JSON.parse(notify.slice(7));
    spawnSync(command[0], [...command.slice(1), JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'fake-conversation', 'turn-id': 'fallback-turn' })]);
  }
  console.log('OBSERVED ' + key);
});
`,
  });
  const launch = (branch) =>
    page.evaluate(
      async ({ repository, branch }) => {
        await window.desktop.scanAgents(true);
        const tree = await window.desktop.createWorktree(repository, branch, "adjacent");
        return (
          await window.desktop.launchAgent({
            agent: "codex",
            repository,
            worktree: tree.path,
            cols: 80,
            rows: 24,
          })
        ).id;
      },
      { repository: repository.path, branch },
    );
  const id = await launch("first");
  const health = () =>
    page.evaluate(
      async () =>
        (await window.desktop.scanAgents(false)).agents.find((agent) => agent.id === "codex")
          .hookState,
    );
  const phase = () =>
    page.evaluate(
      async (id) =>
        (await window.desktop.workspace()).terminals.find((terminal) => terminal.id === id)
          .execution.phase,
      id,
    );
  const key = async (value) => {
    await page.evaluate(({ id, value }) => window.desktop.input(id, value), { id, value });
    await expect
      .poll(() => page.evaluate((id) => window.desktop.tail(id, 40), id))
      .toContain(`OBSERVED ${value}`);
  };
  await expect
    .poll(() => page.evaluate((id) => window.desktop.tail(id, 40), id))
    .toContain("NOTIFIER FALLBACK");
  await key("n");
  await expect.poll(health).toBe("declined");
  await key("s");
  await key("w");
  await expect.poll(phase).toBe("working");
  await key("b");
  await expect.poll(phase).toBe("blocked");
  await key("p");
  await expect.poll(phase).toBe("working");
  await key("e");
  await expect.poll(phase).toBe("idle");
  await expect
    .poll(() =>
      page.evaluate(
        async (id) =>
          (await window.desktop.workspace()).terminals.find((terminal) => terminal.id === id).state
            ?.state,
        id,
      ),
    )
    .toBe("done");
  await expect.poll(health).toBe("trusted");
  const later = await launch("later");
  await expect
    .poll(() => page.evaluate((id) => window.desktop.tail(id, 40), later))
    .toContain("USER NOTIFIER PRESERVED");
  await openSettingsScreen(page);
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Agents", exact: true })
    .click();
  await expect(page.getByText(/Trusted · observed working/)).toBeVisible();
  await page.screenshot({ path: path.join(__dirname, "../../test-results/codex-hook-setup.png") });
});
