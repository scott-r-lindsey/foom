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

async function checkCollapsedDisclosure(board, dialog, operation, captureScreenshots = true) {
  const details = dialog.locator("details");
  const summaries = details.locator("summary");
  const files = details.last();
  await expect(details).toHaveCount(4);
  await expect(summaries.nth(0)).toContainText("Executable and fixed arguments");
  await expect(summaries.nth(1)).toContainText(
    /agy · ~\/\.gemini\/config\/plugins\/foom · (not-installed|outdated|disabled)/u,
  );
  await expect(summaries.nth(2)).toContainText("Status and ownership checks");
  await expect(summaries.last()).toContainText(/files · \d+ bytes/u);
  const fileLines = files.locator(".disclosure-summary[title]");
  for (const line of await fileLines.all()) {
    await expect(line).toHaveText(/^[^\n]+ · [a-f0-9]{12} · \d+ B$/u);
    await expect(line).toHaveAttribute("title", /SHA-256 [a-f0-9]{64}/u);
    await expect
      .poll(() => line.evaluate((node) => getComputedStyle(node).whiteSpace))
      .toBe("nowrap");
  }
  const command = details.first().locator(".disclosure-summary");
  const executable = await details.first().locator("code").first().textContent();
  expect(await command.getAttribute("title")).toContain(`${executable} plugin `);
  await expect(details.first().locator("summary")).toHaveAccessibleName(
    new RegExp(executable.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")),
  );
  await expect(command).toHaveText(/^agy plugin .*….*$/u);
  await expect(details.locator("code").first()).toBeHidden();
  await expect
    .poll(() => details.evaluateAll((nodes) => nodes.every((node) => !node.open)))
    .toBe(true);
  const accept = dialog.getByRole("button", {
    name:
      operation === "reinstall"
        ? "Reinstall plugin"
        : operation === "update"
          ? "Update"
          : "Install",
    exact: true,
  });
  const visibleFooter = async () => {
    await expect(accept).toBeVisible();
    await expect
      .poll(() =>
        accept.evaluate((button) => {
          const bounds = button.getBoundingClientRect();
          return (
            bounds.top >= 0 && bounds.bottom <= window.innerHeight && window.innerHeight <= 800
          );
        }),
      )
      .toBe(true);
  };
  await visibleFooter();
  // The decision preamble is visible without opening any of the four sections.
  for (const preamble of [
    dialog.locator(".prose").first(),
    dialog.getByText(/CLI-owned opt-in Foom lifecycle plugin/u),
  ]) {
    await expect
      .poll(() =>
        preamble.evaluate((node) => {
          const bounds = node.getBoundingClientRect();
          return bounds.top >= 0 && bounds.bottom <= window.innerHeight;
        }),
      )
      .toBe(true);
  }
  await dialog.getByRole("button", { name: "Cancel" }).focus();
  await dialog.keyboard.press("Tab");
  await expect(accept).toBeFocused();
  await dialog.keyboard.press("Tab");
  const content = dialog.getByRole("region", { name: "Details" });
  if (await content.evaluate((element) => element === document.activeElement))
    await dialog.keyboard.press("Tab");
  for (let index = 0; index < 4; index++) {
    const section = details.nth(index);
    const summary = summaries.nth(index);
    await expect(summary).toBeFocused();
    const key = index % 2 === 0 ? "Enter" : "Space";
    await dialog.keyboard.press(key);
    await expect(section).toHaveAttribute("open", "");
    await visibleFooter();
    if (index === 1)
      await expect(
        section.getByText("~/.gemini/config/plugins/foom", { exact: true }),
      ).toBeVisible();
    if (index !== 1) {
      await dialog.keyboard.press("Tab");
      await expect(section.locator("code").first()).toBeFocused();
      await dialog.keyboard.press("Shift+Tab");
      await expect(summary).toBeFocused();
    }
    if (index === 3) {
      const title = await fileLines.first().getAttribute("title");
      const hash = title?.match(/[a-f0-9]{64}/u)?.[0];
      if (!hash) throw Error("Missing full SHA-256");
      await expect(summary).toHaveAccessibleName(new RegExp(hash));
      const selected = await files
        .locator("code")
        .first()
        .evaluate((node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          return selection.toString();
        });
      expect(selected).toContain(hash);
      await expect
        .poll(() =>
          files
            .locator("code")
            .evaluateAll(
              (boxes) =>
                boxes.every((box) => box.clientHeight <= 160) &&
                boxes.some((box) => box.scrollHeight > box.clientHeight),
            ),
        )
        .toBe(true);
      await assertAccessible(dialog);
    }
    await dialog.keyboard.press(key);
    await expect(section).not.toHaveAttribute("open", "");
    if (index < 3) await dialog.keyboard.press("Tab");
  }
  if (captureScreenshots && process.env.FOOM_AGY_SCREENSHOTS) {
    await mkdir(process.env.FOOM_AGY_SCREENSHOTS, { recursive: true });
    for (const mode of ["light", "dark"]) {
      await board.evaluate(
        (interfaceTheme) => window.desktop.saveSetup({ interfaceTheme }),
        `eclipse-${mode}`,
      );
      await expect
        .poll(() => dialog.evaluate(() => document.documentElement.style.colorScheme))
        .toBe(mode);
      for (const state of ["collapsed", "expanded"]) {
        if (state === "expanded") {
          for (const summary of await summaries.all()) await summary.click();
          await expect
            .poll(() => details.evaluateAll((nodes) => nodes.every((node) => node.open)))
            .toBe(true);
        }
        await dialog.locator(".confirmation-content").evaluate((content) => {
          content.scrollTop = 0;
        });
        await visibleFooter();
        await dialog.screenshot({
          path: path.join(
            process.env.FOOM_AGY_SCREENSHOTS,
            `${operation}-${mode}-${state}-overview.png`,
          ),
        });
        if (state === "expanded")
          await details.last().locator("code").first().scrollIntoViewIfNeeded();
        else await details.locator("summary").last().scrollIntoViewIfNeeded();
        await dialog.screenshot({
          path: path.join(process.env.FOOM_AGY_SCREENSHOTS, `${operation}-${mode}-${state}.png`),
        });
        if (state === "expanded") {
          for (const summary of await summaries.all()) await summary.click();
          await expect
            .poll(() => details.evaluateAll((nodes) => nodes.every((node) => !node.open)))
            .toBe(true);
        }
      }
    }
    if (operation === "install" && process.platform === "linux") {
      await content.evaluate((node) => {
        node.scrollTop = 0;
      });
      await dialog.screenshot({
        path: path.join(process.env.FOOM_AGY_SCREENSHOTS, "install-dark-collapsed-overview.png"),
      });
      require("node:child_process").execFileSync("import", [
        "-window",
        "root",
        path.join(process.env.FOOM_AGY_SCREENSHOTS, "install-1920x1080-accept-visible.png"),
      ]);
    }
  }
  await dialog.getByRole("button", { name: "Cancel" }).focus();
}

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
    const entries = fs.existsSync(directory) ? [{name:'foom', path:directory, enabled: !JSON.parse(fs.readFileSync(path.join(directory, 'plugin.json'))).disabled, hooks:['foom-observer-v1']}] : [];
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
    if (!firstRun && process.env.FOOM_AGY_SCREENSHOTS) {
      await app.evaluate(({ BrowserWindow }) => {
        const board = BrowserWindow.getAllWindows().find(
          (window) => window.webContents.getURL() === "app://bundle/index.html",
        );
        if (!board) throw Error("Missing board");
        board.setBounds({ x: 0, y: 0, width: 1920, height: 1080 });
      });
    }
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
    await checkCollapsedDisclosure(page, disclosure, "install", !firstRun);
    await expect(disclosure.locator("details").nth(1).locator("summary")).toContainText(
      "agy · ~/.gemini/config/plugins/foom · not-installed",
    );
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
      await expect(
        disclosure.getByRole("heading", { name: "Reinstall Antigravity plugin?", exact: true }),
      ).toBeVisible();
      await expect(disclosure.getByText(/Reinstall first uninstalls/u)).toBeVisible();
      await checkCollapsedDisclosure(page, disclosure, "reinstall");
      await capture("reinstall-pending", disclosure);
      await disclosure.getByRole("button", { name: "Reinstall plugin", exact: true }).click();
      await expect(agyRow.getByText("Plugin · installed", { exact: true })).toBeVisible();
      await rm(path.join(home, ".gemini/config/plugins/foom/observer.sh"));
      await scan();
      await expect(agyRow.getByText("Plugin · outdated", { exact: true })).toBeVisible();
      await capture("missing-observer-update");
      await agyRow.getByRole("button", { name: "Update", exact: true }).click();
      disclosure = await confirmationPage(app);
      await checkCollapsedDisclosure(page, disclosure, "update");
      await disclosure.getByRole("button", { name: "Update", exact: true }).click();
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
    const profile = await app.evaluate(({ app }) => app.getPath("userData"));
    await rm(path.join(profile, "agent-plugins"), { recursive: true, force: true });
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (await window.desktop.scanAgents(true)).agents.find((agent) => agent.id === "agy")
              ?.setup?.state,
        ),
      )
      .toBe("installed");
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
