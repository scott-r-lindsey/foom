const { gitSync: isolatedGit } = require("../helpers/git.js");
const { AxeBuilder } = require("@axe-core/playwright");
const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, mkdtemp, readFile, realpath, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { deadline, expect } = require("./test-policy.js");
const {
  assertAccessible,
  boardCommand,
  boardPage,
  confirmationPage,
  fixtureCleanup,
  installSoundSink,
  launchApp,
  launchCheckoutShell,
  openSettingsScreen,
  quitAndWait,
  removeAfterApps,
  stopSession,
  tabTo,
} = require("./harness.js");

test("Environment settings reach a launched shell; main refuses reserved names", {
  timeout: deadline(45_000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  await page.waitForFunction(() => typeof window.desktop?.saveEnvironment === "function");
  const refused = await page.evaluate(() =>
    window.desktop
      .saveEnvironment({
        scope: "all",
        previous: null,
        name: "FOOM_CONTROL_TOKEN",
        value: "x",
        secret: false,
      })
      .then(
        () => "saved",
        (error) => String(error),
      ),
  );
  assert.match(refused, /foom-error:operation-failed/);
  const state = await page.evaluate(async () => {
    const save = (scope, name, value) =>
      window.desktop.saveEnvironment({ scope, previous: null, name, value, secret: false });
    await save("all", "HTTPS_PROXY", "http://127.0.0.1:9");
    await save("all", "NO_PROXY", ".corp.example");
    await save("codex", "AGENT_ONLY_215", "codex");
    return window.desktop.environmentState();
  });
  assert.deepEqual(
    state.lists.all.map((row) => row.name),
    ["HTTPS_PROXY", "NO_PROXY"],
  );
  const id = await page.evaluate(async () => {
    const terminal = await window.desktop.create(80, 24);
    window.environmentExited = false;
    window.desktop.onExit((exited) => {
      if (exited === terminal.id) window.environmentExited = true;
    });
    return terminal.id;
  });
  const command =
    process.platform === "win32"
      ? 'Write-Output ("ENV_" + "READ:" + $env:HTTPS_PROXY + "|" + $env:NO_PROXY + "|" + $env:AGENT_ONLY_215 + "|")'
      : 'printf \'ENV_%s:%s|%s|%s|\\n\' READ "$HTTPS_PROXY" "$NO_PROXY" "$AGENT_ONLY_215"';
  await page.evaluate(({ id, command }) => window.desktop.input(id, command + "; exit\r"), {
    id,
    command,
  });
  await page.waitForFunction(() => window.environmentExited);
  const line = (await page.evaluate((id) => window.desktop.tail(id, 40), id)).find((entry) =>
    entry.startsWith("ENV_READ:"),
  );
  assert.equal(line, "ENV_READ:http://127.0.0.1:9|.corp.example,localhost,127.0.0.1,::1||");
});

test("Settings transitions restore background fullscreen output repeatedly", {
  timeout: deadline(45000),
}, async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "foom-view-probe-"));
  removeAfterApps(context, directory);
  const marker = path.join(directory, "stage");
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  const hide = page.locator(".config-gear");
  const open = page.locator(".board-row[data-kind='shell']");
  await expect(hide).toBeEnabled();
  await page.evaluate(() => {
    window.viewChunks = 0;
    window.desktop.onData((id) => {
      window.viewId = id;
      window.viewChunks++;
    });
  });
  const command = `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${path.join(__dirname, "view-probe.js")}" "${marker}"`;
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
  const rows = page.locator(".xterm-rows");
  await expect(rows).toContainText("NORMAL_VIEW_READY");
  await openSettingsScreen(page);
  await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();
  await expect(open).toBeEnabled();
  await expect(page.locator(".tile-terminal")).toBeHidden();
  await page.evaluate(() => {
    window.viewChunks = 0;
    window.desktop.input(window.viewId, "a");
  });
  await expect.poll(() => readFile(marker, "utf8").catch(() => "pending")).toBe("alternate");
  assert.equal(await page.evaluate(() => window.viewChunks), 0);
  for (let cycle = 0; cycle < 4; cycle++) {
    await page.keyboard.press("Escape");
    await expect(page.getByRole("region", { name: "Settings" })).toBeHidden();
    await open.click();
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
    await expect(hide).toBeEnabled();
    await expect(rows).toContainText("ALTERNATE_HIDDEN_OUTPUT");
    await expect(rows).not.toContainText("NORMAL_VIEW_READY");
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
    await openSettingsScreen(page);
    await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();
    await expect(open).toBeEnabled();
  }
  await page.evaluate(() => window.desktop.input(window.viewId, "n"));
  await expect.poll(() => readFile(marker, "utf8")).toBe("normal");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Settings" })).toBeHidden();
  await open.click();
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await expect(hide).toBeEnabled();
  await expect(rows).toContainText("NORMAL_VIEW_READY");
  await expect(rows).toContainText("NORMAL_HIDDEN_OUTPUT");
  await expect(rows).not.toContainText("ALTERNATE_HIDDEN_OUTPUT");
  // Continue scrolling after restoration, including origin-relative positioning,
  // repeated attachments, and transitions between both buffers.
  for (const mode of ["a", "n", "a", "n"]) {
    await openSettingsScreen(page);
    await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();
    await expect(open).toBeEnabled();
    await page.evaluate((key) => window.desktop.input(window.viewId, key), mode);
    await expect.poll(() => readFile(marker, "utf8")).toBe(mode === "a" ? "alternate" : "normal");
    for (const setup of ["s", "o"]) {
      await page.evaluate((key) => window.desktop.input(window.viewId, key), setup);
      await expect.poll(() => readFile(marker, "utf8")).toBe(setup);
      for (let cycle = 0; cycle < 3; cycle++) {
        await page.keyboard.press("Escape");
        await expect(page.getByRole("region", { name: "Settings" })).toBeHidden();
        await open.click();
        await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
        await expect(hide).toBeEnabled();
        await expect(rows).toContainText("FOOTER");
        await page.keyboard.type("j");
        const expected = [
          "HEADER",
          ...Array(3 - Math.min(cycle, 3)).fill(""),
          ...Array(Math.min(cycle, 3)).fill("NEXT"),
          "NEXT",
          "FOOTER",
        ];
        if (cycle < 3) expected[3 - cycle] = "bottom";
        await expect
          .poll(() =>
            rows
              .locator(":scope > div")
              .evaluateAll((elements) =>
                elements.slice(0, 6).map((element) => element.textContent.trimEnd()),
              ),
          )
          .toEqual(expected);
        const tail = await page.evaluate(() => window.desktop.tail(window.viewId, 10000));
        assert.deepEqual(tail.slice(-6), expected);
        await openSettingsScreen(page);
        await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();
        await expect(open).toBeEnabled();
      }
    }
    await page.keyboard.press("Escape");
    await expect(page.getByRole("region", { name: "Settings" })).toBeHidden();
    await open.click();
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
    await expect(hide).toBeEnabled();
  }
  // Reopening restores interactive input as well as the screen.
  await page.keyboard.type("q");
});

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
  await expect(page.getByText("Not found")).toHaveCount(3, { timeout: deadline(20000) });
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

  // Install all three, then scan again.
  const script = (body) => `#!/usr/bin/env node\nconst a = process.argv[2];\n${body}\n`;
  const agents = {
    claude: script(
      'if (a === "--version") console.log("2.1.300 (Claude Code)"); else console.log("  --settings <file-or-json>");',
    ),
    codex: script(
      'if (a === "--version") console.log("codex-cli 0.155.1"); else console.log("  -c, --config <key=value>");',
    ),
    agy: script('if (a === "--version") console.log("1.2.13");'),
  };
  for (const [name, source] of Object.entries(agents)) {
    await writeFile(path.join(bin, name), source);
    await chmod(path.join(bin, name), 0o755);
  }
  await page.getByRole("button", { name: "Scan again" }).click();
  await expect(page.locator(".agent-version")).toHaveText(["2.1.300", "0.155.1", "1.2.13"]);
  await expect(page.locator(".agent-card")).toHaveCount(3);
  await expect(page.getByText(path.join(bin, "codex"), { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Hooks", exact: true })).toHaveCount(3);
  await expect(page.getByText("Notify + screen rules active", { exact: true })).toBeVisible();
  await assertPreflightFits(page, "Agent cards fit the scaled layout");
  await assertAccessible(page);
  await page.getByRole("button", { name: /Go \/ no-go/ }).click();
  await page.getByText("All stations go.").waitFor();
  await assertAccessible(page);
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
  if (process.env.FOOM_MANUAL_SCREENSHOTS === "1" && process.platform === "linux") {
    await mkdir("screenshots-680", { recursive: true });
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
        `screenshots-680/first-run-${mode}.png`,
      ]);
    }
    await page.evaluate(() => window.desktop.saveSetup({ colorMode: "system" }));
  }

  await page.evaluate((id) => window.desktop.previews.close(id), firstManual.id);
  await launchCheckoutShell(app, page);
  const shellRow = page.locator(".board-row[data-kind='shell']");
  await shellRow.waitFor({ timeout: deadline(10000) });
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
    forges: { github: true },
    forgeHosts: { "github.com": "github" },
    agyPluginOfferAnswered: false,
    setupComplete: true,
    hooks: true,
    restoreSessions: true,
    showNewChildren: true,
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

