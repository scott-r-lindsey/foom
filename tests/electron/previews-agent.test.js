const { evidencePath } = require("../helpers/evidence.js");
const { gitSync: isolatedGit } = require("../helpers/git.js");
const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { expect } = require("./test-policy.js");
const {
  FAKE_ORCHESTRATED_CLAUDE,
  assertAccessible,
  boardPage,
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
  const root = await mkdtemp(path.join(tmpdir(), "foom-agent-preview-"));
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
  return { app, page, repo, agent, shell, credentials, requestPreview, listPreviews };
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
  // At minimum width, use terminal replacement fallback and protect the focused shell.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setContentSize(900, 640);
  });
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(900);
  const narrow = await requestPreview("narrow", "narrow.md");
  assert.equal(narrow.placement, "replace");
  await expect(page.locator('.terminal-tile[data-kind="preview"]')).toHaveCount(2);
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
  // Supply bounded session metadata at the IPC boundary: no 256 PTYs or real agents.
  // All leaves need the human, so neither growth nor replacement is allowed.
  const snapshot = await page.evaluate(() => window.desktop.workspace());
  const template = snapshot.terminals.find((terminal) => terminal.id === shell.id);
  assert.ok(template);
  snapshot.terminals = Array.from({ length: 256 }, (_, index) => ({
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
  await page.evaluate(() => {
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
            ratio: 0.5,
            first: tree(start, count / 2),
            second: tree(start + count / 2, count / 2),
          };
    localStorage.setItem(
      `foom.tiles.v1.${window.desktop.windows.id}`,
      JSON.stringify({
        version: 2,
        tree: tree(0, 256),
        focused: "tile-0",
        maximized: null,
      }),
    );
  });
  await page.reload();
  await expect(page.locator('.terminal-tile[data-empty="false"]')).toHaveCount(256);
  await app.evaluate(({ BrowserWindow }, snapshot) => {
    const board = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
    for (const terminal of snapshot.terminals)
      board.webContents.send("terminal:state", terminal.state);
  }, snapshot);
  await expect(page.locator('.board-row[data-state="needs_input"]')).toHaveCount(256);
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
