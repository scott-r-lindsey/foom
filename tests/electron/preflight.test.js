const { evidencePath } = require("../helpers/evidence.js");
const { gitSync: isolatedGit } = require("../helpers/git.js");

const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, mkdtemp, readFile, realpath, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { deadline, expect } = require("./test-policy.js");
const {
  assertAccessible,
  boardPage,
  confirmationPage,
  launchApp,
  launchCheckoutShell,
  openSettingsScreen,
  quitAndWait,
  removeAfterApps,
  tabTo,
} = require("./harness.js");

test("a fresh profile opens preflight, and it passes accessibility checks", async (context) => {
  const app = await launchApp(context, { fixture: "first-run" });
  const page = await boardPage(app);
  await page.getByRole("button", { name: "Start preflight" }).waitFor();
  assert.equal(await page.locator(".board-home").count(), 0);
  // The ring moves by path distance, boosts on hover/focus, and stops for reduced motion.
  const ring = () =>
    page
      .locator(".ignite-ring")
      .last()
      .evaluate((ring) => {
        const style = getComputedStyle(ring);
        return `${style.animationName} ${style.animationPlayState} ${style.animationDuration} ${style.animationTimingFunction}`;
      });
  assert.equal(await ring(), "ignite-orbit, ignite-boost running, paused 4s, 1.25s linear, linear");
  await page.getByRole("button", { name: "Start preflight" }).hover();
  assert.equal(
    await ring(),
    "ignite-orbit, ignite-boost running, running 4s, 1.25s linear, linear",
  );
  await page.mouse.move(0, 0);
  await page.getByRole("button", { name: "Start preflight" }).focus();
  assert.equal(
    await ring(),
    "ignite-orbit, ignite-boost running, running 4s, 1.25s linear, linear",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await ring(), "none running, running 0s ease");
  await page.emulateMedia({ reducedMotion: null });
  await assertAccessible(page);
  await page.getByRole("button", { name: "Start preflight" }).click();
  await page.getByRole("heading", { name: "Agents", exact: true }).waitFor();
  await expect(page.getByText("Looking…")).toHaveCount(0, { timeout: deadline(20000) });
  await assertAccessible(page);
});

async function assertPreflightFits(page, label) {
  const settle = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  await expect
    .poll(
      () =>
        page.locator(".preflight-viewport").evaluate((viewport) => {
          const content = viewport.querySelector(".preflight-content");
          const stage = viewport.querySelector(".preflight-stage");
          const inner = viewport.querySelector(".preflight-inner");
          const footer = viewport.querySelector(".preflight-footer");
          const scale = Number(getComputedStyle(content).zoom);
          const overflows =
            Math.max(inner.offsetHeight, inner.scrollHeight) > stage.clientHeight + 1;
          return {
            clippedNavigation: footer
              ? [...footer.querySelectorAll("button")].some((button) => {
                  const bounds = button.getBoundingClientRect();
                  const visible = footer.getBoundingClientRect();
                  return (
                    bounds.top < visible.top - 1 ||
                    bounds.bottom > visible.bottom + 1 ||
                    bounds.left < visible.left - 1 ||
                    bounds.right > visible.right + 1
                  );
                })
              : false,
            horizontal: stage.scrollWidth > stage.clientWidth + 1,
            enlargedOverflow: overflows && scale > 1.00001,
            outsideWindow: viewport.getBoundingClientRect().bottom > window.innerHeight + 1,
            coveredFooter: footer
              ? stage.getBoundingClientRect().bottom > footer.getBoundingClientRect().top + 1
              : false,
          };
        }),
      { message: label },
    )
    .toEqual({
      clippedNavigation: false,
      horizontal: false,
      enlargedOverflow: false,
      outsideWindow: false,
      coveredFooter: false,
    });
  await expect
    .poll(async () => {
      const before = await page
        .locator(".preflight-content")
        .evaluate((content) => getComputedStyle(content).zoom);
      await settle();
      return page
        .locator(".preflight-content")
        .evaluate((content, before) => getComputedStyle(content).zoom === before, before);
    })
    .toBe(true);
}