test("the board stays usable at 300% in a small window", async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  const shellRow = page.locator(".board-row[data-kind='shell']");
  await shellRow.waitFor({ timeout: deadline(10000) });
  await page.evaluate(() => window.desktop.saveSetup({ interfaceScale: 300 }));
  // CI displays vary, so size the window rather than the screen. The scaled minimum
  // would otherwise hold the window at the work area.
  const content = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
    window.setMinimumSize(1, 1);
    window.setContentSize(1280, 720);
    return { zoom: window.webContents.getZoomFactor(), ...window.getContentBounds() };
  });
  assert.equal(content.zoom, 3);
  await expect
    .poll(() =>
      page.evaluate(({ width, height }) => {
        const css = [
          Math.abs(window.innerWidth - width / 3),
          Math.abs(window.innerHeight - height / 3),
        ];
        return Math.max(...css);
      }, content),
    )
    .toBeLessThanOrEqual(1);
  // Boxes in CSS pixels that must stay inside the window, or across a scrolling container.
  const outside = (selector, container) =>
    page.evaluate(
      ({ selector, container }) => {
        const outer = container
          ? document.querySelector(container).getBoundingClientRect()
          : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
        return [...document.querySelectorAll(selector)]
          .filter((element) => element.getClientRects().length > 0)
          .filter((element) => {
            const box = element.getBoundingClientRect();
            return (
              box.left < outer.left - 1 ||
              box.right > outer.right + 1 ||
              (!container && (box.top < outer.top - 1 || box.bottom > outer.bottom + 1))
            );
          })
          .map((element) => element.className || element.textContent);
      },
      { selector, container },
    );
  const pageScrolls = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
  const scrollsWithin = (locator) =>
    locator.evaluate((root) => {
      const scroller = [root, ...root.querySelectorAll("*")].find(
        (element) =>
          element.scrollHeight > element.clientHeight + 1 &&
          /auto|scroll/.test(getComputedStyle(element).overflowY),
      );
      if (!scroller) return false;
      scroller.scrollTop = scroller.scrollHeight;
      return scroller.scrollTop > 0;
    });

  assert.equal(await pageScrolls(), false, "The page never scrolls horizontally");
  await expect(page.locator(".sidebar-shell")).toBeInViewport();
  await expect(shellRow).toBeInViewport();
  await expect(page.locator(".tile-terminal").first()).toBeInViewport({ ratio: 0.5 });
  assert.deepEqual(await outside(".sidebar-footer *", ".sidebar-shell"), []);

  // The row's sidebar panel opens inside the window.
  await shellRow.locator(".row-actions").click();
  await expect(page.locator(".row-menu")).toBeVisible();
  assert.deepEqual(await outside(".row-menu"), []);
  await page.keyboard.press("Escape");
  await expect(page.locator(".row-menu")).toHaveCount(0);

  // The shortcut sheet fits and scrolls within itself.
  await shellRow.focus();
  await expect(shellRow).toBeFocused();
  await boardCommand(app, "/", process.platform !== "darwin");
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet).toBeVisible();
  assert.deepEqual(await outside(".shortcut-sheet"), []);
  assert.deepEqual(await outside(".shortcut-columns dl > div", ".shortcut-sheet"), []);
  assert.equal(await scrollsWithin(sheet), true, "The shortcut sheet scrolls within itself");
  assert.equal(await pageScrolls(), false, "The shortcut sheet does not widen the page");
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  // Settings opens and scrolls within itself.
  await openSettingsScreen(page);
  const settings = page.getByRole("region", { name: "Settings" });
  await expect(settings).toBeVisible();
  assert.equal(await pageScrolls(), false, "Settings does not widen the page");
  assert.deepEqual(await outside(".settings-view"), []);
  assert.equal(await scrollsWithin(settings), true, "Settings scrolls within itself");
  await expect(settings.getByRole("button", { name: "Close settings (Esc)" })).toBeVisible();
  // Teardown quits through the real confirmation, which must settle at this size.
});

test("appearance switches light and dark, and zoom shortcuts resize the interface", async (context) => {
  const app = await launchApp(context, { fixture: "first-run" });
  const page = await boardPage(app);
  await page.getByRole("button", { name: "Start preflight" }).waitFor();
  // Exercise theme changes after the rows appear, independently of CI startup speed.
  await page.locator('.welcome-noise[data-phase="settled"]').waitFor();
  for (const [colorScheme, surface] of [
    ["light", "rgb(233, 228, 245)"],
    ["dark", "rgb(13, 10, 23)"],
  ]) {
    await page.emulateMedia({ colorScheme });
    await expect
      .poll(
        () =>
          page
            .locator(".welcome-sidebar")
            .evaluateAll((tiles) => tiles.map((tile) => getComputedStyle(tile).backgroundColor)),
        { message: "Row backgrounds must switch with text" },
      )
      .toEqual([surface]);
  }
  await page.emulateMedia({ colorScheme: null });
  const dark = () => page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches);
  const background = () =>
    page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);

  await page.getByRole("radio", { name: "Dark" }).check();
  // Media emulation from the loop above can linger; wait for the saved source itself.
  await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("dark");
  await expect.poll(dark).toBe(true);
  await expect.poll(background).toBe("rgb(5, 4, 10)");
  await assertAccessible(page);
  await page.getByRole("radio", { name: "Light" }).check();
  await expect.poll(dark).toBe(false);
  await expect.poll(background).toBe("rgb(243, 240, 250)");

  const zoom = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "app://bundle/index.html")
        .webContents.getZoomFactor(),
    );
  const press = (keyCode, shift) =>
    app.evaluate(
      ({ BrowserWindow }, { keyCode, shift, mac }) => {
        const window = BrowserWindow.getAllWindows().find(
          (window) => window.webContents.getURL() === "app://bundle/index.html",
        );
        window.focus();
        const modifiers = mac ? ["meta"] : ["control", ...(shift ? ["shift"] : [])];
        for (const type of ["keyDown", "keyUp"])
          window.webContents.sendInputEvent({ type, keyCode, modifiers });
      },
      { keyCode, shift, mac: process.platform === "darwin" },
    );
  const size = () =>
    app.evaluate(({ BrowserWindow }) => {
      const { width, height } = BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "app://bundle/index.html")
        .getBounds();
      return { width, height };
    });
  const start = await size();
  const grown = await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
    const bounds = window.getBounds();
    const content = window.getContentBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const [minimumWidth, minimumHeight] = window.getMinimumSize();
    // Native frames don't zoom; the scaled minimum and display constrain the result.
    return {
      width: Math.min(
        Math.max(
          Math.round(content.width * 1.1) + bounds.width - content.width,
          Math.round(minimumWidth * 1.1),
        ),
        area.width,
      ),
      height: Math.min(
        Math.max(
          Math.round(content.height * 1.1) + bounds.height - content.height,
          Math.round(minimumHeight * 1.1),
        ),
        area.height,
      ),
    };
  });
  await press("=", true);
  await expect.poll(zoom).toBeCloseTo(1.1);
  await page.getByText("110%").waitFor();
  // The window grows with the interface while the screen has room.
  await expect.poll(size).toEqual(grown);
  await page.getByRole("button", { name: "Larger" }).click();
  await expect.poll(zoom).toBeCloseTo(1.2);
  await press("0", true);
  await expect.poll(zoom).toBeCloseTo(1);
  await page.getByText("100%").waitFor();
  // And returns to exactly its starting size.
  await expect.poll(size).toEqual(start);
  await assertAccessible(page);
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

