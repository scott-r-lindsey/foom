const { sizeTileBoard } = require("./tile-fixture.js");
const { evidencePath } = require("../helpers/evidence.js");
const { gitSync: isolatedGit } = require("../helpers/git.js");
const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, mkdtemp, readFile, realpath, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { expect } = require("./test-policy.js");
const {
  FAKE_ORCHESTRATED_CLAUDE,
  assertAccessible,
  boardPage,
  confirmationPage,
  launchApp,
  removeAfterApps,
} = require("./harness.js");
const {
  previewContents,
  previewViewState,
  typeIntoFocusedContents,
  movePreviewTile,
} = require("./preview-fixture.js");

async function agentPreviewFixture(context) {
  const { chmod, symlink } = require("node:fs/promises");
  const { existsSync } = require("node:fs");
  // Match Git inventory paths when the platform temporary parent is an alias.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-agent-preview-")));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  const repo = path.join(root, "app");
  const home = path.join(root, "home");
  for (const directory of [bin, repo, home]) await mkdir(directory);
  await writeFile(path.join(bin, "claude"), FAKE_ORCHESTRATED_CLAUDE);
  await chmod(path.join(bin, "claude"), 0o755);
  await symlink(process.execPath, path.join(bin, "node"));
  isolatedGit(["init", "-q", "-b", "main"], { cwd: repo });
  await writeFile(
    path.join(repo, "grabby.html"),
    `<input autofocus><script>window.stolen=""; window.attempts=0; addEventListener("keydown", event => window.stolen+=event.key); setInterval(() => { window.attempts++; window.focus(); document.querySelector("input").focus(); },20);</script>`,
  );
  await writeFile(path.join(repo, "notes.md"), "# Agent notes");
  await writeFile(path.join(repo, "narrow.md"), "# Narrow notes");
  const credentials = path.join(root, "credentials");
  const app = await launchApp(context, {
    fixture: "running-shell",
    args: [`--user-data-dir=${path.join(root, "user-data")}`],
    env: {
      HOME: home,
      PATH: bin,
      TEST_FAKE_CREDENTIALS: credentials,
    },
  });
  const page = await boardPage(app);
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, repo);
  await page.evaluate(async () => {
    const repo = await window.desktop.addRepository();
    await window.desktop.sidebarCommand({
      kind: "launch",
      repository: repo.path,
      worktree: repo.path,
      run: "claude",
    });
  });
  await expect.poll(() => existsSync(`${credentials}.app`)).toBe(true);
  let terminals;
  await expect
    .poll(async () => {
      terminals = (await page.evaluate(() => window.desktop.workspace())).terminals;
      return terminals.some((row) => row.agent === "claude");
    })
    .toBe(true);
  const agent = terminals.find((row) => row.agent === "claude");
  const shell = terminals.find((row) => row.kind === "shell");
  assert.ok(agent && shell);
  await expect
    .poll(async () => (await page.evaluate((id) => window.desktop.tail(id, 20), agent.id)).join(""))
    .toContain("FOOM_AGENT_READY");
  const requestAgent = async (requestId, args) => {
    await page.evaluate(
      ({ id, requestId, args }) =>
        window.desktop.input(id, JSON.stringify({ id: requestId, args }) + "\n"),
      { id: agent.id, requestId, args },
    );
    await expect.poll(() => existsSync(`${credentials}.response-${requestId}`)).toBe(true);
    const response = JSON.parse(await readFile(`${credentials}.response-${requestId}`, "utf8"));
    assert.equal(response.code, 0, response.stderr);
    return JSON.parse(response.stdout).result;
  };
  const requestPreview = (requestId, file) =>
    requestAgent(requestId, ["open-preview", file, "--json"]);
  const listPreviews = (requestId) => requestAgent(requestId, ["previews", "--json"]);
  return { app, page, repo, agent, shell, credentials, requestAgent, requestPreview, listPreviews };
}