test("preflight fits safely through resize, zoom, long input and changing steps", {
  timeout: deadline(60_000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "first-run" });
  const page = await boardPage(app);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Start preflight", exact: true }).click();
  for (let step = 0; step < 2; step++)
    await page.getByRole("button", { name: "Continue", exact: true }).click();
  const rail = page.getByRole("navigation", { name: "Preflight steps" });
  for (const [width, height, zoom] of [
    [1600, 1000, 100],
    [1600, 1000, 150],
    [1600, 1000, 80],
    [1280, 720, 150],
    [900, 640, 100],
    [650, 600, 150],
    [480, 360, 150],
    // Leave room for native window chrome even on Linux without a window manager.
    [480, 300, 150],
    [2400, 1400, 100],
    [1600, 1000, 100],
  ]) {
    const size = await app.evaluate(
      ({ BrowserWindow }, { width, height, zoom }) => {
        const window = BrowserWindow.getAllWindows().find(
          (window) => window.webContents.getURL() === "app://bundle/index.html",
        );
        window.setMinimumSize(0, 0);
        window.setSize(width, height);
        window.webContents.setZoomFactor(zoom / 100);
        return window.getContentBounds();
      },
      { width, height, zoom },
    );
    await expect
      .poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight]))
      .toEqual([Math.round((size.width * 100) / zoom), Math.round((size.height * 100) / zoom)]);
    for (const step of ["Welcome", "Agents", "Repositories", "Go / no-go"]) {
      await rail.getByRole("button", { name: new RegExp(step) }).click();
      await assertPreflightFits(page, `${width}×${height} at ${zoom}%: ${step}`);
    }
  }
  await rail.getByRole("button", { name: /Repositories/ }).click();
  for (const [control, scale] of [
    ["Larger", 110],
    ["Larger", 120],
    ["Larger", 130],
    ["Larger", 140],
    ["Larger", 150],
    ["Smaller", 140],
    ["Smaller", 130],
    ["Smaller", 120],
    ["Smaller", 110],
    ["Smaller", 100],
    ["Smaller", 90],
    ["Smaller", 80],
    ["Larger", 90],
    ["Larger", 100],
  ]) {
    await page.getByRole("button", { name: control, exact: true }).click();
    await expect(page.getByRole("group", { name: "Interface size" }).locator("output")).toHaveText(
      `${scale}%`,
    );
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((window) => window.webContents.getURL() === "app://bundle/index.html")
            .webContents.getZoomFactor(),
        ),
      )
      .toBeCloseTo(scale / 100);
    await assertPreflightFits(
      page,
      "Real interface-size controls after resizing and expanding settings",
    );
  }
});