test("Settings shares live preflight values, sizes the terminal and restores keyboard focus", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-settings-repositories-"));
  removeAfterApps(context, root);
  const repository = path.join(root, "settings-example");
  await mkdir(repository);
  isolatedGit(["init", "-q", repository]);
  const app = await launchApp(context, { fixture: "running-shell" });
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, root);
  const page = await boardPage(app);
  const shortcut = async () => {
    await boardCommand(app, ",", process.platform !== "darwin");
    // Native input dispatch returns before React's mount effects finish. Visibility
    // alone does not mean the Escape listener is installed or focus has moved.
    await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "General", exact: true })).toBeFocused();
  };
  const row = page.locator('.board-row[data-kind="shell"]');
  await boardCommand(app, "B");
  await expect(row).toBeFocused();
  await page.keyboard.press("Enter");
  await page.locator(".xterm-helper-textarea").waitFor();
  await shortcut();
  await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Terminal sidebar" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Terminal pane" })).toBeHidden();
  const tabToControl = async (control) => {
    await expect(control).toBeVisible();
    await expect(control).toBeEnabled();
    for (let step = 0; step < 50; step++) {
      await page.keyboard.press("Tab");
      if (await control.evaluate((element) => document.activeElement === element)) return;
    }
    throw new Error("Settings control is not reachable with Tab");
  };
  const nextSelectOption = async (control, value) => {
    await tabToControl(control);
    if (process.platform === "darwin") {
      // macOS native select popups do not consume synthetic web keyboard events:
      // https://github.com/electron/electron/issues/12513
      // Still verify Tab reachability, DOM change handling, and persistence here;
      // Linux and Windows exercise selection entirely through the keyboard.
      await control.selectOption(value);
    } else {
      await page.keyboard.press("Space");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
    }
    await expect(control).toHaveValue(value);
    await page.keyboard.press("Tab");
  };
  const section = async (name) => {
    await tabTo(page, name);
    await page.keyboard.press("Enter");
  };
  await section("Agents");
  const hooks = page.getByLabel("Attach hooks", { exact: false });
  await tabToControl(hooks);
  await page.keyboard.press("Space");
  await expect
    .poll(() => page.evaluate(async () => (await window.desktop.setupState()).settings.hooks))
    .toBe(false);
  await section("Repositories");
  await page.getByRole("button", { name: "Choose folder…" }).waitFor();
  await tabTo(page, "Choose folder…");
  await page.keyboard.press("Enter");
  const added = page.getByRole("checkbox", { name: /settings-example/ });
  await expect(added).not.toBeChecked();
  await tabToControl(added);
  await page.keyboard.press("Space");
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.desktop.workspace()).repositories.map((repo) => repo.name),
      ),
    )
    .toContain("settings-example");
  await section("General");
  await tabToControl(page.getByRole("radio", { name: /Keep worktrees/ }));
  await page.keyboard.press("ArrowDown");
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.worktreeLocation),
    )
    .toBe("adjacent");
  await section("Appearance");
  await tabToControl(page.getByRole("radio", { name: "System", exact: true }));
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await tabTo(page, "+", "Larger");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "110%" })).toBeVisible();
  await section("Terminal");
  const font = page.getByLabel("Terminal font size");
  await nextSelectOption(font, "15");
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.terminalFontSize),
    )
    .toBe(15);
  await page.keyboard.press("Escape");

  await expect(row).toBeFocused();
  await expect(page.locator(".xterm-rows")).toHaveCSS("font-size", "15px");
  await shortcut();
  await section("Appearance");
  await expect(page.getByRole("radio", { name: "Dark", exact: true })).toBeChecked();
  await expect(page.getByRole("status").filter({ hasText: "110%" })).toBeVisible();
  await page.getByRole("radio", { name: "Light", exact: true }).check();
  await page.getByRole("button", { name: "Larger", exact: true }).click();
  await page.keyboard.press("Escape");
  await shortcut();
  await section("Appearance");
  await expect(page.getByRole("radio", { name: "Light", exact: true })).toBeChecked();
  await expect(page.getByRole("status").filter({ hasText: "120%" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(row).toBeFocused();
  // The close control stays at the top right in both layouts and scales with zoom.
  for (const scale of [100, 150, 300]) {
    await page.evaluate((interfaceScale) => window.desktop.saveSetup({ interfaceScale }), scale);
    const bounds = await app.evaluate(({ BrowserWindow }, scale) => {
      const window = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "app://bundle/index.html",
      );
      window.setMinimumSize(1, 1);
      window.setContentSize(scale === 100 ? 1400 : 1000, 720);
      return window.getContentBounds();
    }, scale);
    await expect
      .poll(() => page.evaluate(() => window.innerWidth))
      .toBeCloseTo(bounds.width / (scale / 100), 0);
    await shortcut();
    const close = page.getByRole("button", { name: "Close settings (Esc)", exact: true });
    await expect(close).toHaveCount(1);
    await expect(close).toHaveAttribute("title", "Close settings (Esc)");
    await expect(close).toBeInViewport();
    if (scale > 100) {
      const navigation = page.getByRole("navigation", { name: "Settings sections" });
      assert.equal(
        await navigation.evaluate((element) => element.scrollHeight > element.clientHeight + 1),
        false,
        "Compact Settings sections scroll with the page",
      );
    }
    const geometry = await close.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const root = element.closest(".settings-view");
      const settings = root.getBoundingClientRect();
      return {
        width: box.width,
        height: box.height,
        top: box.top - settings.top,
        right: settings.left + root.clientLeft + root.clientWidth - box.right,
      };
    });
    assert.ok(geometry.width >= 32 && geometry.height >= 32);
    assert.ok(geometry.top >= 0 && geometry.top <= 12);
    assert.ok(geometry.right >= 0 && geometry.right <= 16);
    const firstSection = page.getByRole("button", { name: "General", exact: true });
    await expect(firstSection).toBeEnabled();
    await firstSection.focus();
    await expect(firstSection).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(close).toBeFocused();
    assert.equal(await close.evaluate((element) => element.matches(":focus-visible")), true);
    const focus = await close.evaluate((element) => {
      const style = getComputedStyle(element);
      const ink = getComputedStyle(element.closest(".settings-view")).color;
      return { color: style.color, ink, outline: style.outlineStyle, width: style.outlineWidth };
    });
    assert.equal(focus.color, focus.ink);
    assert.notEqual(focus.outline, "none");
    assert.notEqual(focus.width, "0px");
    await page.keyboard.press("Tab");
    await expect(firstSection).toBeFocused();
    await close.hover();
    await expect(close).toHaveCSS("color", focus.ink);
    await page.mouse.move(0, 0);
    assert.notEqual(await close.evaluate((element) => getComputedStyle(element).color), focus.ink);
    const screenshot = await app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "app://bundle/index.html",
      );
      return (await window.webContents.capturePage()).toPNG().toString("base64");
    });
    await writeFile(`test-results/settings-close-${scale}.png`, Buffer.from(screenshot, "base64"));
    await close.click();
    await expect(page.getByRole("region", { name: "Settings" })).toBeHidden();
    await expect(row).toBeFocused();
    await shortcut();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("region", { name: "Settings" })).toBeHidden();
    await expect(row).toBeFocused();
  }
  assert.deepEqual(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .map((window) => ({ url: window.webContents.getURL(), visible: window.isVisible() }))
        .sort((a, b) => a.url.localeCompare(b.url)),
    ),
    [
      { url: "app://bundle/index.html", visible: true },
      { url: "app://confirmation/confirmation.html", visible: false },
    ],
  );
});

test("every Settings section passes axe in light and dark, including the narrow layout", async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  await openSettingsScreen(page);
  for (const name of [
    "General",
    "Agents",
    "Repositories",
    "Appearance",
    "Terminal",
    "Themes",
    "Sound",
  ]) {
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name, exact: true })
      .click();
    await assertAccessible(page);
  }
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
    // Exercise compact layouts as on a display smaller than the normal minimum.
    window.setMinimumSize(0, 0);
    window.setSize(640, 640);
  });
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await assertAccessible(page);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
});

test("window size defaults to 60 percent and survives a normal quit and relaunch", async (context) => {
  const profile = await mkdtemp(path.join(tmpdir(), "foom-window-size-"));
  removeAfterApps(context, profile);
  const options = { args: [`--user-data-dir=${profile}`], fixture: "empty-board" };
  const app = await launchApp(context, options);
  const initial = await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
    const area = screen.getPrimaryDisplay().workAreaSize;
    return { size: window.getSize(), area };
  });
  assert.deepEqual(initial.size, [
    Math.min(initial.area.width, Math.max(900, Math.round(initial.area.width * 0.6))),
    Math.min(initial.area.height, Math.max(640, Math.round(initial.area.height * 0.6))),
  ]);
  await app.evaluate(({ BrowserWindow, screen }) => {
    const area = screen.getPrimaryDisplay().workAreaSize;
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setSize(Math.min(1200, area.width), Math.min(850, area.height));
  });
  const size = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .getSize(),
  );
  await quitAndWait(app, () => app.evaluate(({ app }) => app.quit()));
  assert.deepEqual(JSON.parse(await readFile(path.join(profile, "window-size.json"), "utf8")), {
    width: size[0],
    height: size[1],
  });
  const restored = await launchApp(context, { ...options, fixture: "restored" });
  assert.deepEqual(
    await restored.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "app://bundle/index.html")
        .getSize(),
    ),
    size,
  );
  await quitAndWait(restored, () => restored.evaluate(({ app }) => app.quit()));
});

test("every interface theme applies live to native chrome and passes axe on board and Settings", {
  timeout: deadline(55000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  const choices = [
    ["eclipse-light", "Eclipse Light", "light", "#f3f0fa"],
    ["eclipse-dark", "Eclipse Dark", "dark", "#05040a"],
    ["high-contrast", "High Contrast", "dark", "#000000"],
    ["deep-field", "Deep Field", "dark", "#080f1e"],
    ["moonlight", "Moonlight", "light", "#f5f7fc"],
    ["graphite", "Graphite", "dark", "#18181b"],
    ["midnight-indigo", "Midnight Indigo", "dark", "#101027"],
  ];
  for (const [id, name, base, background] of choices) {
    await boardCommand(app, ",", process.platform !== "darwin");
    await page.getByRole("button", { name: "Themes", exact: true }).click();
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.getByRole("button", { name, exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.desktop.setupState()).settings.interfaceTheme),
      )
      .toBe(id);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--bg")))
      .toBe(background);
    assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), base);
    assert.equal(
      (
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((window) => window.webContents.getURL() === "app://bundle/index.html")
            .getBackgroundColor(),
        )
      ).toLowerCase(),
      background,
    );
    await expect(
      page.getByRole("list", { name: "Terminal status previews" }).getByRole("listitem"),
    ).toHaveCount(5);
    const expectedHighlight = {
      "deep-field": "#6cc7ff",
      graphite: "#9fb1c7",
      moonlight: "#2f5fbf",
    }[id];
    const colors = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const preview = document.querySelector(".interface-theme-preview");
      const selected = document.querySelector(
        '.interface-theme-choices button[aria-pressed="true"]',
      );
      const working = preview.querySelector('[data-state="working"] .board-light');
      const cssColor = (hex) => {
        const node = document.createElement("span");
        node.style.color = hex;
        return node.style.color;
      };
      const accent = root.getPropertyValue("--accent").trim();
      const highlight = root.getPropertyValue("--highlight").trim();
      return {
        accent,
        highlight,
        highlightRgb: cssColor(highlight),
        accentRgb: cssColor(accent),
        selection: getComputedStyle(selected).outlineColor,
        swatch: getComputedStyle(selected.querySelectorAll("i")[3]).backgroundColor,
        working: getComputedStyle(working).backgroundColor,
        brand: getComputedStyle(document.querySelector(".wordmark")).color,
        inkRgb: cssColor(root.getPropertyValue("--ink").trim()),
      };
    });
    assert.equal(colors.highlight, expectedHighlight ?? colors.accent);
    assert.equal(colors.selection, colors.highlightRgb);
    assert.equal(colors.swatch, colors.highlightRgb);
    assert.equal(colors.working, colors.accentRgb);
    assert.equal(colors.brand, colors.inkRgb);
    await assertAccessible(page);
    await page.keyboard.press("Escape");
    await expect(page.locator(".tile-terminal")).toBeVisible();
    await expect(page.locator('.terminal-tile[data-focused="true"]')).toHaveCSS(
      "border-color",
      colors.highlightRgb,
    );
    await assertAccessible(page);
  }
  await boardCommand(app, ",", process.platform !== "darwin");
  await page.getByRole("button", { name: "Themes", exact: true }).click();
  await page.getByRole("button", { name: /^System/ }).click();
  await expect
    .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
    .toBe("system");
  for (const [colorScheme, expected] of [
    ["dark", "#05040a"],
    ["light", "#f3f0fa"],
  ]) {
    await page.emulateMedia({ colorScheme });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--bg")))
      .toBe(expected);
  }
  await page.emulateMedia({ colorScheme: null });
  await page.getByRole("button", { name: "High Contrast", exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
    window.setMinimumSize(0, 0);
    window.setSize(640, 640);
  });
  await assertAccessible(page);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
});