test("agent previews split a blank window into terminal-width columns", {
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  const { app, page, repo, requestPreview } = await agentPreviewFixture(context);
  await writeFile(
    path.join(repo, "blank.md"),
    "# Agent preview\n\nOpened on a blank board, using the same columns as a terminal.",
  );
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setContentSize(2200, 1000);
  });
  await page.waitForFunction(() => innerWidth === 2200);
  await page.evaluate(() => {
    localStorage.setItem(
      `foom.tiles.v1.${window.desktop.windows.id}`,
      JSON.stringify({
        version: 2,
        tree: { kind: "tile", id: "blank", content: null },
        focused: "blank",
        maximized: null,
      }),
    );
  });
  await page.reload();
  await expect(page.locator('.terminal-tile[data-empty="true"]')).toHaveCount(1);
  const blankPreview = await requestPreview("blank", "blank.md");
  assert.equal(blankPreview.placement, "empty");
  await expect(page.locator(".terminal-tile")).toHaveCount(2);
  await expect(page.locator(".terminal-tile").first()).toHaveAttribute("data-kind", "preview");
  assert.equal(
    await page
      .locator(".terminal-tile")
      .first()
      .evaluate((tile) => tile.style.width),
    "50%",
  );
  await expect(page.locator(".terminal-tile").first()).toHaveAttribute("data-focused", "true");
  await expect
    .poll(async () => (await previewViewState(app, blankPreview.previewId)).attached)
    .toBe(true);
  if (process.env.FOOM_PLACEMENT_SCREENSHOTS === "1" && process.platform === "linux") {
    await page.locator('.board-row[data-kind="shell"]').click();
    await expect(page.locator('.terminal-tile[data-kind="shell"]')).toBeVisible();
    await mkdir(evidencePath("screenshots-746"), { recursive: true });
    const handle = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "app://bundle/index.html")
        .getNativeWindowHandle()
        .readUInt32LE(),
    );
    for (const mode of ["light", "dark"]) {
      await page.evaluate(
        (colorMode) =>
          window.desktop.saveSetup({
            interfaceTheme: colorMode === "system" ? "follow" : `eclipse-${colorMode}`,
          }),
        mode,
      );
      await page.waitForFunction(
        (mode) => document.documentElement.style.colorScheme === mode,
        mode,
      );
      await expect
        .poll(() =>
          previewContents(
            app,
            blankPreview.previewId,
            "getComputedStyle(document.documentElement).backgroundColor",
          ),
        )
        .toBe(mode === "dark" ? "rgb(5, 4, 10)" : "rgb(243, 240, 250)");
      await previewContents(
        app,
        blankPreview.previewId,
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      require("node:child_process").execFileSync("import", [
        "-window",
        String(handle),
        evidencePath(`screenshots-746/agent-preview-terminal-${mode}.png`),
      ]);
    }
    await page.evaluate(() => window.desktop.saveSetup({ interfaceTheme: "follow" }));
  }
  await page.evaluate((id) => window.desktop.previews.close(id), blankPreview.previewId);
});

