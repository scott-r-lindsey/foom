const { evidencePath } = require("../helpers/evidence.js");
const { gitSync: isolatedGit } = require("../helpers/git.js");
const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, mkdtemp, readFile, realpath, rename, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { deadline, expect } = require("./test-policy.js");
const {
  boardPage,
  confirmationPage,
  launchApp,
  quitAndWait,
  removeAfterApps,
} = require("./harness.js");
const { pickPreviewFile } = require("./preview-fixture.js");
const { expectTileHeaderHitTargets } = require("./tile-fixture.js");

async function expectHeaderIndicators(tile, selectors) {
  const { missing, width } = await tile.locator(".tile-title").evaluate((header, selectors) => {
    const bounds = header.getBoundingClientRect();
    const fits = (indicator) => {
      const range = document.createRange();
      range.selectNodeContents(indicator);
      const rect =
        indicator.childElementCount === 0 && indicator.textContent
          ? range.getBoundingClientRect()
          : indicator.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.left >= bounds.left &&
        rect.right <= bounds.right &&
        rect.top >= bounds.top &&
        rect.bottom <= bounds.bottom &&
        indicator.contains(
          document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2),
        )
      );
    };
    return {
      width: bounds.width,
      missing: selectors.filter(
        (selector) => !Array.from(header.querySelectorAll(selector)).some(fits),
      ),
    };
  }, selectors);
  assert.deepEqual(missing, [], `Indicators clipped at a ${width}px header`);
}

async function sweepTileHeader(divider, tile, controls, indicators, menu, optionalControls = []) {
  await divider.press("Home");
  await expect(divider).toBeFocused();
  await expect(tile.locator(".tile-controls")).toHaveCSS("opacity", "1");
  // Occupied leaves span at most 15–85%, in five-point keyboard increments.
  for (let step = 0; step <= 14; step++) {
    const inline = await tile
      .locator(".tile-title button:visible")
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
    await expectTileHeaderHitTargets(
      tile,
      controls.filter((label) => inline.includes(label)),
    );
    expect(inline).toContain(controls[0]);
    await expectHeaderIndicators(tile, indicators);
    const overflow = controls
      .slice(1)
      .filter((label) => !inline.includes(label) && !optionalControls.includes(label));
    if (overflow.length) {
      assert.ok(menu, `Controls missing from the header: ${overflow.join(", ")}`);
      await tile.getByRole("button", { name: controls[0], exact: true }).click();
      for (const label of overflow) {
        const action =
          label === "Maximize tile"
            ? menu.getByRole("menuitem", { name: /^Maximize\b/ })
            : menu.getByRole("menuitem", { name: label, exact: true });
        await action.click({ trial: true });
      }
      await menu.press("Escape");
    }
    if (step < 14) await divider.press("ArrowRight");
  }
}