test("volume sliders keep the dragged value while sound saves settle", async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  fixtureCleanup(context).apps.unshift(async () => {
    await app.evaluate(() => globalThis.soundSaveRestore?.()).catch(() => {});
  });
  const page = await boardPage(app);
  // Hold real persistence at the service boundary, then deliver its actual
  // settings broadcasts and replies after the pointer has moved farther.
  await app.evaluate(({ app }) => {
    const load = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const { Setup } = load("./build/main/setup/setup.js");
    const save = Setup.prototype.save;
    globalThis.soundSaveGates = [];
    globalThis.soundSaveCount = 0;
    globalThis.soundSaveRestore = () => {
      Setup.prototype.save = save;
      for (const release of globalThis.soundSaveGates.splice(0)) release();
    };
    Setup.prototype.save = async function (patch) {
      if (patch.sound) {
        globalThis.soundSaveCount++;
        await new Promise((resolve) => globalThis.soundSaveGates.push(resolve));
      }
      return save.call(this, patch);
    };
  });
  await openSettingsScreen(page);
  await page.getByRole("button", { name: "Sound", exact: true }).click();
  const working = page.getByLabel("Working volume", { exact: true });
  await working.scrollIntoViewIfNeeded();
  const box = await working.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(working).toHaveValue("100");
  await expect.poll(() => app.evaluate(() => globalThis.soundSaveCount)).toBe(1);
  await app.evaluate(() => globalThis.soundSaveGates.shift()());
  await expect.poll(() => app.evaluate(() => globalThis.soundSaveCount)).toBe(2);
  await expect(working).toHaveValue("100");
  await expect(page.getByText("Working volume · 100%", { exact: true })).toBeVisible();
  await app.evaluate(() => globalThis.soundSaveGates.shift()());
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.sound.workingVolume),
    )
    .toBe(1);

  const alerts = page.getByLabel("Alert volume", { exact: true });
  await alerts.press("Home");
  // The preceding save may have persisted before its renderer reply settled.
  // Wait until this edit is in flight before queuing edits behind its gate.
  await expect.poll(() => app.evaluate(() => globalThis.soundSaveCount)).toBe(3);
  await alerts.press("ArrowRight");
  await alerts.press("ArrowRight");
  await expect(alerts).toHaveValue("2");
  await alerts.press("Escape");
  await expect(alerts).toHaveCount(0);
  await app.evaluate(() => globalThis.soundSaveGates.shift()());
  await expect.poll(() => app.evaluate(() => globalThis.soundSaveCount)).toBe(4);
  await app.evaluate(() => globalThis.soundSaveGates.shift()());
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.sound.alertVolume),
    )
    .toBe(0.02);
});

test("recorded sounds refresh and preview user files while shell attention and completion stay silent", {
  timeout: deadline(45000),
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-sound-"));
  removeAfterApps(context, root);
  const marker = path.join(root, "keys");
  // Deliberately differ from Electron's home, proving the fixture does not rely
  // on the environment override that only worked on Linux.
  const shellHome = path.join(root, "shell-home");
  await mkdir(shellHome);
  const app = await launchApp(context, {
    fixture: "running-shell",
    home: root,
    env: { HOME: shellHome, USERPROFILE: shellHome },
  });
  const page = await boardPage(app);
  await installSoundSink(page);
  // Working audio is enabled, but this plain shell must contribute no loop.
  await page.evaluate(async () => {
    const { settings } = await window.desktop.setupState();
    await window.desktop.saveSetup({ sound: { ...settings.sound, working: true } });
  });
  await page.evaluate(() => {
    window.soundTerminal = undefined;
    window.desktop.onData((id) => {
      window.soundTerminal = id;
    });
  });
  // Reload reattaches the terminal asynchronously. Use the board action that
  // waits for attachment before focusing, instead of focusing its early markup.
  await page.locator(".board-row[data-kind='shell']").press("Enter");
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.type(
    `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${path.join(__dirname, "input-probe.js")}" "${marker}"; exit`,
  );
  await page.keyboard.press("Enter");
  // Capture its ID before Settings detaches the view and stops output delivery.
  await page.waitForFunction(() => typeof window.soundTerminal === "string");
  // Hide the terminal before its verdict settles; settings keeps the source subscribed.
  await boardCommand(app, ",", process.platform !== "darwin");
  await page.getByRole("button", { name: "Sound", exact: true }).click();
  await expect(page.locator(".board-row")).toHaveAttribute("data-state", "needs_input");
  // Silence must persist past the alert settling/debounce window.
  await page.waitForTimeout(2200);
  assert.deepEqual(await page.evaluate(() => window.soundTones), []);
  await assertAccessible(page);
  const home = await app.evaluate(({ app }) => app.getPath("home"));
  assert.equal(await realpath(home), await realpath(root));
  const sample = Buffer.alloc(44 + 8000); // 0.25 s mono PCM, 16 kHz
  sample.write("RIFF");
  sample.writeUInt32LE(sample.length - 8, 4);
  sample.write("WAVEfmt ", 8);
  sample.writeUInt32LE(16, 16);
  sample.writeUInt16LE(1, 20);
  sample.writeUInt16LE(1, 22);
  sample.writeUInt32LE(16000, 24);
  sample.writeUInt32LE(32000, 28);
  sample.writeUInt16LE(2, 32);
  sample.writeUInt16LE(16, 34);
  sample.write("data", 36);
  sample.writeUInt32LE(8000, 40);
  for (let i = 0; i < 4000; i++)
    sample.writeInt16LE(Math.round(2000 * Math.sin(i * 0.2)), 44 + i * 2);
  await writeFile(path.join(home, ".foom/config/sounds/done/test-bell.wav"), sample);
  await expect(page.getByRole("option", { name: "Test bell", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.getByRole("button", { name: "Sound", exact: true }).click();
  await page.screenshot({ path: path.join(__dirname, "../../test-results/sound-settings.png") });
  await page.getByLabel("Done sound", { exact: true }).selectOption("user:test-bell.wav");
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.sound.choices.done),
    )
    .toEqual({ source: "user", file: "test-bell.wav" });
  await page.getByRole("button", { name: "Preview done", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.soundTones)).toEqual([0.25]);
  // The launch command queues exit after the probe, avoiding input before PowerShell
  // has resumed. Process exit is a Done verdict on every supported platform.
  await page.evaluate(() => window.desktop.input(window.soundTerminal, "q"));
  await expect(page.locator(".board-row")).toHaveAttribute("data-state", "shell");
  await expect(page.locator(".board-row")).toHaveAttribute("data-exited", "true");
  await page.waitForTimeout(2200);
  assert.deepEqual(await page.evaluate(() => window.soundTones), [0.25]);
  await page.getByLabel("Alerts on", { exact: true }).uncheck();
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.sound.alerts),
    )
    .toBe(false);
});

test("Settings persists literal agent defaults and discloses bypass once per agent", {
  timeout: deadline(60_000),
}, async (context) => {
  const { copyFile, chmod } = require("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "foom-default-args-"));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  const output = path.join(root, "argv.json");
  await Promise.all([bin, home, repo].map((directory) => mkdir(directory)));
  // A real Node executable is a cross-platform fixture agent. Its unrecognized version
  // falls back to output evaluation; --eval records execArgv plus positional argv.
  const executable = path.join(bin, process.platform === "win32" ? "claude.exe" : "claude");
  await copyFile(process.execPath, executable);
  await chmod(executable, 0o755);
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
  const profile = path.join(root, "profile");
  const app = await launchApp(context, {
    fixture: "agent",
    args: [`--user-data-dir=${profile}`],
    env: { HOME: home, PATH: bin, TEST_ARGV: output },
  });
  const page = await boardPage(app);
  await app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
  }, repo);
  const repository = await page.evaluate(() => window.desktop.addRepository());
  assert.ok(repository);
  await openSettingsScreen(page);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  const input = page.getByLabel("Claude Code default arguments");
  await expect(input).toBeVisible();
  await input.fill("--settings={}");
  await input.blur();
  await expect(page.locator(".agent-card [role=alert]")).toHaveText("Unable to update settings.");
  const args = [
    "--eval",
    'require("node:fs").writeFileSync(process.env.TEST_ARGV, JSON.stringify([...process.execArgv, ...process.argv.slice(1)])); setInterval(() => {}, 1000)',
    "value with spaces",
    "'literal quotes'",
    "$(not-a-command); &",
    "--dangerously-skip-permissions",
  ];
  await input.fill(`${args.join("\r\n")}\r\n\r\n`);
  await input.blur();
  const disclosure = await confirmationPage(app);
  await expect(disclosure.getByRole("alertdialog")).toHaveAccessibleName(
    "Save bypass defaults for Claude Code?",
  );
  await expect(disclosure.getByRole("alertdialog")).toContainText(
    "A worktree is not a sandbox. With these arguments, the agent can act as you anywhere on the machine.",
  );
  await expect(disclosure.getByRole("button", { name: "Cancel" })).toBeFocused();
  const disclosureScan = await new AxeBuilder({ page: disclosure }).setLegacyMode().analyze();
  assert.deepEqual(disclosureScan.violations, []);
  await disclosure.keyboard.press("Enter");
  await expect(page.locator(".agent-card [role=alert]")).toHaveText("Unable to update settings.");
  assert.deepEqual(
    (await page.evaluate(() => window.desktop.setupState())).settings.agentArguments.claude,
    [],
  );
  await input.focus();
  await input.blur();
  await disclosure.getByRole("button", { name: "Save bypass defaults", exact: true }).click();
  // Errors clear and the disclosure closes before saving finishes. The field stays
  // disabled until saveSetup settles, including both config and profile writes.
  await expect(input).toBeEnabled();
  await expect(page.locator(".agent-card [role=alert]")).toHaveCount(0);
  await input.blur();
  await expect(page.locator(".agent-card [role=alert]")).toHaveCount(0);
  await expect(disclosure.getByRole("alertdialog")).toHaveCount(0);
  const persisted = JSON.parse(
    await readFile(path.join(profile, "settings.json"), "utf8"),
  ).settings;
  assert.equal(persisted.agentArguments, undefined);
  const configArguments = JSON.parse(
    await readFile(path.join(home, ".foom/config/settings.json"), "utf8"),
  ).agentArguments;
  assert.deepEqual(configArguments.claude, args);
  assert.equal(persisted.agentBypassAcknowledged.claude, true);
  await assertAccessible(page);
  await page.keyboard.press("Escape");
  await page.evaluate(
    (repo) =>
      window.desktop.sidebarCommand({
        kind: "launch",
        repository: repo,
        worktree: repo,
        run: "claude",
      }),
    repository.path,
  );
  await expect
    .poll(async () => {
      try {
        return JSON.parse(await readFile(output, "utf8"));
      } catch {
        return null;
      }
    })
    .toEqual(args);
  await expect(page.locator(".session-bypass")).toHaveText("◇ Bypass");
  await page.evaluate(() =>
    window.desktop.saveSetup({ agentArguments: { claude: [], codex: [], agy: [] } }),
  );
  await expect(page.locator(".session-bypass")).toHaveText("◇ Bypass");
});