test("an agent fixture opens full-board previews in columns, retains focus and respects human close", {
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  const { app, page, repo, agent, shell, credentials, requestPreview } =
    await agentPreviewFixture(context);
  await sizeTileBoard(app, page, 2400);
  const { existsSync } = require("node:fs");
  await page.evaluate(
    ({ shellId }) => {
      const key = `foom.tiles.v1.${window.desktop.windows.id}`;
      localStorage.setItem(
        key,
        JSON.stringify({
          version: 2,
          tree: {
            kind: "split",
            id: "pair",
            direction: "horizontal",
            ratio: 0.5,
            first: {
              kind: "tile",
              id: "terminal",
              content: { kind: "terminal", session: shellId },
            },
            second: { kind: "tile", id: "landing", content: null },
          },
          focused: "terminal",
          maximized: null,
          landing: "landing",
        }),
      );
    },
    { shellId: shell.id },
  );
  await page.reload();
  await expect(page.locator('[data-tile="terminal"] .xterm-helper-textarea')).toBeVisible();
  await page.locator('[data-tile="terminal"] .xterm-helper-textarea').focus();
  await app.evaluate(({ BrowserWindow }) => {
    const board = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
    board.setContentSize(2400, 900);
    board.focus();
    board.webContents.focus();
  });
  await expect
    .poll(() => app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL()))
    .toBe("app://bundle/index.html");
  await page.evaluate(
    ({ id }) =>
      window.desktop.input(
        id,
        JSON.stringify({ id: "preview", args: ["open-preview", "grabby.html", "--json"] }) + "\n",
      ),
    { id: agent.id },
  );
  await expect.poll(() => existsSync(`${credentials}.response-preview`)).toBe(true);
  const response = JSON.parse(await readFile(`${credentials}.response-preview`, "utf8"));
  assert.equal(response.code, 0, response.stderr);
  const result = JSON.parse(response.stdout).result;
  assert.equal(result.placement, "landing");
  assert.equal(result.reused, false);
  await expect(page.locator('[data-tile="landing"]')).toHaveAttribute("data-kind", "preview");
  await expect(page.locator('[data-tile="terminal"]')).toHaveAttribute("data-focused", "true");
  await expect(page.locator('[data-tile="terminal"] .xterm-helper-textarea')).toBeFocused();
  await expect(page.locator('[data-tile="landing"]')).toHaveAttribute("data-arrived", "true");
  await expect(page.locator('[data-tile="landing"] .preview-opener')).toHaveText("opened byCC");
  await expect(page.locator('[data-tile="landing"]')).toHaveAttribute(
    "aria-label",
    /opened by Claude Code/,
  );
  await expect
    .poll(() => page.locator(".tile-area").evaluate((area) => area.clientWidth))
    .toBeGreaterThan(2000);
  const before = await page.locator('[data-tile="terminal"]').boundingBox();
  const columnResult = await requestPreview("notes", "notes.md");
  assert.equal(columnResult.placement, "column");
  await expect(page.locator('.terminal-tile[data-kind="preview"]')).toHaveCount(2);
  await expect
    .poll(async () => (await previewViewState(app, columnResult.previewId)).attached)
    .toBe(true);
  await expect
    .poll(() =>
      previewContents(app, columnResult.previewId, "document.querySelector('h1')?.textContent"),
    )
    .toBe("Agent notes");
  await expect(page.locator('[data-tile="terminal"] .xterm-helper-textarea')).toBeFocused();
  const notesTile = page.locator(`[data-preview-id="${columnResult.previewId}"]`);
  await expect(notesTile).toHaveAttribute("data-arrived", "true");
  const after = await page.locator('[data-tile="terminal"]').boundingBox();
  const added = await notesTile.boundingBox();
  assert.ok(
    before && after && added && after.width < before.width && added.x > after.x + after.width,
  );
  assert.equal((await requestPreview("existing", "notes.md")).placement, "existing");
  const notesRow = page.getByRole("treeitem", {
    name: "Markdown preview: notes.md, opened by Claude Code",
  });
  await expect(notesRow).toBeVisible();
  const glyphBounds = await notesRow.locator(".preview-glyph").boundingBox();
  const openerBounds = await page
    .locator('.board-row[data-kind="agent"] .board-light')
    .boundingBox();
  assert.ok(glyphBounds && openerBounds && glyphBounds.x >= openerBounds.x + 16);
  await page.screenshot({ path: evidencePath("preview-attribution.png") });
  assert.ok(
    await notesRow.evaluate(
      (row) => row.parentElement.querySelector('.board-row[data-kind="agent"]') !== null,
    ),
  );
  await page.getByRole("button", { name: "Actions for Claude Code in main" }).click();
  await expect(page.getByText("Opened preview grabby.html", { exact: true })).toBeVisible();
  await expect(page.getByText("Opened preview notes.md", { exact: true })).toHaveCount(2);
  await expect(page.getByText("Opened preview notes.md", { exact: true }).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator('[data-tile="terminal"] .xterm-helper-textarea').focus();
  // Exercise the existing bounds bridge; overlay composition supplies these reports in #292.
  await page.evaluate(
    (id) =>
      window.desktop.previews.bounds(id, {
        x: 500,
        y: 150,
        width: 250,
        height: 200,
        visible: true,
      }),
    result.previewId,
  );
  await expect
    .poll(async () => (await previewViewState(app, result.previewId)).attached)
    .toBe(true);
  await expect
    .poll(() => previewContents(app, result.previewId, "window.attempts"))
    .toBeGreaterThan(0);
  const keys = "a".repeat(100);
  await typeIntoFocusedContents(app, keys);
  await expect
    .poll(async () => (await page.evaluate((id) => window.desktop.tail(id, 20), shell.id)).join(""))
    .toContain(keys);
  assert.equal(await previewContents(app, result.previewId, "window.stolen"), "");
  // A restored sidebar preview is placed again with its original identity.
  await page.evaluate((id) => {
    const key = `foom.tiles.v1.${window.desktop.windows.id}`;
    const layout = JSON.parse(localStorage.getItem(key));
    const clear = (node) => {
      if (node.kind === "tile") {
        if (node.content?.kind === "preview" && node.content.preview === id) node.content = null;
      } else {
        clear(node.first);
        clear(node.second);
      }
    };
    clear(layout.tree);
    localStorage.setItem(key, JSON.stringify(layout));
  }, columnResult.previewId);
  await page.reload();
  await page.locator('[data-tile="terminal"] .xterm-helper-textarea').focus();
  await expect(
    page.getByRole("treeitem", {
      name: "Markdown preview: notes.md, opened by Claude Code, not shown",
    }),
  ).toBeVisible();
  await page.evaluate(
    (id) => window.desktop.previews.bounds(id, { x: 0, y: 0, width: 0, height: 0, visible: false }),
    columnResult.previewId,
  );
  await expect
    .poll(async () => (await previewViewState(app, columnResult.previewId)).attached)
    .toBe(false);
  const reused = await requestPreview("reshow", "notes.md");
  assert.equal(reused.previewId, columnResult.previewId);
  assert.equal(reused.reused, true);
  assert.equal(reused.placement, "empty");
  await expect
    .poll(async () => (await previewViewState(app, reused.previewId)).attached)
    .toBe(true);
  await expect(page.locator('[data-tile="terminal"] .xterm-helper-textarea')).toBeFocused();
  await page
    .locator('[data-tile="landing"]')
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(page.locator('[data-tile="landing"]')).toHaveAttribute("data-empty", "true");
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.desktop.sidebarInventory())).previews.some(
        (preview) => preview.id === result.previewId,
      ),
    )
    .toBe(false);
  const reopened = await requestPreview("reopen", "grabby.html");
  assert.equal(reopened.placement, "landing");
  assert.notEqual(reopened.previewId, result.previewId);
  assert.equal(reopened.reused, false);
  await expect(page.locator('.terminal-tile[data-kind="preview"]')).toHaveCount(2);
  await expect(page.locator('[data-tile="landing"]')).toHaveAttribute("data-kind", "preview");
  await expect
    .poll(async () => (await previewViewState(app, reopened.previewId)).attached)
    .toBe(true);
  await page.locator('[data-tile="terminal"] .xterm-helper-textarea').focus();
  // Narrow boards keep adding columns below the former 60-cell threshold, preserving focus.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setContentSize(900, 640);
  });
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(900);
  const narrow = await requestPreview("narrow", "narrow.md");
  assert.equal(narrow.placement, "column");
  await expect(page.locator('.terminal-tile[data-kind="preview"]')).toHaveCount(3);
  await expect
    .poll(async () => (await previewViewState(app, narrow.previewId)).attached)
    .toBe(true);
  await expect
    .poll(() => previewContents(app, narrow.previewId, "document.querySelector('h1')?.textContent"))
    .toBe("Narrow notes");
  await expect(page.locator('[data-tile="terminal"] .xterm-helper-textarea')).toBeFocused();
  await page
    .locator(`[data-preview-id="${narrow.previewId}"]`)
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await assertAccessible(page);
  // Restore room for the popout controls after checking narrow column growth.
  await sizeTileBoard(app, page, 2400, 900);
  // Agent ownership follows the preview across windows, including list and close.
  await movePreviewTile(app, page, reopened.previewId, async (target) => {
    await expect(
      target.getByRole("treeitem", { name: "HTML preview: grabby.html, opened by Claude Code" }),
    ).toBeVisible();
    const actor = JSON.parse(await readFile(`${credentials}.app`, "utf8"));
    const call = async (method, params) => {
      const response = await fetch(actor.controlUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${actor.controlToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ version: 1, instanceId: actor.instanceId, method, params }),
      });
      assert.equal(response.status, 200);
      return (await response.json()).result;
    };
    assert.ok(
      (await call("list_previews", {})).previews.some(
        (preview) => preview.previewId === reopened.previewId && preview.visible,
      ),
    );
    await writeFile(path.join(repo, "grabby.html"), "<h1>Moved agent preview reloaded</h1>");
    await expect
      .poll(() =>
        previewContents(app, reopened.previewId, "document.querySelector('h1')?.textContent", {
          requireAttached: true,
        }),
      )
      .toBe("Moved agent preview reloaded");
    assert.equal((await call("close_preview", { previewId: reopened.previewId })).closed, true);
    await expect(target.locator(`[data-preview-id="${reopened.previewId}"]`)).toHaveCount(0);
  });
});