for (const agent of ["claude", "codex", "agy"]) {
  test(`resumes exited ${agent} conversations in place after a Foom restart`, {
    timeout: deadline(60_000),
    skip: process.platform === "win32" && "The fake CLI is a POSIX executable",
  }, async (context) => {
    const { chmod } = require("node:fs/promises");
    // Match the repository path in the preview picker's inventory on macOS.
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-resume-")));
    removeAfterApps(context, root);
    const bin = path.join(root, "bin");
    const repo = path.join(root, "repo");
    const home = path.join(root, "home");
    const profile = path.join(root, "profile");
    const argvFile = path.join(root, "argv.json");
    await Promise.all([mkdir(bin), mkdir(repo), mkdir(home)]);
    isolatedGit(["init", "-q", "-b", "main", repo]);
    isolatedGit([
      "-C",
      repo,
      "-c",
      "user.name=Foom",
      "-c",
      "user.email=foom@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "init",
    ]);
    if (agent === "agy") {
      const plugin = path.join(home, ".gemini/config/plugins/foom");
      await mkdir(plugin, { recursive: true });
      await writeFile(
        path.join(plugin, "plugin.json"),
        JSON.stringify({ name: "foom", foomObserverVersion: 2 }),
      );
    }
    const conversation = "0199abcd-1234-7890-abcd-123456789abc";
    await writeFile(
      path.join(bin, agent),
      `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync, renameSync } = require("node:fs");
const args = process.argv.slice(2);
const agent = ${JSON.stringify(agent)};
if (args[0] === "--version") { console.log(agent === "claude" ? "2.1.300 (Claude Code)" : agent === "codex" ? "codex-cli 0.160.1" : "1.3.3"); process.exit(0); }
if (args[0] === "--help") { console.log("--settings <json> -c, --config <value> --no-alt-screen"); process.exit(0); }
if (args[0] === "plugin" && args[1] === "list") { console.log(JSON.stringify({ imports: [{ name: "foom" }] })); process.exit(0); }
const record = process.env.TEST_ARGV + "." + process.pid + ".tmp";
writeFileSync(record, JSON.stringify({ args, cwd: process.cwd(), token: process.env.FOOM_TOKEN, pid: process.pid }));
renameSync(record, process.env.TEST_ARGV);
const resumed = args.includes("--resume") || args.includes("resume") || args.includes("--conversation");
if (resumed) {
  console.log("RESUMED_CONVERSATION " + process.pid);
  process.stdin.setRawMode(true);
  process.stdin.on("data", () => process.exit(0));
} else if (agent === "agy") {
  const payload = JSON.stringify({ conversationId: ${JSON.stringify(conversation)}, fullyIdle: true, terminationReason: "NO_TOOL_CALL", transcriptPath: "/must/not/read" });
  const request = require("node:http").request(process.env.FOOM_HOOK_URL, { method: "POST", headers: { Authorization: process.env.FOOM_TOKEN, "X-Foom-Session": process.env.FOOM_SESSION, "X-Foom-Event": "Stop", "X-Foom-Sequence": "1", "Content-Type": "application/json" } }, response => {
    response.resume();
    response.on("end", () => { console.log("AGENT_EXITED"); process.exit(response.statusCode === 204 ? 0 : 1); });
  });
  request.on("error", error => { console.error(error.message); process.exit(1); });
  request.end(payload);
} else {
  const payload = agent === "claude" ? { session_id: ${JSON.stringify(conversation)}, hook_event_name: "Stop" } : { "thread-id": ${JSON.stringify(conversation)}, "turn-id": "turn-1", type: "agent-turn-complete" };
  let command, hookArgs, input;
  if (agent === "claude") {
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
    command = "sh"; hookArgs = ["-c", settings.hooks.Stop[0].hooks[0].command]; input = JSON.stringify(payload);
  } else {
    const notify = args.find(arg => arg.startsWith("notify="));
    [command, ...hookArgs] = JSON.parse(notify.slice(7));
    hookArgs.push(JSON.stringify(payload));
  }
  const hook = spawn(command, hookArgs, { stdio: ["pipe", "ignore", "inherit"] });
  hook.stdin.end(input);
  hook.on("exit", () => { console.log("AGENT_EXITED"); process.exit(0); });
}
`,
    );
    await chmod(path.join(bin, agent), 0o755);
    const options = {
      fixture: "agent",
      args: [`--user-data-dir=${profile}`],
      env: { HOME: home, PATH: bin, TEST_ARGV: argvFile },
    };
    const app = await launchApp(context, options);
    const page = await boardPage(app);
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    }, repo);
    const id = await page.evaluate(async (agent) => {
      const repository = await window.desktop.addRepository();
      return window.desktop.startWorktree({
        repository: repository.path,
        branch: "resume-test",
        run: agent,
      });
    }, agent);
    await expect
      .poll(() =>
        page.evaluate(
          async (id) => (await window.desktop.workspace()).terminals.find((row) => row.id === id),
          id,
        ),
      )
      .toMatchObject({ exited: true, conversationId: conversation });
    const firstLaunch = JSON.parse(await readFile(argvFile, "utf8"));
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(path.join(profile, "sessions.json"), "utf8"))[0]
            ?.conversationId,
      )
      .toBe(conversation);
    await quitAndWait(app, () => app.evaluate(({ app }) => app.quit()));
    const restoredApp = await launchApp(context, { ...options, fixture: "restored" });
    const restored = await boardPage(restoredApp);
    await expect
      .poll(() => restored.evaluate(async () => (await window.desktop.workspace()).terminals))
      .toMatchObject([{ id, exited: true, dormant: true, conversationId: conversation }]);
    const agentName =
      agent === "claude" ? "Claude Code" : agent === "codex" ? "Codex" : "Antigravity";
    await restored
      .getByRole("button", { name: `Actions for ${agentName} in resume-test`, exact: true })
      .click();
    const copySession = restored.getByRole("button", { name: "Copy session ID", exact: true });
    await copySession.click();
    await expect
      .poll(() => restoredApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(conversation);
    await expect(copySession).toHaveAttribute("data-copied", "true");
    await restored.getByRole("button", { name: "Copy Foom session ID", exact: true }).click();
    await expect.poll(() => restoredApp.evaluate(({ clipboard }) => clipboard.readText())).toBe(id);
    if (agent === "claude")
      await restored.screenshot({
        path: evidencePath("960-session-panel.png"),
        animations: "disabled",
      });
    await restored.getByRole("menuitem", { name: "Copy session ID", exact: true }).click();
    // Clipboard writing finishes before the source's inventory refresh and panel
    // dismissal. Wait for the actual details dialog to close before opening it again.
    await expect(
      restored.getByRole("dialog", { name: `${agentName} details and commands`, exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(() => restoredApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(conversation);
    await restored
      .getByRole("button", { name: `Actions for ${agentName} in resume-test`, exact: true })
      .click();
    await restored.getByRole("menuitem", { name: /^Resume conversation/ }).click();
    await expect
      .poll(() => restored.evaluate(async () => (await window.desktop.workspace()).terminals))
      .toMatchObject([{ id, exited: false, conversationId: conversation }]);
    await expect(restored.locator(".xterm-rows")).toContainText("RESUMED_CONVERSATION");
    const resumedLaunch = JSON.parse(await readFile(argvFile, "utf8"));
    await expect(restored.locator(".xterm-rows")).toContainText(
      `RESUMED_CONVERSATION ${resumedLaunch.pid}`,
    );
    assert.deepEqual(resumedLaunch.args.slice(0, 2), [
      agent === "claude" ? "--resume" : agent === "codex" ? "resume" : "--conversation",
      conversation,
    ]);
    assert.equal(resumedLaunch.cwd, firstLaunch.cwd);
    assert.ok(firstLaunch.token);
    assert.ok(resumedLaunch.token);
    assert.notEqual(resumedLaunch.token, firstLaunch.token);
    const tile = restored.locator('.terminal-tile[data-kind="agent"]');
    const tileMenu = tile.getByRole("button", { name: "Tile 1 menu", exact: true });
    const menu = restored.getByRole("dialog", { name: "Tile 1 menu", exact: true });
    const hide = tile.getByRole("button", { name: "Hide", exact: true });
    const close = tile.getByRole("button", { name: "Close", exact: true });
    const hoverControl = async (button) => {
      const bounds = await button.boundingBox();
      assert.ok(bounds);
      const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      await restored.mouse.move(point.x, point.y);
      const hits = () =>
        button.evaluate(
          (element, { x, y }) => element.contains(document.elementFromPoint(x, y)),
          point,
        );
      assert.ok(await hits());
      return hits;
    };
    const tileWidth = () => tile.evaluate((element) => element.offsetWidth);
    await expect(hide).toBeVisible();
    await expect(close).toHaveCount(0);
    await expect(restored.locator(".xterm-helper-textarea")).toBeFocused();
    let wideHideHit;
    if (agent === "codex") {
      await restored.emulateMedia({ reducedMotion: "reduce" });
      await expect.poll(tileWidth).toBeGreaterThan(120);
      wideHideHit = await hoverControl(hide);
    }
    await restored.locator(".xterm-helper-textarea").press("Control+c");
    await expect
      .poll(() =>
        restored.evaluate(async () => (await window.desktop.workspace()).terminals[0]?.exited),
      )
      .toBe(true);
    await expect(hide).toHaveText("−");
    await expect(close).toHaveText("×");
    await expect(close).toHaveAttribute("title", "Close");
    if (wideHideHit) assert.ok(await wideHideHit());
    if (agent === "codex") {
      for (const theme of ["eclipse-light", "eclipse-dark"]) {
        await restored.evaluate(
          (interfaceTheme) => window.desktop.saveSetup({ interfaceTheme }),
          theme,
        );
        await tile.getByRole("button", { name: "Tile 1 menu", exact: true }).click();
        await expect(restored.getByRole("menuitem", { name: "Hide", exact: true })).toBeVisible();
        await expect(restored.getByRole("menuitem", { name: "Close", exact: true })).toBeVisible();
        await restored.screenshot({
          path: evidencePath(`975-exited-agent-${theme}.png`),
          animations: "disabled",
        });
        await restored.getByRole("dialog", { name: "Tile 1 menu", exact: true }).press("Escape");
      }
    }
    await hide.click();
    await expect(restored.locator('.terminal-tile[data-empty="false"]')).toHaveCount(0);
    await expect(
      restored.getByRole("button", {
        name: `Actions for ${agentName} in resume-test`,
        exact: true,
      }),
    ).toBeVisible();
    await restored
      .getByRole("button", { name: `Actions for ${agentName} in resume-test`, exact: true })
      .click();
    await restored.getByRole("menuitem", { name: /^Resume conversation/ }).click();
    await expect
      .poll(() =>
        restored.evaluate(async () => (await window.desktop.workspace()).terminals[0]?.exited),
      )
      .toBe(false);
    await expect
      .poll(async () => JSON.parse(await readFile(argvFile, "utf8")).token)
      .not.toBe(resumedLaunch.token);
    const secondResume = JSON.parse(await readFile(argvFile, "utf8"));
    await expect(restored.locator(".xterm-rows")).toContainText(
      `RESUMED_CONVERSATION ${secondResume.pid}`,
    );
    await expect(restored.locator(".xterm-helper-textarea")).toBeFocused();
    let shell;
    let divider;
    if (agent === "codex") {
      await tileMenu.click();
      await restored.getByRole("menuitem", { name: "Split terminal left", exact: true }).click();
      shell = await restored.evaluate(() => window.desktop.sidebarCommand({ kind: "home-shell" }));
      await restored.locator(`[data-drag-session="${shell.terminalId}"]`).click();
      await expect(restored.locator('.terminal-tile[data-kind="shell"] .xterm')).toBeVisible();
      divider = restored.getByRole("separator", { name: "Resize tiles" });
      await hide.focus();
      await sweepTileHeader(
        divider,
        tile,
        ["Tile 1 menu", "Maximize tile", "Hide"],
        ['.board-light[data-exited="false"][aria-label]'],
        menu,
      );
      await divider.press("Home");
      await expect.poll(tileWidth).toBeLessThan(120);
      await expect(close).toHaveCount(0);
    }
    if (divider) {
      await expect(hide).toHaveCount(0);
      await tileMenu.click();
      const menuHide = menu.getByRole("menuitem", { name: "Hide", exact: true });
      await menuHide.focus();
      const narrowHideHit = await hoverControl(menuHide);
      await restored.evaluate((id) => window.desktop.input(id, "\u0003"), id);
      await expect(menu.getByRole("menuitem", { name: "Close", exact: true })).toBeVisible();
      await expect(menuHide).toBeFocused();
      assert.ok(await narrowHideHit());
      await menu.press("Escape");
      const controls = ["Tile 1 menu", "Maximize tile", "Hide", "Close"];
      const light = '.board-light[data-exited="true"][aria-label]';
      const exitWord = ".tile-exit-status > span:first-child";
      const exitIcon = '.tile-exit-status[title="exited"] > svg[aria-label="exited"]';
      await sweepTileHeader(divider, tile, controls, [light, `${exitWord}, ${exitIcon}`], menu);

      // Exercise the reported width between keyboard increments with the
      // controls faded. The exit word still needs to fit in full.
      const headerWidth = () =>
        tile.locator(".tile-title").evaluate((element) => element.offsetWidth);
      const targetWidth = 153;
      const handle = await divider.boundingBox();
      assert.ok(handle);
      const x = handle.x + handle.width / 2;
      const y = handle.y + handle.height / 2;
      const delta = targetWidth - (await headerWidth());
      await restored.mouse.move(x, y);
      await restored.mouse.down();
      await restored.mouse.move(x + delta, y);
      await restored.mouse.up();
      await expect
        .poll(async () => Math.abs((await headerWidth()) - targetWidth))
        .toBeLessThanOrEqual(2);
      const shellTile = restored.locator('.terminal-tile[data-kind="shell"]');
      await shellTile.locator(".xterm").click();
      await expect(shellTile).toHaveAttribute("data-focused", "true");
      await expect(tile.locator(".tile-controls")).toHaveCSS("opacity", "0");
      await expectHeaderIndicators(tile, [light, exitWord]);
      await divider.press("Home");
      await expect.poll(tileWidth).toBeLessThan(120);
      await tileMenu.click();
      await menu.getByRole("menuitem", { name: "Close", exact: true }).click();
    } else {
      await tile.locator(".xterm-helper-textarea").press("Control+c");
      await close.click();
    }
    await expect(tile).toHaveCount(0);
    await expect(restored.locator(`[data-drag-session="${id}"]`)).toHaveCount(0);
    assert.equal(await realpath(resumedLaunch.cwd), resumedLaunch.cwd);
    if (shell) {
      await restored.evaluate(() => window.desktop.appMenu.execute("tidy-tiles"));
      const shellTile = restored.locator('.terminal-tile[data-kind="shell"]');
      await shellTile.getByRole("button", { name: "Tile 1 menu", exact: true }).click();
      await restored.getByRole("menuitem", { name: "Split terminal right", exact: true }).click();
      const filename = "header-preview.html";
      await writeFile(path.join(repo, filename), "<p>Preview</p>");
      await pickPreviewFile(restoredApp, restored, repo, filename);
      await restored.getByRole("treeitem", { name: `HTML preview: ${filename}` }).click();
      const preview = restored.locator('.terminal-tile[data-kind="preview"]');
      await preview.getByRole("button", { name: "Tile 1 menu", exact: true }).click();
      await restored.getByRole("menuitem", { name: "Allow network…", exact: true }).click();
      const confirmation = await confirmationPage(restoredApp);
      await confirmation.getByRole("button", { name: "Allow network", exact: true }).click();
      await expect(restored.locator(".board-confirmation-scrim")).toHaveCount(0);
      const globe = preview.getByRole("img", { name: "Network enabled", exact: true });
      await expect(globe).toHaveAttribute("title", "Network enabled");
      await sweepTileHeader(
        restored.getByRole("separator", { name: "Resize tiles" }),
        preview,
        ["Tile 1 menu", "Maximize tile", "Reload", "Close"],
        [".preview-glyph", ".preview-network svg"],
      );
      await preview.getByRole("button", { name: "Close", exact: true }).click();
      await restored.evaluate(() => window.desktop.appMenu.execute("tidy-tiles"));
      await shellTile.getByRole("button", { name: "Tile 1 menu", exact: true }).click();
      await restored.getByRole("menuitem", { name: "Split terminal right", exact: true }).click();

      // Keep the first attachment reply pending so Close still cancels startup.
      await restoredApp.evaluate(({ ipcMain }) => {
        const channel = "terminal:attach";
        const attach = ipcMain._invokeHandlers.get(channel);
        const { promise, resolve } = Promise.withResolvers();
        globalThis.startupAttachHeld = false;
        globalThis.releaseStartupAttach = () => {
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, attach);
          resolve();
        };
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (...args) => {
          const reply = await attach(...args);
          globalThis.startupAttachHeld = true;
          await promise;
          return reply;
        });
      });
      try {
        await restored
          .getByRole("button", { name: "Actions for Home shell", exact: true })
          .press("Enter");
        await restored.getByRole("menuitem", { name: "New shell", exact: true }).press("Enter");
        const overlay = restored.locator(".tile-startup");
        await expect(overlay).toHaveText("Starting on Local…");
        await expect
          .poll(() => restoredApp.evaluate(() => globalThis.startupAttachHeld))
          .toBe(true);
        const starting = restored.locator(".terminal-tile").filter({ has: overlay });
        const startingMenu = starting.getByRole("button", { name: "Tile 1 menu", exact: true });
        const cancel = starting.getByRole("button", { name: "Close", exact: true });
        const startupDivider = restored.getByRole("separator", { name: "Resize tiles" });
        await expect(startingMenu).toBeDisabled();
        await sweepTileHeader(
          startupDivider,
          starting,
          ["Tile 1 menu", "Maximize tile", "Close"],
          [".board-light[aria-label]"],
          undefined,
          ["Maximize tile"],
        );
        await startupDivider.press("Home");
        await expect
          .poll(() => starting.locator(".tile-title").evaluate((element) => element.offsetWidth))
          .toBeLessThan(120);
        await cancel.click();
        await expect(overlay).toHaveCount(0);
      } finally {
        await restoredApp.evaluate(() => globalThis.releaseStartupAttach());
      }
      await expect
        .poll(() =>
          restored.evaluate(async () =>
            (await window.desktop.workspace()).terminals.map((row) => row.id),
          ),
        )
        .toEqual([shell.terminalId]);
      await restored.evaluate(() => window.desktop.appMenu.execute("tidy-tiles"));
      await restored.evaluate((id) => window.desktop.input(id, "exit\r"), shell.terminalId);
      await expect
        .poll(() =>
          restored.evaluate(
            async (id) =>
              (await window.desktop.workspace()).terminals.find((row) => row.id === id)?.exited,
            shell.terminalId,
          ),
        )
        .toBe(true);
      for (const theme of ["eclipse-light", "eclipse-dark"]) {
        await restored.evaluate(
          (interfaceTheme) => window.desktop.saveSetup({ interfaceTheme }),
          theme,
        );
        await restored.getByRole("button", { name: "Tile 1 menu", exact: true }).click();
        await expect(restored.getByRole("menuitem", { name: "Close", exact: true })).toBeVisible();
        await restored.screenshot({
          path: evidencePath(`975-exited-shell-${theme}.png`),
          animations: "disabled",
        });
        await restored.getByRole("dialog", { name: "Tile 1 menu", exact: true }).press("Escape");
      }
      await restored.getByRole("button", { name: "Close", exact: true }).click();
    }
    await expect(restored.locator('.terminal-tile[data-empty="false"]')).toHaveCount(0);
    await expect
      .poll(() =>
        restored.evaluate(async () => (await window.desktop.workspace()).terminals.length),
      )
      .toBe(0);
    await expect
      .poll(async () => JSON.parse(await readFile(path.join(profile, "sessions.json"), "utf8")))
      .toEqual([]);
  });
}