test("neutral identity badges keep labels and geometry across themes and interface scales", async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  const basePixelRatio = await page.evaluate(() => window.devicePixelRatio);
  const row = page.locator('.board-row[data-kind="shell"]');
  await expect(row).toBeVisible();
  await row.press("F2");
  await page.getByRole("textbox", { name: "Session name" }).fill("Build helper");
  await page.getByRole("textbox", { name: "Session name" }).press("Enter");
  await expect(row).toHaveAccessibleName(/Build helper · Shell \(.+\)/);
  await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  await expect(row.locator(".board-agent")).toHaveCount(1);
  await expect(row.locator(".board-agent")).toBeVisible();
  await row.press("F2");
  await expect(page.getByRole("textbox", { name: "Session name", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Session name", exact: true }).press("Escape");
  await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    for (const interfaceScale of [80, 90, 100, 110, 120, 130, 140, 150]) {
      await page.evaluate(
        (interfaceScale) => window.desktop.saveSetup({ interfaceScale }),
        interfaceScale,
      );
      // Saving settings acknowledges main; Chromium applies zoom asynchronously.
      // Observe the renderer's actual zoom before checking geometry or advancing again.
      await expect
        .poll(() => page.evaluate(() => window.devicePixelRatio), {
          message: `${colorScheme} theme at ${interfaceScale}% renderer zoom`,
        })
        .toBeCloseTo((basePixelRatio * interfaceScale) / 100, 5);
      await row.focus();
      await expect(page.getByRole("complementary", { name: "Terminal peek" })).toHaveCount(0);
      await expect(row).toHaveAccessibleName(/Build helper · Shell \(.+\)/);
      const badge = row.locator(".board-agent");
      await expect(badge).toHaveText(">_");
      await expect(badge).toBeVisible();
      await expect
        .poll(
          () =>
            badge.evaluate((element) =>
              Math.max(
                Math.abs(parseFloat(getComputedStyle(element).height) - 20),
                Math.abs(parseFloat(getComputedStyle(element.firstElementChild).height) - 16),
              ),
            ),
          { message: `${colorScheme} badge geometry at ${interfaceScale}%` },
        )
        .toBeLessThan(0.1);
      await expect
        .poll(
          () =>
            badge.evaluate((element) => {
              const style = getComputedStyle(element);
              return (
                element.clientWidth >= element.scrollWidth &&
                style.backgroundColor ===
                  getComputedStyle(document.querySelector(".tile-title .board-agent"))
                    .backgroundColor &&
                style.fontFamily.includes("Geist Mono") &&
                element.querySelectorAll("img, svg").length === 0
              );
            }),
          { message: `${colorScheme} badge layout and styling at ${interfaceScale}%` },
        )
        .toBe(true);
      if (process.env.FOOM_SCREENSHOTS && [80, 100, 150].includes(interfaceScale))
        await page.screenshot({
          path: path.join(
            __dirname,
            `../../test-results/badges-${colorScheme}-${interfaceScale}.png`,
          ),
        });
    }
  }
  await page.evaluate(() => window.desktop.saveSetup({ interfaceScale: 100 }));
  await assertAccessible(page);
});

test("custom theme files appear live, update selected colors and retain rejected edits", {
  timeout: deadline(45000),
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-custom-theme-"));
  removeAfterApps(context, root);
  const app = await launchApp(context, { fixture: "empty-board", home: root });
  const page = await boardPage(app);
  await boardCommand(app, ",", process.platform !== "darwin");
  await page.getByRole("button", { name: "Themes", exact: true }).click();
  const { interfaceThemes } = require("../../build/shared/interface-themes.js");
  const { terminalThemes, ansiNames } = require("../../build/shared/terminal-themes.js");
  const file = path.join(root, ".foom/config/themes/custom.json");
  const palette = interfaceThemes["eclipse-dark"];
  const theme = { kind: "theme", name: "Live custom", base: palette.base, colors: palette.colors };
  await writeFile(file, JSON.stringify(theme));
  await page.getByRole("button", { name: "Live custom", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--bg")))
    .toBe(palette.colors.bg);
  theme.colors = interfaceThemes.graphite.colors;
  await writeFile(file, JSON.stringify(theme));
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--bg")))
    .toBe(theme.colors.bg);
  await writeFile(
    file,
    JSON.stringify({ ...theme, colors: { ...theme.colors, accent: "url(https://example.org)" } }),
  );
  await expect(page.getByRole("status").filter({ hasText: "Rejected custom.json" })).toContainText(
    "$.colors.accent: not-a-color",
  );
  assert.equal(
    await page.evaluate(() => document.documentElement.style.getPropertyValue("--bg")),
    theme.colors.bg,
  );
  assert.equal(
    await page.evaluate(async () => (await window.desktop.setupState()).settings.interfaceTheme),
    "user:custom.json",
  );
  await page.getByRole("button", { name: "Themes", exact: true }).click();
  const terminal = terminalThemes.dracula;
  const terminalFile = path.join(root, ".foom/config/terminal-themes/custom.json");
  const terminalTheme = {
    kind: "terminal-theme",
    name: "Live terminal",
    background: terminal.background,
    foreground: terminal.foreground,
    cursor: terminal.cursor,
    ansi: ansiNames.map((key) => terminal[key]),
  };
  await writeFile(terminalFile, JSON.stringify(terminalTheme));
  await page.getByRole("button", { name: "Live terminal", exact: true }).click();
  const choicesBounds = await page.getByRole("group", { name: "Terminal colors" }).boundingBox();
  const previewBounds = await page.getByLabel("Terminal theme preview").boundingBox();
  assert.ok(choicesBounds && previewBounds);
  assert.ok(previewBounds.x > choicesBounds.x, "terminal preview stays beside the picker");
  assert.ok(
    Math.abs(previewBounds.y - choicesBounds.y) < 2,
    "preview and picker share the top row",
  );
  await expect(page.getByLabel("Terminal theme preview")).toHaveCSS(
    "background-color",
    "rgb(40, 42, 54)",
  );
  terminalTheme.background = "#101010";
  await writeFile(terminalFile, JSON.stringify(terminalTheme));
  await expect(page.getByLabel("Terminal theme preview")).toHaveCSS(
    "background-color",
    "rgb(16, 16, 16)",
  );
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.style.getPropertyValue("--terminal-background")),
    )
    .toBe("#101010");
  await writeFile(terminalFile, "{");
  await expect(
    page
      .locator(".terminal-theme-picker-column")
      .getByRole("status")
      .filter({ hasText: "Rejected custom.json" }),
  ).toContainText("malformed-json");
  await expect(page.getByLabel("Terminal theme preview")).toHaveCSS(
    "background-color",
    "rgb(16, 16, 16)",
  );
  await page.screenshot({ path: path.join(__dirname, "../../test-results/custom-theme.png") });
});

test("legacy inference profiles upgrade without evaluator controls or stored keys", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-legacy-profile-"));
  removeAfterApps(context, root);
  await writeFile(
    path.join(root, "settings.json"),
    JSON.stringify({
      version: 1,
      settings: {
        setupComplete: true,
        hooks: false,
        worktreeLocation: "adjacent",
        interfaceScale: 110,
        inference: { kind: "openai", model: "saved-model" },
        inferenceTimeoutMs: 15000,
      },
    }),
  );
  for (const provider of ["anthropic", "openai", "google"])
    await writeFile(path.join(root, `inference-${provider}.key`), Buffer.from([0, 128, 255]));
  const temporary = path.join(
    root,
    "inference-openai.key.12345678-1234-4234-8234-123456789abc.tmp",
  );
  await writeFile(temporary, Buffer.from([0, 128, 255]));
  const app = await launchApp(context, {
    fixture: "empty-board",
    args: [`--user-data-dir=${root}`],
  });
  const page = await boardPage(app);
  const state = await page.evaluate(() => window.desktop.setupState());
  assert.equal(state.settings.hooks, false);
  assert.equal(state.settings.worktreeLocation, "adjacent");
  assert.equal(state.settings.interfaceScale, 110);
  assert.equal("inference" in state.settings, false);
  assert.equal("inferenceTimeoutMs" in state.settings, false);
  assert.equal("keys" in state, false);
  for (const provider of ["anthropic", "openai", "google"])
    await assert.rejects(readFile(path.join(root, `inference-${provider}.key`)), {
      code: "ENOENT",
    });
  await assert.rejects(readFile(temporary), { code: "ENOENT" });
  assert.doesNotMatch(await readFile(path.join(root, "settings.json"), "utf8"), /inference/);
  assert.deepEqual(
    await page.evaluate(() =>
      Object.keys(window.desktop).filter((key) => /inference|localModels/i.test(key)),
    ),
    [],
  );
  await openSettingsScreen(page);
  await page.getByRole("navigation", { name: "Settings sections" }).waitFor();
  await expect(page.getByText(/Evaluator|Run check|API key/)).toHaveCount(0);
  await page.evaluate(() => window.desktop.saveSetup({ setupComplete: false }));
  await page.reload();
  await page.getByRole("button", { name: "Start preflight" }).waitFor();
  const steps = page.getByRole("navigation", { name: "Preflight steps" }).locator("ol");
  await expect(steps.getByRole("button")).toHaveText([
    "Welcome",
    "T-2Agents",
    "T-1Repositories",
    "T-0Go / no-go",
  ]);
  assert.equal(
    (await page.evaluate(() => window.desktop.setupState())).settings.worktreeLocation,
    "adjacent",
  );
  await expect(page.getByText(/Evaluator|Run check|API key/)).toHaveCount(0);
});