test("agent reopen is visible with free space and reports sidebar only at protected board capacity", {
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  const { app, page, shell, requestPreview, listPreviews } = await agentPreviewFixture(context);
  const first = await requestPreview("first", "notes.md");
  await page
    .locator(`[data-preview-id="${first.previewId}"]`)
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(page.locator(`[data-preview-id="${first.previewId}"]`)).toHaveCount(0);
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.desktop.sidebarInventory())).previews.some(
        (preview) => preview.id === first.previewId,
      ),
    )
    .toBe(false);
  const reopened = await requestPreview("visible-reopen", "notes.md");
  assert.notEqual(reopened.previewId, first.previewId);
  assert.notEqual(reopened.placement, "sidebar");
  assert.equal(reopened.reused, false);
  await expect
    .poll(async () => (await previewViewState(app, reopened.previewId)).attached)
    .toBe(true);
  assert.deepEqual((await listPreviews("visible-list")).previews, [
    {
      previewId: reopened.previewId,
      path: "notes.md",
      kind: "markdown",
      visible: true,
    },
  ]);
  await assertAccessible(page);
  if (process.env.FOOM_REOPEN_SCREENSHOTS === "1" && process.platform === "linux") {
    const handle = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "app://bundle/index.html")
        .getNativeWindowHandle()
        .readUInt32LE(),
    );
    for (const mode of ["dark", "light"]) {
      await page.evaluate(
        (mode) => window.desktop.saveSetup({ interfaceTheme: `eclipse-${mode}` }),
        mode,
      );
      await page.waitForFunction(
        (mode) => document.documentElement.style.colorScheme === mode,
        mode,
      );
      await expect
        .poll(() =>
          previewContents(
            app,
            reopened.previewId,
            "getComputedStyle(document.documentElement).backgroundColor",
          ),
        )
        .toBe(mode === "dark" ? "rgb(5, 4, 10)" : "rgb(243, 240, 250)");
      await previewContents(
        app,
        reopened.previewId,
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      require("node:child_process").execFileSync("import", [
        "-window",
        String(handle),
        evidencePath(`screenshots-931/reopened-${mode}.png`),
      ]);
    }
  }
  await page
    .locator(`[data-preview-id="${reopened.previewId}"]`)
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(page.locator(`[data-preview-id="${reopened.previewId}"]`)).toHaveCount(0);
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.desktop.sidebarInventory())).previews.some(
        (preview) => preview.id === reopened.previewId,
      ),
    )
    .toBe(false);
  // Reach the real split-depth limit with 65 occupied leaves instead of the
  // 256-leaf limit. Even dormant sessions mount xterms; their synchronous DOM
  // width measurements can starve the renderer during a 256-view reload.
  // Keep the existing snapshot/reservation hooks: no PTYs or real agents.
  // Every leaf needs the human, blocking replacement as well as column growth.
  const protectedCount = 65;
  const snapshot = await page.evaluate(() => window.desktop.workspace());
  const template = snapshot.terminals.find((terminal) => terminal.id === shell.id);
  assert.ok(template);
  snapshot.terminals = Array.from({ length: protectedCount }, (_, index) => ({
    ...template,
    id: `protected-${index}`,
    dormant: true,
    exited: false,
    state: {
      id: `protected-${index}`,
      verdictId: null,
      state: "needs_input",
      reason: "Password",
      signal: "fixture:prompt",
      confidence: 1,
      timestamp: Date.now(),
    },
  }));
  await app.evaluate(({ ipcMain }, snapshot) => {
    ipcMain.removeHandler("workspace:snapshot");
    ipcMain.handle("workspace:snapshot", () => snapshot);
    ipcMain.removeHandler("windows:sync");
    ipcMain.handle("windows:sync", (_event, ids) => ids);
  }, snapshot);
  await page.evaluate((count) => {
    const tree = (start, count) =>
      count === 1
        ? {
            kind: "tile",
            id: `tile-${start}`,
            content: { kind: "terminal", session: `protected-${start}` },
          }
        : {
            kind: "split",
            id: `split-${start}-${count}`,
            direction: "horizontal",
            ratio: 1 / count,
            first: tree(start, 1),
            second: tree(start + 1, count - 1),
          };
    localStorage.setItem(
      `foom.tiles.v1.${window.desktop.windows.id}`,
      JSON.stringify({
        version: 2,
        tree: tree(0, count),
        focused: "tile-0",
        maximized: null,
      }),
    );
  }, protectedCount);
  await page.reload();
  await expect(page.locator('.terminal-tile[data-empty="false"]')).toHaveCount(protectedCount);
  await app.evaluate(({ BrowserWindow }, snapshot) => {
    const board = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
    for (const terminal of snapshot.terminals)
      board.webContents.send("terminal:state", terminal.state);
  }, snapshot);
  await expect(page.locator('.board-row[data-state="needs_input"]')).toHaveCount(protectedCount);
  const protectedTree = await page.evaluate(() => {
    const layout = JSON.parse(localStorage.getItem(`foom.tiles.v1.${window.desktop.windows.id}`));
    const depth = (node) =>
      node.kind === "tile" ? 0 : 1 + Math.max(depth(node.first), depth(node.second));
    return { tree: layout.tree, depth: depth(layout.tree) };
  });
  assert.equal(protectedTree.depth, 64);
  const full = await requestPreview("full-reopen", "notes.md");
  assert.equal(full.placement, "sidebar");
  assert.equal(full.reused, false);
  assert.notEqual(full.previewId, reopened.previewId);
  await expect(
    page.getByRole("treeitem", {
      name: "Markdown preview: notes.md, opened by Claude Code, not shown",
    }),
  ).toBeVisible();
  assert.deepEqual((await listPreviews("hidden-list")).previews, [
    {
      previewId: full.previewId,
      path: "notes.md",
      kind: "markdown",
      visible: false,
    },
  ]);
  assert.equal((await previewViewState(app, full.previewId)).attached, false);
  await expect(page.locator('.terminal-tile[data-state="needs_input"]')).toHaveCount(
    protectedCount,
  );
  assert.deepEqual(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem(`foom.tiles.v1.${window.desktop.windows.id}`)).tree,
    ),
    protectedTree.tree,
  );
  // A later explicit open retries ordinary placement when room becomes available.
  await page.evaluate(() =>
    localStorage.setItem(
      `foom.tiles.v1.${window.desktop.windows.id}`,
      JSON.stringify({
        version: 2,
        tree: { kind: "tile", id: "available", content: null },
        focused: "available",
        maximized: null,
      }),
    ),
  );
  await page.reload();
  await expect(page.locator('.terminal-tile[data-empty="true"]')).toHaveCount(1);
  const retry = await requestPreview("retry", "notes.md");
  assert.equal(retry.previewId, full.previewId);
  assert.equal(retry.reused, true);
  assert.equal(retry.placement, "empty");
  await expect.poll(async () => (await previewViewState(app, retry.previewId)).attached).toBe(true);
  assert.equal((await listPreviews("retry-list")).previews[0].visible, true);
});

