const { gitSync: isolatedGit } = require("../helpers/git.js");
const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, mkdtemp, readFile, realpath, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { expect } = require("./test-policy.js");
const {
  boardPage,
  confirmationPage,
  launchApp,
  quitAndWait,
  removeAfterApps,
} = require("./harness.js");
const {
  pickPreviewFile,
  previewStep,
  previewContents,
  previewViewState,
} = require("./preview-fixture.js");

test("worktree panel previews pick contained Markdown and HTML, persist v2 tiles and close on removal", async (context) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-panel-previews-")));
  removeAfterApps(context, root);
  const repo = path.join(root, "repo");
  const checkout = path.join(root, "checkout");
  const profile = path.join(root, "profile");
  await mkdir(repo);
  const git = (...args) =>
    isolatedGit(["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: repo,
    });
  git("init", "-q", "-b", "main");
  await writeFile(path.join(repo, "guide.md"), "# Panel Markdown\n\nLocal preview.\n");
  await writeFile(path.join(repo, "page.html"), "<!doctype html><h1>Panel HTML</h1>");
  git("add", ".");
  git("commit", "-qm", "preview fixtures");
  git("worktree", "add", "-b", "topic/preview", checkout);
  const options = {
    fixture: "empty-board",
    args: [`--user-data-dir=${profile}`],
    home: path.join(root, "home"),
  };
  let app = await launchApp(context, options);
  let page = await boardPage(app);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
  }, repo);
  await page.getByRole("button", { name: "Add repository", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Actions for topic/preview", exact: true }),
  ).toBeVisible();
  // A deliberate split establishes the landing spot before the first open.
  await page.evaluate(() => window.desktop.appMenu.execute("split-right"));
  const landing = await page.locator('[data-landing="true"]').getAttribute("data-tile");
  const ids = [];
  for (const file of ["guide.md", "page.html"]) {
    await app.evaluate(
      ({ dialog }, file) => {
        dialog.showOpenDialog = async (_window, options) => {
          globalThis.previewPickerOptions = options;
          // Native pickers can blur the pending command before their IPC resolves.
          await _window.webContents.executeJavaScript("document.activeElement?.blur()");
          return { canceled: false, filePaths: [file] };
        };
      },
      path.join(checkout, file),
    );
    await page.getByRole("button", { name: "Actions for topic/preview", exact: true }).click();
    await page.getByRole("menuitem", { name: "Preview file…", exact: true }).click();
    const tile = page.locator('.terminal-tile[data-kind="preview"]').filter({ hasText: file });
    await expect(tile).toBeVisible();
    if (file === "guide.md") assert.equal(await tile.getAttribute("data-tile"), landing);
    const inventory = await page.evaluate(() => window.desktop.sidebarInventory());
    const preview = inventory.previews.find((preview) => preview.relativePath === file);
    assert.ok(preview);
    ids.push(preview.id);
    assert.equal(await app.evaluate(() => globalThis.previewPickerOptions.defaultPath), checkout);
    await expect(page.locator(".row-menu")).toHaveCount(0);
    await expect.poll(async () => (await previewViewState(app, preview.id)).attached).toBe(true);
    await expect
      .poll(() => previewContents(app, preview.id, "document.body.innerText"))
      .toContain(file === "guide.md" ? "Panel Markdown" : "Panel HTML");
    assert.equal((await previewViewState(app, preview.id)).focused, false);
  }
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem(`foom.tiles.v1.${window.desktop.windows.id}`)),
  );
  assert.equal(saved.version, 2);
  assert.equal(JSON.stringify(saved).includes(checkout), false);
  for (const id of ids) assert.ok(JSON.stringify(saved).includes(id));
  await writeFile(path.join(checkout, ".hidden.html"), "hidden");
  await writeFile(path.join(checkout, "unsupported.txt"), "unsupported");
  await writeFile(path.join(root, "outside.html"), "outside");
  for (const file of [
    path.join(root, "outside.html"),
    path.join(checkout, ".hidden.html"),
    path.join(checkout, "unsupported.txt"),
  ]) {
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, file);
    await page.getByRole("button", { name: "Actions for topic/preview", exact: true }).click();
    await page.getByRole("menuitem", { name: "Preview file…", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.locator('.terminal-tile[data-kind="preview"]')).toHaveCount(2);
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  }
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await page.getByRole("button", { name: "Actions for topic/preview", exact: true }).click();
  await page.getByRole("menuitem", { name: "Preview file…", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await quitAndWait(app, () => app.evaluate(({ app }) => app.quit()));
  app = await launchApp(context, { ...options, fixture: "restored" });
  page = await boardPage(app);
  await expect(page.locator('.terminal-tile[data-kind="preview"]')).toHaveCount(2);
  for (const id of ids)
    await expect.poll(async () => (await previewViewState(app, id)).attached).toBe(true);
  await page.getByRole("button", { name: "Actions for topic/preview", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete worktree…", exact: true }).click();
  const removal = await confirmationPage(app);
  await removal.getByRole("button", { name: "Discard 2 changes and remove", exact: true }).click();
  await expect(page.locator(".preview-row")).toHaveCount(0);
  await expect(page.locator('.terminal-tile[data-kind="preview"]')).toHaveCount(0);
  await expect
    .poll(
      async () => (await page.evaluate(() => window.desktop.sidebarInventory())).previews.length,
    )
    .toBe(0);
  assert.equal(
    await app.evaluate(
      ({ webContents }) =>
        webContents
          .getAllWebContents()
          .filter((contents) => contents.getURL().startsWith("foom-preview:")).length,
    ),
    0,
  );
});

test("Markdown previews render hostile documents safely, follow native theme and navigate to a sibling", async (context) => {
  const app = await launchApp(context, { fixture: "repository" });
  const page = await boardPage(app);
  const root = (await page.evaluate(() => window.desktop.workspace())).repositories[0].path;
  // The malformed remote image port also exercises Chromium's rejected-resource
  // path. Electron 44's development security warnings may throw Invalid URL for
  // that performance entry; it does not invalidate the preview's document URL.
  const hostile = await readFile(path.join(__dirname, "../fixtures/previews/hostile.md"), "utf8");
  await writeFile(
    path.join(root, "document.md"),
    `${hostile}\n\n- [x] Done\n\n[Sibling](sibling.md)\n\n[External](https://example.com)`,
  );
  await writeFile(
    path.join(root, "sibling.md"),
    "# Sibling document\n\n```js\nconst answer = 42;\n```\n",
  );
  const id = await previewStep("open Markdown document", () =>
    pickPreviewFile(app, page, root, "document.md"),
  );
  const read = (code) => previewContents(app, id, code, { requireAttached: true });
  await page.evaluate(
    (id) =>
      window.desktop.previews.bounds(id, {
        x: 350,
        y: 100,
        width: 400,
        height: 250,
        visible: true,
      }),
    id,
  );
  await expect
    .poll(
      async () => {
        const state = await previewViewState(app, id);
        return state.attached && !state.loading;
      },
      { message: "Markdown document attached and loaded" },
    )
    .toBe(true);
  assert.equal(await read('document.querySelector("h1")?.textContent'), "Hostile Markdown");
  assert.deepEqual(
    await read(
      `({
    pwned: window.__pwned ?? null,
    frames: document.querySelectorAll("iframe").length,
    handlers: [...document.querySelectorAll("*")].flatMap(element => element.getAttributeNames()).filter(name => /^on/i.test(name)),
    unsafe: [...document.querySelectorAll("a")].filter(link => /^(javascript|vbscript|data|file):/i.test(link.getAttribute("href"))).length,
    scripts: document.scripts.length,
    task: document.querySelector('input[type="checkbox"]')?.disabled,
    external: document.querySelector('a[href="https://example.com"]')?.className,
  })`,
    ),
    {
      pwned: null,
      frames: 0,
      handlers: [],
      unsafe: 0,
      scripts: 2,
      task: true,
      external: "external",
    },
  );
  for (const [mode, background] of [
    ["dark", "rgb(5, 4, 10)"],
    ["light", "rgb(243, 240, 250)"],
  ]) {
    await page.evaluate(
      (colorMode) =>
        window.desktop.saveSetup({
          interfaceTheme: colorMode === "system" ? "follow" : `eclipse-${colorMode}`,
        }),
      mode,
    );
    await expect
      .poll(() => read("getComputedStyle(document.documentElement).backgroundColor"))
      .toBe(background);
  }
  const oldContents = (await previewViewState(app, id)).contentsId;
  await read(`document.querySelector('a[href="sibling.md"]').click()`);
  await expect
    .poll(
      async () => {
        const state = await previewViewState(app, id);
        return state.attached && !state.loading && state.contentsId !== oldContents;
      },
      { message: "Sibling Markdown replacement attached and loaded" },
    )
    .toBe(true);
  assert.equal(await read('document.querySelector("h1")?.textContent'), "Sibling document");
  assert.equal(await read("location.pathname"), "/sibling.md");
  assert.equal(await read('document.querySelector(".hljs-keyword")?.textContent'), "const");
  assert.equal((await previewViewState(app, id)).focused, false);
  await page.evaluate((id) => window.desktop.previews.close(id), id);
});