test("sidebar config agent menu launches a new config session in each window", {
  timeout: deadline(60_000),
}, async (context) => {
  const { chmod, copyFile } = require("node:fs/promises");
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-config-menu-")));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  await Promise.all([bin, home].map((directory) => mkdir(directory)));
  const executable = path.join(bin, process.platform === "win32" ? "claude.exe" : "claude");
  await copyFile(process.execPath, executable);
  await chmod(executable, 0o755);
  const app = await launchApp(context, { fixture: "agent", home, env: { HOME: home, PATH: bin } });
  const first = await boardPage(app);
  await first.evaluate(() =>
    window.desktop.saveSetup({
      agents: { claude: true, codex: false, agy: false },
      agentArguments: {
        claude: [
          "--eval",
          "console.log('CONFIG_MENU_READY '+JSON.stringify(process.argv.slice(1)));process.stdin.resume()",
        ],
        codex: [],
        agy: [],
      },
    }),
  );
  await openSettingsScreen(first);
  await expect(first.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await first.locator(".config-gear").click();
  await expect(first.getByRole("menuitem", { name: "Via Codex" })).toHaveCount(0);
  if (process.env.FOOM_UI_SCREENSHOTS)
    await first.screenshot({
      path: path.join(process.env.FOOM_UI_SCREENSHOTS, "sidebar-config-via-agent.png"),
      animations: "disabled",
    });
  await first.getByRole("menuitem", { name: "Via Claude Code" }).focus();
  await first.getByRole("menuitem", { name: "Via Claude Code" }).press("Enter");
  await expect(first.getByRole("heading", { name: "Settings", exact: true })).toHaveCount(0);
  await expect(first.locator(".terminal-tile[data-empty=false]")).toHaveCount(1);
  let id;
  await expect
    .poll(async () => {
      const sessions = (await first.evaluate(() => window.desktop.workspace())).terminals;
      id = sessions.find((session) => session.config)?.id;
      return id;
    })
    .toBeTruthy();
  await expect
    .poll(async () =>
      first.evaluate(async (id) => (await window.desktop.tail(id, 40)).join("\n"), id),
    )
    .toContain("CONFIG_MENU_READY");
  assert.equal(
    (await first.evaluate(() => window.desktop.workspace())).terminals[0].worktree,
    path.join(home, ".foom", "config"),
  );
  const greetingTail = await first.evaluate(
    async (id) => (await window.desktop.tail(id, 40)).join(""),
    id,
  );
  assert.match(greetingTail, /CONFIG_MENU_READY \["Read AGENTS\.md, then greet the user/);
  assert.match(greetingTail, /Ask what they would like to change\."\]/);
  await first.screenshot({
    path: "test-results/sidebar-config-launched.png",
    animations: "disabled",
  });
  await first.evaluate(() => window.desktop.appMenu.execute("new-window"));
  await expect
    .poll(() => app.windows().filter((page) => page.url() === "app://bundle/index.html").length)
    .toBe(2);
  const second = app
    .windows()
    .find((page) => page !== first && page.url() === "app://bundle/index.html");
  await expect(second.getByRole("button", { name: "Foom menu" })).toBeVisible();
  const menu = await second.evaluate(() => window.desktop.appMenu.commands());
  assert.ok(!JSON.stringify(menu).includes("via-"));
  await second.locator(".config-gear").click();
  await second.getByRole("menuitem", { name: "Via Claude Code" }).click();
  await expect(second.locator(".terminal-tile[data-empty=false]")).toHaveCount(1);
  assert.equal(
    (await first.evaluate(() => window.desktop.workspace())).terminals.filter(
      (session) => session.config,
    ).length,
    2,
  );
  const configIds = (await second.evaluate(() => window.desktop.workspace())).terminals
    .filter((session) => session.config)
    .map((session) => session.id);
  assert.equal(new Set(configIds).size, 2);
  for (const configId of configIds) {
    await expect
      .poll(() =>
        second.evaluate(async (id) => (await window.desktop.tail(id, 40)).join(""), configId),
      )
      .toMatch(/CONFIG_MENU_READY \["Read AGENTS\.md, then greet the user/);
  }
  await first.evaluate(() =>
    window.desktop.saveSetup({ agents: { claude: false, codex: false, agy: false } }),
  );
  await assert.rejects(
    second.evaluate(() => window.desktop.appMenu.execute("via-claude")),
    /foom-error:operation-failed/,
  );
  // Stop both agents through their owning boards before the shared app teardown.
  await stopSession(first, id);
  const secondId = configIds.find((configId) => configId !== id);
  assert.ok(secondId);
  await stopSession(second, secondId);
});

test("version 2 themes scope portaled colors, shape and warnings and hold attention edits", {
  timeout: deadline(45000),
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-v2-theme-"));
  removeAfterApps(context, root);
  const app = await launchApp(context, { fixture: "running-shell", home: root });
  const page = await boardPage(app);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { interfaceThemes } = require("../../build/shared/interface-themes.js");
  const theme = {
    ...interfaceThemes["eclipse-dark"],
    version: 2,
    name: "Personal v2",
    colors: { ...interfaceThemes["eclipse-dark"].colors, ink: "#ffb23e" },
    areas: {
      sidebar: { bg: "#010203", surface: "#010203" },
      tiles: { surface: "#141414" },
      panels: { surface: "#202020" },
      menus: { surface: "#161616" },
    },
    shape: { radius: 0 },
  };
  const file = path.join(root, ".foom/config/themes/personal.json");
  await writeFile(file, JSON.stringify(theme));
  await boardCommand(app, ",", process.platform !== "darwin");
  await page.getByRole("button", { name: "Themes", exact: true }).click();
  await page.getByRole("button", { name: "Personal v2", exact: true }).click();
  await expect(page.locator(".sidebar-shell")).toHaveCSS("background-color", "rgb(1, 2, 3)");
  await page.getByRole("button", { name: "Close settings (Esc)", exact: true }).click();
  await expect(page.locator(".tile-title").first()).toHaveCSS("--surface", "#141414");
  await expect(page.locator(".board-row").first()).toHaveCSS("border-radius", "0px");
  await page.getByRole("button", { name: "Actions for Main checkout", exact: true }).press("Enter");
  await expect(page.locator(".sidebar-panel")).toHaveCSS("--surface", "#202020");
  await expect(page.locator(".sidebar-panel")).toHaveCSS("border-radius", "0px");
  await page.keyboard.press("Escape");
  await page.locator(".wordmark-menu").click();
  await expect(page.locator(".app-menu")).toHaveCSS("--surface", "#161616");
  await page.keyboard.press("Escape");
  // First restore distinct attention; the next edit must newly introduce the warning.
  theme.colors.ink = "#f4efff";
  await writeFile(file, JSON.stringify(theme));
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--ink")))
    .toBe("#f4efff");
  const original = JSON.stringify(theme);
  theme.colors.attention = theme.colors.ink;
  await writeFile(file, JSON.stringify(theme));
  await boardCommand(app, ",", process.platform !== "darwin");
  await page
    .getByRole("region", { name: "Settings", exact: true })
    .getByRole("button", { name: "Foom config", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "Change waiting for approval" })).toContainText(
    "needs-you is hard to tell apart",
  );
  assert.equal(
    await page.evaluate(() => document.documentElement.style.getPropertyValue("--attention")),
    "#ffb23e",
  );
  await page.getByRole("button", { name: "Keep it on", exact: true }).click();
  // Wait for the write to finish before opening the file on Windows.
  await expect(page.getByRole("region", { name: "Change waiting for approval" })).toHaveCount(0);
  assert.equal(await readFile(file, "utf8"), original);
});

test("footer config gear opens Settings and launches two independent docked Shells", async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  const gear = page.locator(".config-gear");
  const dock = page.locator(".config-dock");
  await expect(dock).toHaveCount(0);
  await gear.press("Enter");
  const panel = page.getByRole("dialog", { name: "Foom config details and commands" });
  await expect(gear).toHaveAttribute("aria-expanded", "true");
  await expect(panel.getByRole("menuitem").first()).toContainText("Settings");
  await panel.getByRole("menuitem", { name: /^Shell/ }).click();
  const session = dock.locator(".board-row").first();
  await expect(session).toBeVisible();
  await session.press("Enter");
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await gear.click();
  await expect(panel.getByRole("menuitem", { name: /^Shell/ })).not.toContainText("running");
  await panel.getByRole("menuitem", { name: /^Shell/ }).click();
  await expect(dock.locator(".board-row")).toHaveCount(2);
  await expect(page.locator(".terminal-tile[data-empty=false]")).toHaveCount(1);
  const shells = (await page.evaluate(() => window.desktop.workspace())).terminals.filter(
    (row) => row.config,
  );
  assert.equal(shells.length, 2);
  assert.notEqual(shells[0].id, shells[1].id);
  for (const shell of shells) {
    assert.equal(shell.kind, "shell");
    assert.equal(shell.worktree, shells[0].worktree);
    await expect
      .poll(() =>
        page.evaluate(async (id) => (await window.desktop.tail(id, 40)).join("\n"), shell.id),
      )
      .toMatch(process.platform === "win32" ? /PS [\s\S]*>/ : /[$#%>]\s*$/);
  }
  await gear.click();
  await panel.getByRole("menuitem", { name: /^Settings/ }).click();
  await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();
  await assertAccessible(page);
});

test("sidebar footer zoom and master volume stay synchronized and presets are absent", async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.getByRole("button", { name: "Foom config", exact: true })).toBeVisible();
  await installSoundSink(page);
  const footer = page.locator(".sidebar-footer-bar");
  await expect(footer.getByRole("group", { name: "Zoom", exact: true })).toBeVisible();
  await expect(footer.getByRole("slider", { name: "Volume", exact: true })).toHaveValue("100");
  for (const name of [
    "One",
    "Two side by side",
    "Two stacked",
    "Two by two",
    "One and two",
    "One and three",
    "Tidy tiles",
  ])
    await expect(footer.getByRole("button", { name, exact: true })).toHaveCount(0);
  assert.equal(
    (await page.evaluate(() => window.desktop.appMenu.commands())).some((entry) =>
      entry?.id?.startsWith("preset-"),
    ),
    false,
  );
  assert.equal(
    await page.evaluate(async () => {
      try {
        await window.desktop.appMenu.execute("preset-grid");
        return false;
      } catch {
        return true;
      }
    }),
    true,
  );
  await footer.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.interfaceScale),
    )
    .toBe(110);
  await footer.getByRole("button", { name: "Zoom 110%, reset to 100%", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.interfaceScale),
    )
    .toBe(100);
  await footer.getByRole("button", { name: "Mute", exact: true }).click();
  await expect(footer.getByRole("button", { name: "Unmute", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const volume = footer.getByRole("slider", { name: "Volume", exact: true });
  await volume.press("Home");
  await volume.press("ArrowRight");
  await expect(volume).toHaveValue("5");
  await expect.poll(() => page.evaluate(() => window.soundTones.length)).toBeGreaterThan(0);
  await expect(footer.getByRole("button", { name: "Mute", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.sound.volume),
    )
    .toBe(0.05);
  await footer.getByRole("button", { name: "Zoom 100%", exact: true }).hover();
  await page.mouse.wheel(0, -100);
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.interfaceScale),
    )
    .toBe(110);
  await footer.getByRole("button", { name: "Zoom 110%, reset to 100%", exact: true }).hover();
  await page.mouse.wheel(0, 100);
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.interfaceScale),
    )
    .toBe(100);
  await footer.getByRole("button", { name: "Mute", exact: true }).click();
  await footer.getByRole("button", { name: "Unmute", exact: true }).hover();
  await page.mouse.wheel(0, -100);
  await expect(volume).toHaveValue("10");
  await expect
    .poll(() => page.evaluate(async () => (await window.desktop.setupState()).settings.sound))
    .toMatchObject({ volume: 0.1, muted: false });
  await volume.hover();
  await page.mouse.wheel(0, 100);
  await expect(volume).toHaveValue("5");
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.sound.volume),
    )
    .toBe(0.05);
  await openSettingsScreen(page);
  await page.getByRole("button", { name: "Sound", exact: true }).click();
  const settingsVolume = page
    .locator(".sound-controls")
    .getByRole("slider", { name: "Volume", exact: true });
  await expect(settingsVolume).toHaveValue("5");
  await settingsVolume.press("End");
  await expect(volume).toHaveValue("100");
  await page.locator(".sound-controls").getByRole("button", { name: "Mute", exact: true }).click();
  await expect(footer.getByRole("button", { name: "Unmute", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await footer.getByRole("button", { name: "Unmute", exact: true }).click();
  for (const colorMode of ["dark", "light"]) {
    await page.evaluate((colorMode) => window.desktop.saveSetup({ colorMode }), colorMode);
    await expect
      .poll(() =>
        page
          .locator(".sidebar-shell")
          .evaluate((element) =>
            getComputedStyle(element).getPropertyValue("--surface").trim().toLowerCase(),
          ),
      )
      .toBe(colorMode === "dark" ? "#0d0a17" : "#e9e4f5");
    await page.screenshot({
      path: `test-results/footer-after-${colorMode}-300.png`,
      animations: "disabled",
    });
    await page.locator(".sidebar-shell").evaluate((element) => {
      element.style.flexBasis = "220px";
    });
    await expect(footer).toBeVisible();
    await expect(page.locator(".sidebar-shell")).toHaveCSS("flex-basis", "220px");
    const bounds = await footer.evaluate((element) => {
      const outer = element.getBoundingClientRect();
      return [...element.querySelectorAll("button, input")].every((control) => {
        const rect = control.getBoundingClientRect();
        return (
          rect.left >= outer.left &&
          rect.right <= outer.right &&
          rect.top >= outer.top &&
          rect.bottom <= outer.bottom
        );
      });
    });
    assert.equal(bounds, true, "footer controls fit the minimum sidebar width");
    await page.screenshot({
      path: `test-results/footer-after-${colorMode}-220.png`,
      animations: "disabled",
    });
    await page.locator(".sidebar-shell").evaluate((element) => {
      element.style.flexBasis = "300px";
    });
  }
  await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  await expect(footer.getByRole("button", { name: "Foom config", exact: true })).toBeVisible();
  await expect(footer.getByRole("group", { name: "Zoom", exact: true })).toBeHidden();
  await expect(volume).toBeHidden();
});

test("terminal font picker updates open shells and config shells and refits their grids", async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  await page.getByRole("button", { name: "Tile 1 menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Split right", exact: true }).click();
  await page.evaluate(() => window.desktop.sidebarCommand({ kind: "config-launch", run: "shell" }));
  await page.locator(".config-dock .board-row").press("Enter");
  await expect(page.locator(".xterm-rows:visible")).toHaveCount(2);
  await expect(page.locator(".xterm-helper-textarea").last()).toBeFocused();
  const ids = await page.evaluate(async () =>
    (await window.desktop.workspace()).terminals.map((entry) => entry.id),
  );
  assert.equal(ids.length, 2);
  await app.evaluate(({ ipcMain }) => {
    global.fontResizes = [];
    ipcMain.on("terminal:resize", (_event, id, cols, rows) =>
      global.fontResizes.push({ id, cols, rows }),
    );
    // OS enumeration may legitimately return [] (including after its bounded
    // PowerShell timeout). Exercise font changes with a font bundled on every OS.
    ipcMain.removeHandler("setup:terminal-fonts");
    ipcMain.handle("setup:terminal-fonts", () => ["Geist Mono"]);
  });
  await openSettingsScreen(page);
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Terminal", exact: true })
    .click();
  const picker = page.getByLabel("Terminal font", { exact: true });
  const family = "Geist Mono";
  await expect(picker.getByRole("option", { name: family, exact: true })).toHaveCount(1);
  await picker.selectOption(family);
  const stack = `"${family}", "Hack Nerd Font Mono", "Geist Mono", monospace`;
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.terminalFont),
    )
    .toBe(family);
  await page.getByRole("button", { name: "Themes", exact: true }).click();
  await expect(page.getByLabel("Terminal theme preview")).toHaveCSS("font-family", stack);
  await app.evaluate(() => {
    global.fontResizes = [];
  });
  await page.keyboard.press("Escape");
  for (const rows of await page.locator(".xterm-rows").all())
    await expect(rows).toHaveCSS("font-family", stack);
  await expect
    .poll(() =>
      app.evaluate(() =>
        [
          ...new Set(
            global.fontResizes
              .filter((entry) => entry.cols > 0 && entry.rows > 0)
              .map((entry) => entry.id),
          ),
        ].sort(),
      ),
    )
    .toEqual(ids.sort());
  await openSettingsScreen(page);
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Terminal", exact: true })
    .click();
  await expect(picker).toHaveValue(family);
  await picker.selectOption("Hack Nerd Font Mono");
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.terminalFont),
    )
    .toBe("Hack Nerd Font Mono");
  await page.keyboard.press("Escape");
  for (const rows of await page.locator(".xterm-rows").all())
    await expect(rows).toHaveCSS("font-family", '"Hack Nerd Font Mono", "Geist Mono", monospace');
});