for (const [agent, form] of [
  ["claude", "--resume"],
  ["claude", "-r"],
  ["codex", "resume"],
  ["agy", "--conversation"],
]) {
  test(`pastes ${agent} ${form} in a checkout and retains rejected conversations`, {
    timeout: deadline(60_000),
    skip: process.platform === "win32" && "The fake CLI is a POSIX executable",
  }, async (context) => {
    const { chmod } = require("node:fs/promises");
    const root = await mkdtemp(path.join(tmpdir(), "foom-pasted-"));
    removeAfterApps(context, root);
    const bin = path.join(root, "bin"),
      repo = path.join(root, "repo"),
      home = path.join(root, "home");
    const profile = path.join(root, "profile"),
      argvFile = path.join(root, "argv.json");
    await Promise.all([mkdir(bin), mkdir(repo), mkdir(home)]);
    isolatedGit(["init", "-q", "-b", "main", repo]);
    isolatedGit([
      "-C",
      repo,
      "-c",
      "user.name=Foom",
      "-c",
      "user.email=foom@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "init",
    ]);
    await writeFile(
      path.join(bin, agent),
      `#!/usr/bin/env node
const { writeFileSync, renameSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("1.0.0"); process.exit(0); }
if (args[0] === "--help") { console.log("resume"); process.exit(0); }
if (args[0] === "plugin") { console.log("{}"); process.exit(0); }
const record = process.env.TEST_ARGV + ".tmp";
writeFileSync(record, JSON.stringify({ args, cwd: process.cwd() }));
renameSync(record, process.env.TEST_ARGV);
console.log("UNKNOWN_CONVERSATION " + args[1]);
process.exit(1);
`,
    );
    await chmod(path.join(bin, agent), 0o755);
    const app = await launchApp(context, {
      fixture: "agent",
      args: [`--user-data-dir=${profile}`],
      env: { HOME: home, PATH: bin, TEST_ARGV: argvFile },
    });
    const page = await boardPage(app);
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    }, repo);
    await page.evaluate(async () => {
      await window.desktop.addRepository();
    });
    const panel = page.getByRole("button", { name: "Actions for Main checkout", exact: true });
    await panel.click();
    await page.getByRole("menuitem", { name: "Resume conversation…", exact: true }).click();
    const input = page.getByRole("textbox", { name: "Conversation ID or resume command" });
    await expect(input).toBeFocused();
    await input.fill(`${agent} ${form} external-123`);
    await input.press("Escape");
    await expect(input).toHaveCount(0);
    assert.equal((await page.evaluate(() => window.desktop.workspace())).terminals.length, 0);
    await page.getByRole("menuitem", { name: "Resume conversation…", exact: true }).click();
    await input.fill(`${agent} ${form} external-123 --extra`);
    await input.press("Enter");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    assert.equal((await page.evaluate(() => window.desktop.workspace())).terminals.length, 0);
    await input.fill(`${agent} ${form} external-123`);
    await input.press("Enter");
    await expect
      .poll(() => page.evaluate(async () => (await window.desktop.workspace()).terminals))
      .toMatchObject([{ agent, exited: true, conversationId: "external-123" }]);
    await expect(page.locator(".xterm-rows")).toContainText("UNKNOWN_CONVERSATION external-123");
    const exitedRow = page.locator(".board-row[data-kind='agent']");
    await expect(exitedRow).toHaveAccessibleName(/Exited/);
    await expect(exitedRow.locator(".session-program")).toHaveText("exited");
    for (const bulb of [
      exitedRow.locator(".board-light"),
      page.locator(".tile-title .board-light"),
    ]) {
      await expect(bulb).toHaveAttribute("data-exited", "true");
      await expect(bulb).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(bulb).toHaveCSS("border-radius", "0px");
    }
    const record = JSON.parse(await readFile(argvFile, "utf8"));
    assert.deepEqual(record.args.slice(0, 2), [
      agent === "claude" ? "--resume" : form,
      "external-123",
    ]);
    assert.equal(record.cwd, await realpath(repo));
    const label = agent === "claude" ? "Claude Code" : agent === "codex" ? "Codex" : "Antigravity";
    await page.getByRole("button", { name: `Actions for ${label} in main`, exact: true }).click();
    await expect(page.getByRole("menuitem", { name: /^Resume conversation/ })).toBeVisible();
    await page.getByRole("menuitem", { name: "Copy session ID", exact: true }).click();
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe("external-123");
  });
}