test("agent previews stay visible after window moves while sidebar inventory is pending", {
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  const { app, page, agent, credentials, requestAgent, requestPreview } =
    await agentPreviewFixture(context);
  await page.getByRole("button", { name: "Actions for Claude Code in main" }).click();
  await page.getByRole("menuitem", { name: "Make orchestrator…" }).click();
  const confirmation = await confirmationPage(app);
  await confirmation.getByRole("button", { name: "Make orchestrator", exact: true }).click();
  assert.equal((await requestAgent("role", ["whoami", "--json"])).role, "orchestrator");
  await sizeTileBoard(app, page, 2400);
  await page.locator('.board-row[data-kind="agent"]').click();
  await expect
    .poll(() =>
      page.evaluate(
        async (id) =>
          (await window.desktop.windows.snapshot()).some(
            (view) => view.id === id && view.window === 0,
          ),
        agent.id,
      ),
    )
    .toBe(true);
  const first = await requestPreview("before-move", "notes.md");
  await movePreviewTile(app, page, first.previewId, async (target) => {
    await target.evaluate(() => window.desktop.appMenu.execute("settings"));
    await expect(target.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    // Gate the expensive sidebar read, without load or a timer override. A
    // placement must not spend its five-second deadline waiting on inventory.
    await app.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get("workspace:sidebar");
      let release;
      const pending = new Promise((resolve) => {
        release = resolve;
      });
      globalThis.releasePreviewInventory = () => {
        release();
        ipcMain.removeHandler("workspace:sidebar");
        ipcMain.handle("workspace:sidebar", original);
      };
      ipcMain.removeHandler("workspace:sidebar");
      ipcMain.handle("workspace:sidebar", async (...args) => {
        await pending;
        return original(...args);
      });
    });
    const actor = JSON.parse(await readFile(`${credentials}.app`, "utf8"));
    const call = async (method, params) => {
      const response = await fetch(actor.controlUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${actor.controlToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ version: 1, instanceId: actor.instanceId, method, params }),
      });
      assert.equal(response.status, 200);
      return (await response.json()).result;
    };
    try {
      const opened = await call("open_preview", { path: "narrow.md" });
      assert.notEqual(opened.placement, "sidebar");
      assert.equal(opened.reused, false);
      await expect(page.locator(`[data-preview-id="${opened.previewId}"]`)).toBeVisible();
      await expect
        .poll(() =>
          previewContents(app, opened.previewId, "document.querySelector('h1')?.textContent", {
            requireAttached: true,
          }),
        )
        .toBe("Narrow notes");
      assert.equal(
        (await call("list_previews", {})).previews.find(
          (preview) => preview.previewId === opened.previewId,
        ).visible,
        true,
      );
      const reused = await call("open_preview", { path: "narrow.md" });
      assert.equal(reused.previewId, opened.previewId);
      assert.equal(reused.placement, "existing");
      assert.equal(reused.reused, true);
      assert.equal(
        (await target.evaluate((id) => window.desktop.previews.describe(id), first.previewId)).id,
        first.previewId,
      );
      await assert.rejects(
        page.evaluate((id) => window.desktop.previews.describe(id), first.previewId),
      );
      await page.evaluate((id) => window.desktop.previews.close(id), opened.previewId);
      await assert.rejects(
        page.evaluate((id) => window.desktop.previews.describe(id), opened.previewId),
      );
    } finally {
      await app.evaluate(() => globalThis.releasePreviewInventory());
    }
  });
});

