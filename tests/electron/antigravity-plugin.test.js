const { gitSync: isolatedGit } = require("../helpers/git.js");
const { test } = require("./test-shard.js");
const path = require("node:path");
const { mkdir, mkdtemp, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { deadline, expect } = require("./test-policy.js");
const {
  assertAccessible,
  boardPage,
  confirmationPage,
  launchApp,
  openSettingsScreen,
  removeAfterApps,
} = require("./harness.js");

for (const firstRun of [false, true]) {
  test(`Antigravity plugin ${firstRun ? "first run" : "Settings"} disclosure installs and removes an observer that reports lifecycle`, {
    timeout: deadline(60_000),
    skip:
      process.platform === "win32" &&
      "Fake CLI is POSIX; Windows cmd/PowerShell observer runs in native unit integration",
  }, async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), "foom-agy-plugin-"));
    removeAfterApps(context, root);
    const bin = path.join(root, "bin");
    const home = path.join(root, "home");
    const repo = path.join(root, "repository");
    await Promise.all([bin, home, repo].map((directory) => mkdir(directory)));
    const fake = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const {execFile} = require('node:child_process');
const args = process.argv.slice(2);
const directory = path.join(require('node:os').homedir(), '.gemini/config/plugins/foom');
if (args[0] === '--version') { console.log('1.3.1'); process.exit(0); }
if (args[0] === '--help') { console.log('Antigravity CLI'); process.exit(0); }
if (args[0] === 'plugin') {
  if (args[1] === 'list') console.log(JSON.stringify({imports: fs.existsSync(directory) ? [{name:'foom'}] : []}));
  else if (args[1] === 'install') { fs.mkdirSync(path.dirname(directory), {recursive:true}); fs.cpSync(args[2], directory, {recursive:true}); }
  else if (args[1] === 'uninstall' && args[2] === 'foom') fs.rmSync(directory, {recursive:true, force:true});
  else process.exit(2);
  process.exit(0);
}
const spec = JSON.parse(fs.readFileSync(path.join(directory,'hooks.json'),'utf8'))['foom-observer-v1'];
process.stdin.setRawMode(true);
process.stdin.resume();
console.log('AGY_READY');
process.stdin.on('data', (data) => {
  const key = data.toString();
  if (key === 'q') process.exit(0);
  const event = key === 'w' ? 'PreInvocation' : 'Stop';
  const child = execFile('sh', ['-c', spec[event][0].command], {cwd:directory}, (error, stdout, stderr) => {
    if (error || stdout.trim() !== '{}' || stderr) process.exit(4);
    console.log('OBSERVER_RETURNED_' + event);
  });
  child.stdin.end(JSON.stringify({conversationId:'fake-agy-session', terminationReason:key === 'f' ? 'error' : 'NO_TOOL_CALL', fullyIdle:true, transcriptPath:'/must-not-read'}));
});
`;
    await writeFile(path.join(bin, "agy"), fake, { mode: 0o755 });
    isolatedGit(["init", "-q", "-b", "main"], { cwd: repo });
    isolatedGit(
      [
        "-c",
        "user.name=Foom",
        "-c",
        "user.email=foom@example.com",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "init",
      ],
      { cwd: repo },
    );
    const app = await launchApp(context, {
      fixture: firstRun ? "first-run" : "agent",
      env: { HOME: home, PATH: bin },
    });
    const page = await boardPage(app);
    if (firstRun) await page.getByRole("button", { name: "Start preflight" }).click();
    else {
      await openSettingsScreen(page);
      await page.getByRole("button", { name: "Agents", exact: true }).click();
      await expect(page.getByText("Plugin available", { exact: true })).toBeVisible();
    }
    const agyRow = page
      .locator(".agent-card")
      .filter({ has: page.getByText("Antigravity", { exact: true }) });
    await expect(agyRow.getByRole("button", { name: "Screen rules", exact: true })).toBeVisible();
    await expect(agyRow.getByText("Screen rules active", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Install", exact: true }).click();
    let disclosure = await confirmationPage(app);
    await expect(
      disclosure.getByText("~/.gemini/config/plugins/foom", { exact: true }),
    ).toBeVisible();
    await expect(
      disclosure.getByText(
        /observes only Foom launches, approves no tools, stores no credentials/u,
      ),
    ).toBeVisible();
    await expect(disclosure.getByText(/agy plugin uninstall foom/u)).toBeVisible();
    await disclosure.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("Plugin available", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Install", exact: true })).toBeEnabled();
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (await window.desktop.scanAgents(true)).agents.find((agent) => agent.id === "agy")
              ?.setup?.offer === undefined,
        ),
      )
      .toBe(true);
    await page.getByRole("button", { name: "Install", exact: true }).click();
    disclosure = await confirmationPage(app);
    await disclosure.getByRole("button", { name: "Install", exact: true }).click();
    await expect(page.getByText("Plugin · installed", { exact: true })).toBeVisible();
    await expect(agyRow.getByRole("button", { name: "Hooks", exact: true })).toBeVisible();
    await assertAccessible(page);
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    }, repo);
    const id = await page.evaluate(async () => {
      window.agyTransitions = [];
      window.desktop.onExecution((event) => window.agyTransitions.push(event));
      const repository = await window.desktop.addRepository();
      const tree = await window.desktop.createWorktree(repository.path, "feature/agy", "adjacent");
      const launch = await window.desktop.launchAgent({
        agent: "agy",
        repository: repository.path,
        worktree: tree.path,
        cols: 80,
        rows: 24,
      });
      return launch.id;
    });
    await expect
      .poll(() => page.evaluate((id) => window.desktop.tail(id, 10), id))
      .toContain("AGY_READY");
    await page.evaluate((id) => window.desktop.input(id, "w"), id);
    await expect.poll(() => page.evaluate(() => window.agyTransitions.at(-1)?.to)).toBe("working");
    await page.evaluate((id) => window.desktop.input(id, "s"), id);
    await expect.poll(() => page.evaluate(() => window.agyTransitions.at(-1)?.to)).toBe("idle");
    await expect
      .poll(() =>
        page.evaluate(
          async (id) =>
            (await window.desktop.workspace()).terminals.find((terminal) => terminal.id === id)
              ?.state?.state,
          id,
        ),
      )
      .toBe("done");
    // A later turn can lose its detached Working report. Its newer failed Stop
    // must still replace Done; sequence ordering already rejects old reports.
    await page.evaluate((id) => window.desktop.input(id, "f"), id);
    await expect
      .poll(() =>
        page.evaluate(
          async (id) =>
            (await window.desktop.workspace()).terminals.find((terminal) => terminal.id === id)
              ?.state?.state,
          id,
        ),
      )
      .toBe("failed");
    await page.evaluate((id) => window.desktop.input(id, "w"), id);
    await expect.poll(() => page.evaluate(() => window.agyTransitions.at(-1)?.to)).toBe("working");
    await page.evaluate((id) => window.desktop.input(id, "f"), id);
    await expect
      .poll(() =>
        page.evaluate(
          async (id) =>
            (await window.desktop.workspace()).terminals.find((terminal) => terminal.id === id)
              ?.state?.state,
          id,
        ),
      )
      .toBe("failed");
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    disclosure = await confirmationPage(app);
    await disclosure.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(page.getByRole("button", { name: "Install", exact: true })).toBeEnabled();
    await page.evaluate((id) => window.desktop.input(id, "q"), id);
    await expect
      .poll(() =>
        page.evaluate(
          async (id) =>
            (await window.desktop.workspace()).terminals.find((terminal) => terminal.id === id)
              ?.exited,
          id,
        ),
      )
      .toBe(true);
  });
}