test("Settings forge cards persist user host assignments without activating providers", {
  timeout: deadline(45_000),
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-forge-cards-"));
  removeAfterApps(context, root);
  const home = path.join(root, "home");
  const userData = path.join(root, "profile");
  const folder = path.join(home, ".foom", "config", "forges");
  await mkdir(folder, { recursive: true });
  const manifest = JSON.parse(
    await readFile(path.join(__dirname, "../../src/shared/bundled-forges/github.json"), "utf8"),
  );
  await writeFile(
    path.join(folder, "custom.json"),
    JSON.stringify({ ...manifest, id: "custom", name: "Custom forge" }),
  );
  await writeFile(path.join(folder, "broken.json"), "{}");
  const app = await launchApp(context, {
    fixture: "empty-board",
    home,
    args: [`--user-data-dir=${userData}`],
  });
  const page = await boardPage(app);
  await openSettingsScreen(page);
  await page.getByRole("button", { name: "Forges", exact: true }).click();
  const github = page.getByRole("region", { name: "GitHub", exact: true });
  const custom = page.getByRole("region", { name: "Custom forge", exact: true });
  await expect(github.getByRole("switch")).toBeChecked();
  await expect(github).toContainText("github.com");
  await expect(custom.getByRole("switch")).not.toBeChecked();
  await expect(custom.getByRole("textbox")).toBeDisabled();
  await expect(
    page.getByRole("region", { name: "broken", exact: true }).getByRole("switch"),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: /Duplicate|Approve/ })).toHaveCount(0);
  await assertAccessible(page);
  await custom.getByRole("switch").click();
  await expect(custom.getByRole("switch")).toBeChecked();
  await expect(custom.getByRole("textbox")).toBeEnabled();
  await custom.getByRole("textbox").fill("https://bad.example.org");
  await custom.getByRole("button", { name: "Assign host" }).click();
  await expect(page.getByRole("alert")).toHaveText("Unable to update settings.");
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await custom.getByRole("textbox").fill("git.example.org");
  await custom.getByRole("button", { name: "Assign host" }).click();
  await expect(custom.getByRole("button", { name: "Remove git.example.org" })).toBeVisible();
  await custom.getByRole("switch").click();
  await expect(custom.getByRole("switch")).not.toBeChecked();
  await expect(custom.getByRole("textbox")).toBeDisabled();
  await expect(custom).toContainText("git.example.org");
  const rejected = await page.evaluate(() =>
    window.desktop.saveSetup({ forgeHosts: { "new.example.org": "custom" } }).then(
      () => "saved",
      (error) => String(error),
    ),
  );
  assert.match(rejected, /foom-error:operation-failed/);
  const before = await page.evaluate(() => window.desktop.setupState());
  assert.equal(before.settings.forgeHosts["github.com"], "github");
  assert.equal(before.settings.forgeHosts["git.example.org"], "custom");
  await quitAndWait(app, () => app.evaluate(({ app }) => app.quit()));
  const saved = JSON.parse(await readFile(path.join(userData, "settings.json"), "utf8"));
  assert.deepEqual(saved.settings.forges, { github: true, custom: false });
  assert.deepEqual(saved.settings.forgeHosts, {
    "github.com": "github",
    "git.example.org": "custom",
  });
  const restarted = await launchApp(context, {
    fixture: "empty-board",
    home,
    args: [`--user-data-dir=${userData}`],
  });
  const restored = await boardPage(restarted);
  await openSettingsScreen(restored);
  await restored.getByRole("button", { name: "Forges", exact: true }).click();
  const restoredCustom = restored.getByRole("region", { name: "Custom forge", exact: true });
  await expect(restoredCustom.getByRole("switch")).not.toBeChecked();
  await expect(restoredCustom).toContainText("git.example.org");
  await restoredCustom.getByRole("button", { name: "Remove git.example.org" }).click();
  await expect(restoredCustom.getByRole("button", { name: "Remove git.example.org" })).toHaveCount(
    0,
  );
});