test("an older human inventory cannot remove an agent preview in a new worktree", {
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  const { app, page, repo, shell, credentials } = await agentPreviewFixture(context);
  isolatedGit(["add", "."], { cwd: repo });
  isolatedGit(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: repo },
  );
  await sizeTileBoard(app, page, 2400);
  await page.evaluate((id) => {
    localStorage.setItem(
      `foom.tiles.v1.${window.desktop.windows.id}`,
      JSON.stringify({
        version: 2,
        focused: "shell",
        maximized: null,
        tree: {
          kind: "split",
          id: "pair",
          direction: "horizontal",
          ratio: 0.5,
          first: { kind: "tile", id: "shell", content: { kind: "terminal", session: id } },
          second: { kind: "tile", id: "inventory-space", content: null },
        },
      }),
    );
  }, shell.id);
  await page.reload();
  await expect(page.locator('[data-tile="shell"] .xterm-helper-textarea')).toBeVisible();
  await app.evaluate((_electron, modulePath) => {
    const load = process.getBuiltinModule("node:module").createRequire(modulePath);
    const { Workspace } = load(modulePath);
    const original = Workspace.prototype.sidebarInventory;
    const snapshot = Workspace.prototype.snapshot;
    const command = Workspace.prototype.sidebarCommand;
    let armed = false;
    let first = true;
    let releaseOld, releaseCurrent;
    const oldGate = new Promise((resolve) => {
      releaseOld = resolve;
    });
    const currentGate = new Promise((resolve) => {
      releaseCurrent = resolve;
    });
    const state = (globalThis.previewInventoryOrder = {
      oldReady: false,
      oldReturned: false,
      snapshotAfterOld: false,
      currentReads: 0,
      releaseOld: () => releaseOld(),
      releaseCurrent: () => releaseCurrent(),
      restore: () => {
        releaseOld();
        releaseCurrent();
        Workspace.prototype.sidebarInventory = original;
        Workspace.prototype.snapshot = snapshot;
        Workspace.prototype.sidebarCommand = command;
      },
    });
    Workspace.prototype.sidebarCommand = async function (...args) {
      const result = await command.apply(this, args);
      if (args[0].kind === "copy-foom-session-id") armed = true;
      return result;
    };
    Workspace.prototype.snapshot = function (...args) {
      if (state.oldReturned) state.snapshotAfterOld = true;
      return snapshot.apply(this, args);
    };
    Workspace.prototype.sidebarInventory = async function () {
      if (!armed) return original.call(this);
      if (first) {
        first = false;
        const inventory = structuredClone(await original.call(this));
        state.oldReady = true;
        await oldGate;
        state.oldReturned = true;
        return inventory;
      }
      state.currentReads++;
      await currentGate;
      return original.call(this);
    };
  }, path.resolve("build/main/workspace/workspace.js"));
  try {
    // This human command has its own inventory read, independent of connect's
    // background-refresh revision. Its next workspace request follows acceptance.
    await page
      .locator('.board-row[data-kind="shell"]')
      .getByRole("button", { name: /^Actions for/ })
      .click();
    const copy = page.getByRole("button", { name: "Copy Foom session ID", exact: true });
    await copy.click();
    await expect
      .poll(() => app.evaluate(() => globalThis.previewInventoryOrder.oldReady))
      .toBe(true);
    const worktree = path.join(path.dirname(repo), "inventory-preview");
    isolatedGit(["worktree", "add", "-b", "inventory-preview", worktree, "HEAD"], { cwd: repo });
    await page.evaluate(
      ({ repo, worktree }) =>
        window.desktop.sidebarCommand({
          kind: "launch",
          repository: repo,
          worktree,
          run: "claude",
        }),
      { repo, worktree },
    );
    const credentialFile = `${credentials}.${path.basename(worktree)}`;
    await expect.poll(() => require("node:fs").existsSync(credentialFile)).toBe(true);
    await expect
      .poll(() => app.evaluate(() => globalThis.previewInventoryOrder.currentReads))
      .toBeGreaterThan(0);
    const actor = JSON.parse(await readFile(credentialFile, "utf8"));
    const call = async (method, params) => {
      const response = await fetch(actor.controlUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${actor.controlToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ version: 1, instanceId: actor.instanceId, method, params }),
      });
      assert.equal(response.status, 200);
      return (await response.json()).result;
    };
    const opened = await call("open_preview", { path: "notes.md" });
    assert.equal(opened.placement, "empty");
    const tile = page.locator(`[data-preview-id="${opened.previewId}"]`);
    await expect(tile).toBeVisible();
    await expect
      .poll(async () => (await call("list_previews", {})).previews[0]?.visible)
      .toBe(true);
    await app.evaluate(() => globalThis.previewInventoryOrder.releaseOld());
    await expect
      .poll(() => app.evaluate(() => globalThis.previewInventoryOrder.snapshotAfterOld))
      .toBe(true);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const afterOld = {
      tile: (await tile.count()) === 1,
      visible: (await call("list_previews", {})).previews[0]?.visible,
    };
    context.diagnostic(`After stale R1: ${JSON.stringify(afterOld)}`);
    assert.deepEqual(afterOld, { tile: true, visible: true });
    await app.evaluate(() => globalThis.previewInventoryOrder.releaseCurrent());
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "inventory-preview", exact: true }),
    ).toBeVisible();
    await expect(tile).toBeVisible();
    await expect
      .poll(() =>
        previewContents(app, opened.previewId, "document.querySelector('h1')?.textContent", {
          requireAttached: true,
        }),
      )
      .toBe("Agent notes");
    await expect
      .poll(async () => (await previewViewState(app, opened.previewId)).visible)
      .toBe(true);
    assert.equal((await call("list_previews", {})).previews[0].visible, true);
    const reused = await call("open_preview", { path: "notes.md" });
    assert.equal(reused.previewId, opened.previewId);
    assert.equal(reused.placement, "existing");
  } finally {
    await app.evaluate(() => globalThis.previewInventoryOrder.restore());
  }
});