test("Close removes a restored session after its repository registration is dropped", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-missing-repository-"));
  removeAfterApps(context, root);
  const profile = path.join(root, "profile");
  const options = { args: [`--user-data-dir=${profile}`] };
  const app = await launchApp(context, { ...options, fixture: "repository" });
  const page = await boardPage(app);
  const repository = await page.evaluate(
    async () => (await window.desktop.sidebarInventory()).repositories[0],
  );
  await quitAndWait(app, () => app.evaluate(({ app }) => app.quit()));
  const moved = path.join(root, "moved-repository");
  await rename(repository.path, moved);
  await writeFile(path.join(moved, "keep.txt"), "Keep checkout contents");
  const before = isolatedGit(["-C", moved, "worktree", "list", "--porcelain"]);
  await writeFile(
    path.join(profile, "sessions.json"),
    JSON.stringify([
      {
        id: "missing-repository-session",
        agent: "claude",
        repository: repository.path,
        worktree: repository.path,
        branch: "main",
        running: false,
      },
    ]),
  );
  const restoredApp = await launchApp(context, { ...options, fixture: "restored" });
  const restored = await boardPage(restoredApp);
  await expect
    .poll(() =>
      restored.evaluate(async () => (await window.desktop.sidebarInventory()).repositories),
    )
    .toEqual([]);
  await expect
    .poll(() => restored.evaluate(async () => (await window.desktop.workspace()).terminals))
    .toMatchObject([{ id: "missing-repository-session", exited: true, dormant: true }]);
  const row = restored.locator('[data-drag-session="missing-repository-session"]');
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: /^Actions for / }).click();
  await restored.getByRole("menuitem", { name: "Close", exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect
    .poll(() => restored.evaluate(async () => (await window.desktop.workspace()).terminals))
    .toEqual([]);
  await expect
    .poll(async () => JSON.parse(await readFile(path.join(profile, "sessions.json"), "utf8")))
    .toEqual([]);
  assert.equal(await readFile(path.join(moved, "keep.txt"), "utf8"), "Keep checkout contents");
  assert.deepEqual(isolatedGit(["-C", moved, "worktree", "list", "--porcelain"]), before);
});