test("large repository scans remain readable and filter without changing scale", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-layout-repos-"));
  removeAfterApps(context, root);
  for (const group of ["alpha", "beta", "gamma"]) {
    for (let index = 0; index < 12; index++) {
      const directory = path.join(root, group, `project-${index}-${"long-name-".repeat(12)}`);
      await mkdir(directory, { recursive: true });
      isolatedGit(["init", "-q", directory]);
    }
  }
  const app = await launchApp(context, { fixture: "first-run" });
  const page = await boardPage(app);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await app.evaluate(({ BrowserWindow, dialog }, directory) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setSize(1600, 1000);
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, root);
  await page.getByRole("button", { name: "Start preflight", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Preflight steps" })
    .getByRole("button", { name: /Repositories/ })
    .click();
  await page.getByRole("button", { name: "Choose folder…" }).click();
  await expect(page.locator(".repo-row")).toHaveCount(36);
  await assertPreflightFits(page, "Many repository groups and long names");
  await page.locator('.repo-row input[type="checkbox"]').last().uncheck();
  await assertPreflightFits(page, "Selection at the bottom of a long scan");
  const scale = await page
    .locator(".preflight-content")
    .evaluate((content) => getComputedStyle(content).zoom);
  await page.getByRole("searchbox").fill("does-not-exist");
  await expect(page.locator(".repo-row")).toHaveCount(0);
  await expect(page.locator(".preflight-content")).toHaveCSS("zoom", scale);
  await page.getByRole("searchbox").fill("");
  await expect(page.locator(".repo-row")).toHaveCount(36);
  await assertPreflightFits(page, "Clearing a repository filter");
});

test("first run goes from no agents to go, launches by keyboard, and can be replayed", {
  timeout: deadline(60_000),
  skip: process.platform === "win32" && "The fake agents are POSIX scripts",
}, async (context) => {
  const { chmod, symlink } = require("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "foom-first-run-"));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  const repo = path.join(root, "app");
  const userData = path.join(root, "user-data");
  await mkdir(bin);
  await mkdir(repo);
  await mkdir(path.join(root, "home"));
  isolatedGit(["init", "-q", repo]);
  isolatedGit([
    "-C",
    repo,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "-qm",
    "Initial",
  ]);
  // Node gets its own folder: agents installed beside it must stay hidden.
  const nodeBin = path.join(root, "node-bin");
  await mkdir(nodeBin);
  await symlink(process.execPath, path.join(nodeBin, "node"));

  const app = await launchApp(context, {
    fixture: "first-run",
    args: [`--user-data-dir=${userData}`],
    // A private HOME and PATH hide any agents installed on this machine.
    env: {
      HOME: path.join(root, "home"),
      PATH: [bin, nodeBin].join(path.delimiter),
    },
  });
  const page = await boardPage(app);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, repo);

  const contentScales = new Map();
  // Check centering against actual stage bounds: macOS can clamp tall window requests.
  // Short steps center at every interface size; overflowing steps keep their top reachable.
  for (const [width, height, zoom] of [
    [1200, 900, 1],
    [1600, 1000, 1],
    [1600, 700, 1],
    [1600, 2000, 1],
    // A small CI display can clamp both requested window sizes to the same bounds.
    // Zoom out further to exercise actual scale growth even on that display.
    [1600, 1000, 0.5],
    [1600, 1000, 0.8],
    [1600, 1000, 1.5],
    [800, 600, 1.5],
  ]) {
    const size = await app.evaluate(
      ({ BrowserWindow, screen }, { width, height, zoom }) => {
        const window = BrowserWindow.getAllWindows().find(
          (window) => window.webContents.getURL() === "app://bundle/index.html",
        );
        const available = screen.getPrimaryDisplay().workAreaSize;
        window.setSize(Math.min(width, available.width), Math.min(height, available.height));
        window.webContents.setZoomFactor(zoom);
        return window.getContentBounds();
      },
      { width, height, zoom },
    );
    // Window resize delivery and ResizeObserver run after the main-process call returns.
    await expect
      .poll(() =>
        page.evaluate(
          ({ size, zoom }) =>
            Math.max(
              Math.abs(window.innerWidth - size.width / zoom),
              Math.abs(window.innerHeight - size.height / zoom),
            ),
          { size, zoom },
        ),
      )
      .toBeLessThanOrEqual(1);
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        }),
    );
    await expect
      .poll(() =>
        page.locator(".preflight-stage").evaluate((stage) => {
          const inner = stage.querySelector(".preflight-inner");
          const bounds = inner.getBoundingClientRect();
          const stageBounds = stage.getBoundingClientRect();
          return Math.abs(
            bounds.top - stageBounds.top - Math.max(0, (stageBounds.height - bounds.height) / 2),
          );
        }),
      )
      .toBeLessThan(2);
    contentScales.set(
      `${width}x${height}@${zoom}`,
      await page
        .locator(".preflight-content")
        .evaluate((content) => Number(getComputedStyle(content).zoom)),
    );
    if (width === 800) {
      const overflow = await page.locator(".preflight-stage").evaluate((stage) => {
        const overflows = stage.scrollHeight > stage.clientHeight;
        stage.scrollTop = stage.scrollHeight;
        return {
          overflows,
          bottom: stage.querySelector(".preflight-inner").getBoundingClientRect().bottom,
          stageBottom: stage.getBoundingClientRect().bottom,
        };
      });
      assert.ok(overflow.overflows, "Small zoomed stage exercises overflow");
      assert.ok(
        Math.abs(overflow.bottom - overflow.stageBottom) < 2,
        "The content bottom is reachable",
      );
    }
  }
  await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
    window.webContents.setZoomFactor(1);
    const available = screen.getPrimaryDisplay().workAreaSize;
    window.setSize(Math.min(1600, available.width), Math.min(1000, available.height));
  });

  assert.ok(
    contentScales.get("1600x1000@0.5") > contentScales.get("1600x1000@1.5"),
    "More available CSS space enlarges content, even when native window sizes are clamped",
  );
  const sharedScale = contentScales.get("1600x1000@1");
  const assertFooter = async (sameSize = true) => {
    const layout = await page.locator(".preflight-content").evaluate((content) => {
      const stage = content.querySelector(".preflight-stage");
      const footer = content.querySelector(".preflight-footer");
      stage.scrollTop = stage.scrollHeight;
      return {
        scale: getComputedStyle(content).zoom,
        bottom: footer.getBoundingClientRect().bottom,
        viewport: window.innerHeight,
        stageBottom: stage.getBoundingClientRect().bottom,
        footerTop: footer.getBoundingClientRect().top,
      };
    });
    if (sameSize)
      assert.ok(
        Number(layout.scale) <= sharedScale,
        "Larger steps can only lower the shared scale ceiling",
      );
    assert.ok(
      Math.abs(layout.bottom - layout.viewport) < 2,
      "Navigation stays at the viewport bottom",
    );
    assert.ok(
      layout.stageBottom <= layout.footerTop + 1,
      "Scrolled content cannot cover navigation",
    );
  };

  await tabTo(page, "Start preflight");
  await page.keyboard.press("Enter");
  const providerCount = (await page.evaluate(() => window.desktop.scanAgents(false))).agents.length;
  await expect(page.getByText("Not found")).toHaveCount(providerCount, {
    timeout: deadline(20000),
  });
  await assertFooter();
  await tabTo(page, "Continue");
  await page.keyboard.press("Enter");
  // The private HOME has no code folders, so the picker is the way in.
  await page.getByRole("button", { name: "Choose folder…" }).click();
  await page.getByText("1 of 1 selected").waitFor();
  await assertFooter();
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
    window.setSize(800, 600);
    window.webContents.setZoomFactor(1.5);
  });
  await assertFooter(false);
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Back", exact: true })).toBeInViewport();
  await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
    window.webContents.setZoomFactor(1);
    const available = screen.getPrimaryDisplay().workAreaSize;
    window.setSize(Math.min(1600, available.width), Math.min(1000, available.height));
  });
  await tabTo(page, "Continue");
  await page.keyboard.press("Enter");
  await page.getByText("Hold. Something needs fixing.").waitFor();
  await assertFooter();
  await expect(
    page.getByRole("navigation", { name: "Preflight steps" }).locator("ol button"),
  ).toHaveCount(4);
  await expect(page.locator(".preflight-poll").first()).not.toContainText("Worktrees");
  await expect(page.getByRole("button", { name: "Launch" })).toBeDisabled();
  await page.getByRole("button", { name: "Fix" }).click();

  // Install the hook-capable bundled agent fixtures, then scan again.
  const script = (body) => `#!/usr/bin/env node\nconst a = process.argv[2];\n${body}\n`;
  const agents = {
    claude: script(
      'if (a === "--version") console.log("2.1.300 (Claude Code)"); else console.log("  --settings <file-or-json>");',
    ),
    codex: script(
      'if (a === "--version") console.log("codex-cli 0.155.1"); else console.log("  -c, --config <key=value>");',
    ),
    agy: script('if (a === "--version") console.log("1.2.13");'),
    copilot: script(
      'if (a === "--version") console.log("GitHub Copilot CLI 1.0.103."); else console.log("--plugin-dir --additional-mcp-config --allow-tool --interactive --session-id --resume");',
    ),
  };
  for (const [name, source] of Object.entries(agents)) {
    await writeFile(path.join(bin, name), source);
    await chmod(path.join(bin, name), 0o755);
  }
  await page.getByRole("button", { name: "Scan again" }).click();
  await expect(page.locator(".agent-card:not(.missing) .agent-version")).toHaveText([
    "2.1.300",
    "0.155.1",
    "1.2.13",
    "1.0.103",
  ]);
  await expect(page.locator(".agent-card")).toHaveCount(providerCount);
  await expect(page.getByText(path.join(bin, "codex"), { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Hooks", exact: true })).toHaveCount(4);
  await expect(page.getByText("Notify + screen rules active", { exact: true })).toBeVisible();
  await assertPreflightFits(page, "Agent cards fit the scaled layout");
  await assertAccessible(page);
  await page.getByRole("button", { name: /Go \/ no-go/ }).click();
  await page.getByText("All stations go.").waitFor();
  await assertAccessible(page);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setContentSize(2200, 1000);
  });
  await page.waitForFunction(() => innerWidth === 2200);
  await tabTo(page, "Launch");
  await page.keyboard.press("Enter");

  // Reduced motion holds its still frame until the user continues.
  await page.getByText("Takeoff was faster than expected.").waitFor();
  await expect(page.getByText("Click or press Esc to continue")).toBeVisible();
  await page.locator(".launch canvas").click();
  await expect(page.getByRole("dialog", { name: "Launch", exact: true })).toHaveCount(0);
  await expect(page.locator(".tile-title").filter({ hasText: "manual.html" })).toHaveCount(1);
  const firstManual = (await page.evaluate(() => window.desktop.sidebarInventory())).previews.find(
    (entry) => entry.worktree === "foom:manual",
  );
  assert.ok(firstManual);
  await expect(page.locator(".terminal-tile").first()).toHaveAttribute("data-kind", "preview");
  const firstRunGeometry = await page
    .locator(".terminal-tile")
    .evaluateAll((tiles) =>
      tiles.map((tile) => ({ left: tile.style.left, width: tile.style.width })),
    );
  assert.equal(firstRunGeometry.length, 2);

  if (process.env.FOOM_MANUAL_SCREENSHOTS === "1" && process.platform === "linux") {
    await mkdir(evidencePath("screenshots-680"), { recursive: true });
    const handle = await app.evaluate(({ BrowserWindow }) => {
      const board = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "app://bundle/index.html",
      );
      board.setBounds({ x: 0, y: 0, width: 1240, height: 850 });
      return board.getNativeWindowHandle().readUInt32LE();
    });
    for (const mode of ["light", "dark"]) {
      await page.evaluate((colorMode) => window.desktop.saveSetup({ colorMode }), mode);
      await expect
        .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors))
        .toBe(mode === "dark");
      await page.waitForFunction(() => innerWidth === 1240 && innerHeight === 850);
      await page.waitForFunction((mode) => {
        const canvas = document.querySelector("canvas.preview-snapshot");
        return (
          canvas?.getContext("2d").getImageData(0, 0, 1, 1).data[0] === (mode === "dark" ? 5 : 243)
        );
      }, mode);
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      require("node:child_process").execFileSync("import", [
        "-window",
        String(handle),
        evidencePath(`screenshots-680/first-run-${mode}.png`),
      ]);
    }
    await page.evaluate(() => window.desktop.saveSetup({ colorMode: "system" }));
  }

  await page.evaluate((id) => window.desktop.previews.close(id), firstManual.id);
  await launchCheckoutShell(app, page);
  const shellRow = page.locator(".board-row[data-kind='shell']");
  await shellRow.waitFor({ timeout: deadline(10000) });
  assert.deepEqual(
    await page
      .locator(".terminal-tile")
      .evaluateAll((tiles) =>
        tiles.map((tile) => ({ left: tile.style.left, width: tile.style.width })),
      ),
    firstRunGeometry,
  );

  const saved = JSON.parse(await readFile(path.join(userData, "settings.json"), "utf8"));
  // The profile keeps only profile settings; agent-editable ones live in Foom config.
  assert.equal(saved.version, 2);
  assert.equal(saved.settings.checkForUpdates, true);
  assert.deepEqual(Object.keys(saved.settings).sort(), [
    "agentBypassAcknowledged",
    "agyPluginOfferAnswered",
    "autoRemoveMergedWorktrees",
    "checkForUpdates",
    "codeFolder",
    "forgeHosts",
    "forges",
    "setupComplete",
    "showNestedRepositoryNames",
    "showPullRequests",
    "unreadChildMinutes",
    "worktreeLocation",
  ]);
  const effective = (await page.evaluate(() => window.desktop.setupState())).settings;
  assert.deepEqual(effective, {
    checkForUpdates: true,
    forges: { github: true, gitlab: true },
    forgeHosts: { "github.com": "github", "gitlab.com": "gitlab" },
    agyPluginOfferAnswered: false,
    setupComplete: true,
    hooks: true,
    restoreSessions: true,
    showNewChildren: true,
    closeFinishedAgents: true,
    concurrentChildren: 4,
    recentRepositoryDays: 30,
    unreadChildMinutes: 5,
    autoRemoveMergedWorktrees: false,
    showPullRequests: false,
    showNestedRepositoryNames: false,
    agents: { claude: true, codex: true, agy: true },
    agentArguments: { claude: [], codex: [], agy: [] },
    agentBypassAcknowledged: { claude: false, codex: false, agy: false },
    worktreeLocation: "root",
    colorMode: "system",
    panelColor: "vivid",
    interfaceTheme: "follow",
    interfaceScale: 100,
    terminalFontSize: 14,
    terminalFont: "Hack Nerd Font Mono",
    terminalTheme: "follow",
    sound: {
      choices: {
        working: { source: "builtin", file: "seagate-read-write.ogg" },
        done: { source: "builtin", file: "typewriter-bell.ogg" },
        "needs-you": { source: "builtin", file: "bicycle-bell.ogg" },
        refusal: { source: "builtin", file: "lip-pop.ogg" },
      },
      volume: 1,
      muted: false,
      working: false,
      workingVolume: 0.15,
      alerts: true,
      alertVolume: 0.5,
    },
    codeFolder: await realpath(repo),
  });

  const created = await page.evaluate(
    async (repository) => {
      const state = await window.desktop.setupState();
      const tree = await window.desktop.createWorktree(repository, "first-run-default");
      return { tree, root: state.worktreeRoot };
    },
    await realpath(repo),
  );
  // macOS temp homes resolve through /private; Git reports the resolved worktree path.
  assert.equal(
    created.tree.path,
    path.join(await realpath(created.root), "app", "first-run-default"),
  );

  // Settings returns to the same sidebar row.
  await shellRow.focus();
  await openSettingsScreen(page);
  await page.getByRole("region", { name: "Settings" }).waitFor();
  await expect(page.locator(".board-terminal")).toBeHidden();
  // The opening helper observes mount focus, but later board updates can move it.
  // Give this keyboard interaction a Settings target at dispatch, and wait for
  // native document focus too: activeElement alone survives a window losing focus.
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
  await page
    .getByRole("region", { name: "Settings" })
    .getByRole("heading", { name: "General", exact: true })
    .press("Escape");
  await expect(page.locator(".board-home")).toBeVisible();
  // The board remains visible behind Settings, so it cannot acknowledge Escape.
  await expect(page.getByRole("region", { name: "Settings" })).toBeHidden();
  await expect(shellRow).toBeFocused();
  await openSettingsScreen(page);
  await page.getByRole("button", { name: "General", exact: true }).click();
  await page.getByRole("radio", { name: /Put them next to/ }).check();
  await expect
    .poll(
      async () =>
        JSON.parse(await readFile(path.join(userData, "settings.json"), "utf8")).settings
          .worktreeLocation,
    )
    .toBe("adjacent");
  await quitAndWait(app, async () => {
    await app.evaluate(({ app }) => app.quit());
    const confirmation = await confirmationPage(app);
    await confirmation.getByRole("button", { name: "Stop all and quit" }).click();
  });
  const reopened = await launchApp(context, {
    fixture: "first-run",
    args: [`--user-data-dir=${userData}`],
    home: path.join(root, "home"),
  });
  const reopenedPage = await boardPage(reopened);
  assert.equal(
    (await reopenedPage.evaluate(() => window.desktop.sidebarInventory())).previews.filter(
      (entry) => entry.worktree === "foom:manual",
    ).length,
    0,
  );

  await openSettingsScreen(reopenedPage);
  await reopenedPage.getByRole("button", { name: "General", exact: true }).click();
  await expect(reopenedPage.getByRole("radio", { name: /Put them next to/ })).toBeChecked();
  await expect(
    reopenedPage.getByText(`${await realpath(repo)}-feat/search`, { exact: true }),
  ).toBeVisible();
  const trees = await reopenedPage.evaluate(
    (repository) => window.desktop.worktrees(repository),
    await realpath(repo),
  );
  assert.ok(trees.some((tree) => tree.path === created.tree.path));
});