test("a human-picked preview survives inventory reads started before and after its reply", {
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  const { app, page, repo } = await agentPreviewFixture(context);
  await sizeTileBoard(app, page, 2400);
  await app.evaluate(
    ({ ipcMain, dialog, BrowserWindow }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      const names = ["preview:pick", "workspace:sidebar", "workspace:snapshot"];
      const original = new Map(names.map((name) => [name, ipcMain._invokeHandlers.get(name)]));
      const reads = [];
      let releasePicker;
      const pickerReply = new Promise((resolve) => {
        releasePicker = resolve;
      });
      let restored = false;
      const state = (globalThis.previewPickerOrder = {
        previewId: null,
        snapshots: 0,
        completed: 0,
        count: () => reads.length,
        releasePicker: () => releasePicker(),
        release: (count) => {
          for (const release of reads.slice(0, count)) release();
        },
        changed: () => {
          for (const window of BrowserWindow.getAllWindows())
            if (window.webContents.getURL() === "app://bundle/index.html")
              window.webContents.send("workspace:changed");
        },
        restore: () => {
          if (restored) return;
          restored = true;
          releasePicker();
          for (const release of reads) release();
          for (const name of names) {
            ipcMain.removeHandler(name);
            ipcMain.handle(name, original.get(name));
          }
        },
      });
      for (const name of names) ipcMain.removeHandler(name);
      ipcMain.handle("preview:pick", async (...args) => {
        state.previewId = await original.get("preview:pick")(...args);
        await pickerReply;
        return state.previewId;
      });
      ipcMain.handle("workspace:sidebar", async (...args) => {
        await new Promise((release) => {
          reads.push(release);
        });
        const inventory = await original.get("workspace:sidebar")(...args);
        state.completed++;
        return inventory;
      });
      ipcMain.handle("workspace:snapshot", (...args) => {
        state.snapshots++;
        return original.get("workspace:snapshot")(...args);
      });
    },
    path.join(repo, "notes.md"),
  );
  try {
    await page
      .getByRole("treeitem", { name: "app", exact: true })
      .getByRole("button", { name: "Actions for Main checkout", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Preview file…", exact: true }).click();
    // Host.open starts a background read before the picker RPC returns. Hold
    // that reply until its read is observable, then identify the picker's read.
    await expect
      .poll(() => app.evaluate(() => globalThis.previewPickerOrder.previewId))
      .toBeTruthy();
    await expect
      .poll(() => app.evaluate(() => globalThis.previewPickerOrder.count()))
      .toBeGreaterThan(0);
    const beforeReply = await app.evaluate(() => globalThis.previewPickerOrder.count());
    await app.evaluate(() => globalThis.previewPickerOrder.releasePicker());
    await expect
      .poll(() => app.evaluate(() => globalThis.previewPickerOrder.count()))
      .toBeGreaterThan(beforeReply);
    const pickerReads = await app.evaluate(() => globalThis.previewPickerOrder.count());
    await app.evaluate(() => globalThis.previewPickerOrder.changed());
    await expect
      .poll(() => app.evaluate(() => globalThis.previewPickerOrder.count()))
      .toBeGreaterThan(pickerReads);
    const newerReads = await app.evaluate(() => globalThis.previewPickerOrder.count());
    const id = await app.evaluate(() => globalThis.previewPickerOrder.previewId);
    const tile = page.locator('.terminal-tile[data-preview-id="' + id + '"]');
    await app.evaluate(
      (_electron, count) => globalThis.previewPickerOrder.release(count),
      pickerReads,
    );
    await expect
      .poll(() => app.evaluate(() => globalThis.previewPickerOrder.completed))
      .toBeGreaterThanOrEqual(pickerReads);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    context.diagnostic("After the picker reply: previewTiles=" + (await tile.count()));
    const snapshots = await app.evaluate(() => globalThis.previewPickerOrder.snapshots);
    await app.evaluate(() => globalThis.previewPickerOrder.changed());
    await expect
      .poll(() => app.evaluate(() => globalThis.previewPickerOrder.count()))
      .toBeGreaterThan(newerReads);
    await expect
      .poll(() => app.evaluate(() => globalThis.previewPickerOrder.snapshots))
      .toBeGreaterThan(snapshots);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    context.diagnostic("After the later row update: previewTiles=" + (await tile.count()));
    await app.evaluate(() => globalThis.previewPickerOrder.restore());
    await expect(page.locator('.preview-row[data-drag-preview="' + id + '"]')).toBeVisible();
    const inventory = await page.evaluate(() => window.desktop.sidebarInventory());
    assert.ok(inventory.previews.some((preview) => preview.id === id));
    context.diagnostic(
      "After all reads: previewTiles=" + (await tile.count()) + ", recordOpen=true",
    );
    await expect(tile).toBeVisible();
    await expect
      .poll(() =>
        previewContents(app, id, "document.querySelector('h1')?.textContent", {
          requireAttached: true,
        }),
      )
      .toBe("Agent notes");
    await expect.poll(async () => (await previewViewState(app, id)).visible).toBe(true);
    await expect(page.getByRole("alertdialog")).not.toBeVisible();
  } finally {
    await app.evaluate(() => globalThis.previewPickerOrder.restore());
  }
});

test("a human-picked preview is tiled when its newest inventory read fails", {
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  const { app, page, repo } = await agentPreviewFixture(context);
  await sizeTileBoard(app, page, 2400);
  await app.evaluate(
    ({ ipcMain, dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      const names = ["preview:pick", "workspace:sidebar", "preview:describe"];
      const original = new Map(names.map((name) => [name, ipcMain._invokeHandlers.get(name)]));
      let releasePicker;
      let failNext = false;
      const pickerReply = new Promise((resolve) => {
        releasePicker = resolve;
      });
      let restored = false;
      const state = (globalThis.previewPickerFailure = {
        id: null,
        failed: false,
        descriptions: 0,
        release: () => {
          failNext = true;
          releasePicker();
        },
        restore: () => {
          if (restored) return;
          restored = true;
          failNext = false;
          releasePicker();
          for (const name of names) {
            ipcMain.removeHandler(name);
            ipcMain.handle(name, original.get(name));
          }
        },
      });
      for (const name of names) ipcMain.removeHandler(name);
      ipcMain.handle("preview:pick", async (...args) => {
        state.id = await original.get("preview:pick")(...args);
        await pickerReply;
        return state.id;
      });
      ipcMain.handle("workspace:sidebar", (...args) => {
        if (failNext) {
          failNext = false;
          state.failed = true;
          throw new Error("Fixture inventory failure");
        }
        return original.get("workspace:sidebar")(...args);
      });
      ipcMain.handle("preview:describe", (...args) => {
        state.descriptions++;
        return original.get("preview:describe")(...args);
      });
    },
    path.join(repo, "notes.md"),
  );
  try {
    await page
      .getByRole("treeitem", { name: "app", exact: true })
      .getByRole("button", { name: "Actions for Main checkout", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Preview file…", exact: true }).click();
    await expect.poll(() => app.evaluate(() => globalThis.previewPickerFailure.id)).toBeTruthy();
    const id = await app.evaluate(() => globalThis.previewPickerFailure.id);
    // The host's workspace event has completed its read before the picker starts
    // the newest read, whose injected rejection must still use owned metadata.
    await expect(page.locator('.preview-row[data-drag-preview="' + id + '"]')).toBeVisible();
    await app.evaluate(() => globalThis.previewPickerFailure.release());
    await expect.poll(() => app.evaluate(() => globalThis.previewPickerFailure.failed)).toBe(true);
    const tile = page.locator('.terminal-tile[data-preview-id="' + id + '"]');
    await expect(tile).toBeVisible();
    assert.equal(await app.evaluate(() => globalThis.previewPickerFailure.descriptions), 1);
    await expect(page.getByRole("alertdialog")).not.toBeVisible();
    await app.evaluate(() => globalThis.previewPickerFailure.restore());
    const inventory = await page.evaluate(() => window.desktop.sidebarInventory());
    assert.ok(inventory.previews.some((preview) => preview.id === id));
    await expect.poll(async () => (await previewViewState(app, id)).visible).toBe(true);
    await expect(tile).toBeVisible();
    context.diagnostic(
      "Newest inventory rejected: recordOpen=true, previewTiles=1, nativeVisible=true",
    );
  } finally {
    await app.evaluate(() => globalThis.previewPickerFailure.restore());
  }
});