test("interface zoom follows the shared setting in every window", async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const first = await boardPage(app);
  await first.evaluate(() => window.desktop.appMenu.execute("new-window"));
  await expect
    .poll(() => app.windows().filter((page) => page.url() === "app://bundle/index.html").length)
    .toBe(2);
  const second = app
    .windows()
    .find((page) => page !== first && page.url() === "app://bundle/index.html");
  const zoomButton = (page, scale) =>
    page.getByRole("button", {
      name: scale === 100 ? "Zoom 100%" : `Zoom ${scale}%, reset to 100%`,
      exact: true,
    });
  await expect(zoomButton(second, 100)).toBeVisible();
  await first.getByRole("button", { name: "Zoom in", exact: true }).click();
  const assertScale = async (scale) => {
    for (const page of [first, second]) {
      await expect(zoomButton(page, scale)).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(async () => (await window.desktop.setupState()).settings.interfaceScale),
        )
        .toBe(scale);
    }
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .filter((window) => window.webContents.getURL() === "app://bundle/index.html")
            .map((window) => window.webContents.getZoomFactor()),
        ),
      )
      .toEqual([scale / 100, scale / 100]);
  };
  await assertScale(110);
  await second.evaluate(() => window.desktop.appMenu.execute("zoom-in"));
  await assertScale(120);
  await zoomButton(first, 120).click();
  await assertScale(100);
});

test("Settings session panel preview follows color and contrast; Environment links to Agents", async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  await openSettingsScreen(page);
  const navigation = page.getByRole("navigation", { name: "Settings sections" });
  await navigation.getByRole("button", { name: "Environment", exact: true }).click();
  await expect(
    page.getByText("Added to every shell and agent Foom starts.", { exact: false }),
  ).toBeVisible();
  await page
    .locator(".settings-controls")
    .getByRole("button", { name: "Agents", exact: true })
    .click();
  await expect(navigation.getByRole("button", { name: "Agents", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await navigation.getByRole("button", { name: "Appearance", exact: true }).click();
  const preview = page.getByRole("img", { name: "Session panel preview" });
  const mark = preview.locator(".panel-mark");
  const backgrounds = [];
  for (const [level, tint] of [
    ["Vivid", "1"],
    ["Subtle", "0.5"],
    ["Plain", "0"],
  ]) {
    await page.getByRole("radio", { name: level, exact: true }).check();
    await expect(preview).toHaveCSS("--panel-tint", tint);
    backgrounds.push(await mark.evaluate((node) => getComputedStyle(node).backgroundColor));
  }
  assert.equal(new Set(backgrounds).size, 3);
  await page.getByRole("radio", { name: "Vivid", exact: true }).check();
  await page.evaluate(() => window.desktop.saveSetup({ interfaceTheme: "high-contrast" }));
  await expect(preview).toHaveCSS("--panel-tint", "0");
  await page.evaluate(() => window.desktop.saveSetup({ interfaceTheme: "follow" }));
  await page.emulateMedia({ contrast: "more" });
  await expect(preview).toHaveCSS("--panel-tint", "0");
  await expect(preview).toHaveCSS("--panel-chip-line", "100%");
  await assertAccessible(page);
});

test("Settings opens on General from the menu, sidebar and keyboard", async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  await openSettingsScreen(page);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "Close settings (Esc)" }).click();
  await page.locator(".config-gear").click();
  const panel = page.getByRole("dialog", { name: "Foom config details and commands" });
  await expect(panel.getByRole("menuitem", { name: "Open Foom config settings" })).toHaveCount(0);
  await expect(panel.getByRole("menuitem", { name: "Open folder", exact: true })).toBeVisible();
  if (process.env.FOOM_UI_SCREENSHOTS)
    await page.screenshot({
      path: path.join(process.env.FOOM_UI_SCREENSHOTS, "sidebar-config-menu.png"),
      animations: "disabled",
    });
  await panel.getByRole("menuitem", { name: /^Settings/ }).click();
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close settings (Esc)" }).click();
  await boardCommand(app, ",", process.platform !== "darwin");
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeFocused();
});

test("nested repository names follow the General toggle and retain their identity", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-nested-repositories-"));
  removeAfterApps(context, root);
  const repository = path.join(root, "work", "foom");
  await mkdir(repository, { recursive: true });
  isolatedGit(["init", "-q", "-b", "main", repository]);
  isolatedGit([
    "-C",
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  const app = await launchApp(context, { fixture: "empty-board" });
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, repository);
  const page = await boardPage(app);
  await page.getByRole("button", { name: "Add repository", exact: true }).click();
  const row = page.locator(".repository-row .tree-label");
  await expect(row).toHaveText("foom");
  await expect(page.getByRole("button", { name: "Add repository", exact: true })).toHaveText(
    "+ Add repo",
  );
  await page.evaluate(
    (codeFolder) => window.desktop.saveSetup({ codeFolder }),
    await realpath(root),
  );
  const screenshot = async (name) => {
    if (process.env.FOOM_UI_SCREENSHOTS)
      await page.screenshot({
        path: path.join(process.env.FOOM_UI_SCREENSHOTS, name + ".png"),
        animations: "disabled",
      });
  };
  await screenshot("nested-repo-off-add-label");
  await openSettingsScreen(page);
  const toggle = page.getByRole("checkbox", {
    name: "Show repository paths relative to code folder",
  });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(row).toHaveText("work/foom");
  await screenshot("settings-general-toggle");
  await page.getByRole("button", { name: "Close settings (Esc)" }).click();
  await screenshot("nested-repo-on");
  const before = await page.evaluate(() => window.desktop.workspace());
  await openSettingsScreen(page);
  await toggle.uncheck();
  await expect(row).toHaveText("foom");
  assert.deepEqual(
    (await page.evaluate(() => window.desktop.workspace())).repositories,
    before.repositories,
  );
  await page.getByRole("button", { name: "Close settings (Esc)" }).click();
  await page.getByRole("button", { name: "Foom menu" }).click();
  await expect(page.getByRole("menuitem", { name: /^Via / })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: /^Settings…/ })).toBeVisible();
  await screenshot("application-menu-linux");
  await page.getByRole("menuitem", { name: "Developer", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Action log", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /^Developer tools/ })).toBeVisible();
  await screenshot("developer-submenu-linux");
});

test("General update opt-out persists; update notices and restart counts remain quiet", async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  await openSettingsScreen(page);
  const check = page.getByRole("checkbox", { name: "Check for updates", exact: true });
  // Fixture profiles explicitly opt out before launch; the product default is tested in SettingsStore.
  await expect(check).not.toBeChecked();
  await check.check();
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.checkForUpdates),
    )
    .toBe(true);
  await check.uncheck();
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.checkForUpdates),
    )
    .toBe(false);
  const state = await page.evaluate(() => window.desktop.setupState());
  for (const mode of ["light", "dark"]) {
    await page.evaluate((colorMode) => window.desktop.saveSetup({ colorMode }), mode);
    for (const status of ["available", "downloaded", "error"]) {
      // Fake local main facts exercise the real sandboxed bridge without any updater or HTTP call.
      await app.evaluate(
        ({ BrowserWindow }, state) => {
          const board = BrowserWindow.getAllWindows().find(
            (window) => window.webContents.getURL() === "app://bundle/index.html",
          );
          board.webContents.send("setup:changed", state);
        },
        {
          ...state,
          settings: { ...state.settings, colorMode: mode, checkForUpdates: true },
          updates: { status, runningAgents: 3 },
        },
      );
      if (status === "downloaded")
        await expect(
          page.getByRole("button", { name: "Restart to update · 3 running agents" }),
        ).toBeVisible();
      else
        await expect(
          page.getByText(
            status === "available" ? "Update available" : "Could not check for updates.",
            { exact: true },
          ),
        ).toBeVisible();
      if (process.env.FOOM_UPDATE_SCREENSHOTS === "1") {
        await mkdir("screenshots-603", { recursive: true });
        await page.screenshot({ path: `screenshots-603/general-${mode}-${status}.png` });
      }
    }
  }
  // Renderer facts do not authorize quit: the main service has no staged update.
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  await page.evaluate(() => window.desktop.restartToUpdate());
  assert.equal(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    windows,
  );
  await assertAccessible(page);
});