test("preflight scans a code folder and adds the repositories worked on recently", async (context) => {
  const { utimes } = require("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "foom-code-"));
  removeAfterApps(context, root);
  const code = path.join(root, "code");
  const old = new Date(Date.now() - 90 * 86_400_000);
  for (const [name, stale] of [
    ["recent-app", false],
    [path.join("clients", "portal"), false],
    ["dusty", true],
  ]) {
    const repo = path.join(code, name);
    await mkdir(repo, { recursive: true });
    isolatedGit(["init", "-q", "-b", "main", repo]);
    if (stale) await utimes(path.join(repo, ".git", "HEAD"), old, old);
  }
  const app = await launchApp(context, { fixture: "first-run" });
  const page = await boardPage(app);
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, code);
  await page.getByRole("button", { name: "Start preflight" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Choose folder…" }).click();
  await page.getByText("2 of 3 selected").waitFor();
  const recent = page.getByRole("region", { name: "Recent · last 30 days" });
  await expect(recent.getByRole("checkbox")).toHaveCount(2);
  await expect(page.getByRole("region", { name: "Older" }).getByRole("checkbox")).not.toBeChecked();
  await assertAccessible(page);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByText("Hold. Something needs fixing.").waitFor();
  await assertAccessible(page);
  const added = await page.evaluate(async () =>
    (await window.desktop.workspace()).repositories.map((repo) => repo.name).sort(),
  );
  assert.deepEqual(added, ["portal", "recent-app"]);
});
