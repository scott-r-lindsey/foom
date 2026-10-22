const { gitSync: isolatedGit } = require("../helpers/git.js");
const { test } = require("./test-shard.js");
const path = require("node:path");
const { mkdir, mkdtemp, writeFile, rm, access } = require("node:fs/promises");
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
if (args[0] === '--version') { console.log('${firstRun ? "1.3.1" : "1.4.2"}'); process.exit(0); }
if (args[0] === '--help') { console.log('Antigravity CLI'); process.exit(0); }
if (args[0] === 'plugin') {
  if (args[1] === 'list') {
    if (${firstRun} && args[2] === '--json') process.exit(2);
    if (fs.existsSync(path.join(path.dirname(directory), 'malformed'))) { console.log('bad-json'); process.exit(0); }
    const entries = fs.existsSync(directory) ? [{name:'foom', enabled: !JSON.parse(fs.readFileSync(path.join(directory, 'plugin.json'))).disabled, hooks:['foom-observer-v1']}] : [];
    console.log(${firstRun} ? entries.length ? JSON.stringify({imports: entries}) : 'No imported plugins.' : JSON.stringify(entries));
  }
  else if (args[1] === 'install') { fs.mkdirSync(path.dirname(directory), {recursive:true}); fs.cpSync(args[2], directory, {recursive:true}); }
  else if (args[1] === 'enable') { const file = path.join(directory,'plugin.json'); const metadata = JSON.parse(fs.readFileSync(file)); metadata.disabled = false; fs.writeFileSync(file, JSON.stringify(metadata)); }
  else if (args[1] === 'uninstall' && args[2] === 'foom') fs.rmSync(directory, {recursive:true, force:true});
  else process.exit(2);
  process.exit(0);
}
fs.writeFileSync(path.join(process.cwd(), 'observer.sh'), 'echo POISONED > planted-marker');
fs.mkdirSync(path.join(process.cwd(), 'observers/lifecycle'), {recursive:true});
fs.writeFileSync(path.join(process.cwd(), 'observers/lifecycle/observer.sh'), 'echo POISONED > planted-marker');
const spec = JSON.parse(fs.readFileSync(path.join(directory,'hooks.json'),'utf8'))['foom-observer-v1'];
process.stdin.setRawMode(true);
process.stdin.resume();
console.log('AGY_READY');
process.stdin.on('data', (data) => {
  const key = data.toString();
  if (key === 'q') process.exit(0);
  const event = key === 'w' ? 'PreInvocation' : 'Stop';
  const child = execFile('sh', ['-c', spec[event][0].command], {cwd:process.cwd()}, (error, stdout, stderr) => {
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
    if (!firstRun) {
      const capture = async (name, target = page) => {
        if (!process.env.FOOM_AGY_SCREENSHOTS) return;
        await mkdir(process.env.FOOM_AGY_SCREENSHOTS, { recursive: true });
        await target.screenshot({
          path: path.join(process.env.FOOM_AGY_SCREENSHOTS, `${name}.png`),
        });
      };
      await expect(
        agyRow.getByRole("button", { name: "Reinstall plugin", exact: true }),
      ).toBeVisible();
      await capture("installed-reinstall");
      const metadataFile = path.join(home, ".gemini/config/plugins/foom/plugin.json");
      const scan = async () =>
        page.getByRole("button", { name: "Scan again", exact: true }).click();
      await writeFile(metadataFile, JSON.stringify({ name: "foom", foomObserverVersion: 1 }));
      await scan();
      await expect(agyRow.getByText("Plugin · outdated", { exact: true })).toBeVisible();
      await capture("outdated-reinstall");
      await writeFile(
        metadataFile,
        JSON.stringify({ name: "foom", foomObserverVersion: 1, disabled: true }),
      );
      await scan();
      await expect(agyRow.getByText("Plugin · disabled", { exact: true })).toBeVisible();
      await expect(agyRow.getByRole("button", { name: "Enable", exact: true })).toBeVisible();
      await capture("disabled-reinstall");
      await agyRow.getByRole("button", { name: "Reinstall plugin", exact: true }).click();
      disclosure = await confirmationPage(app);
      await expect(disclosure.getByText(/Reinstall first uninstalls/u)).toBeVisible();
      await capture("reinstall-pending", disclosure);
      await disclosure.getByRole("button", { name: "Reinstall plugin", exact: true }).click();
      await expect(agyRow.getByText("Plugin · installed", { exact: true })).toBeVisible();
      const malformed = path.join(home, ".gemini/config/plugins/malformed");
      await writeFile(malformed, "");
      await scan();
      await expect(agyRow.getByText("Plugin · Status unavailable", { exact: true })).toBeVisible();
      await expect(
        agyRow.getByRole("button", { name: "Reinstall plugin", exact: true }),
      ).toHaveCount(0);
      await capture("unavailable-retry");
      await rm(malformed);
      await agyRow.getByRole("button", { name: "Retry status", exact: true }).click();
      await expect(agyRow.getByText("Plugin · installed", { exact: true })).toBeVisible();
    }
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
    const launched = await page.evaluate(
      async () =>
        (await window.desktop.workspace()).terminals.find((terminal) => terminal.agent === "agy")
          ?.worktree,
    );
    await expect(access(path.join(launched, "planted-marker"))).rejects.toThrow();
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
