const { evidencePath } = require("../helpers/evidence.js");
const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const { mkdir, readFile, writeFile } = require("node:fs/promises");
const { execFileSync } = require("node:child_process");
const { deadline, expect } = require("./test-policy.js");
const { launchApp, boardPage, launchCheckoutShell } = require("./harness.js");

test("blank-window manual and terminals share the leftmost column geometry", async (context) => {
  const app = await launchApp(context, { fixture: "repository" });
  const page = await boardPage(app);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setContentSize(2200, 1000);
  });
  await page.waitForFunction(() => innerWidth === 2200);
  await page.evaluate(() => window.desktop.appMenu.execute("manual"));
  const manual = page.locator('.terminal-tile[data-kind="preview"]');
  await expect(manual).toBeVisible();
  const geometry = () =>
    page.locator(".terminal-tile").evaluateAll((tiles) =>
      tiles.map((tile) => ({
        left: tile.style.left,
        top: tile.style.top,
        width: tile.style.width,
        height: tile.style.height,
      })),
    );
  const manualGeometry = await geometry();
  assert.equal(manualGeometry.length, 2);
  await expect(page.locator(".terminal-tile").first()).toHaveAttribute("data-kind", "preview");
  await launchCheckoutShell(app, page);
  await expect(page.locator('.terminal-tile[data-kind="shell"]')).toBeVisible();
  assert.deepEqual(await geometry(), manualGeometry);
  if (process.env.FOOM_PLACEMENT_SCREENSHOTS === "1" && process.platform === "linux") {
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
          app.evaluate(async ({ webContents }) => {
            const contents = webContents
              .getAllWebContents()
              .find((entry) => entry.getURL().startsWith("foom-preview://"));
            return contents.executeJavaScript(
              "getComputedStyle(document.documentElement).backgroundColor",
            );
          }),
        )
        .toBe(mode === "dark" ? "rgb(5, 4, 10)" : "rgb(243, 240, 250)");
      await app.evaluate(async ({ webContents }) => {
        const contents = webContents
          .getAllWebContents()
          .find((entry) => entry.getURL().startsWith("foom-preview://"));
        await contents.executeJavaScript(
          "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        );
      });
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      execFileSync("import", [
        "-window",
        String(handle),
        evidencePath(`screenshots-746/manual-terminal-${mode}.png`),
      ]);
    }
  }
  const id = (await page.evaluate(() => window.desktop.sidebarInventory())).previews[0].id;
  await page.evaluate((id) => window.desktop.previews.close(id), id);
  // Return to one blank leaf, then launch a terminal into the same available width.
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
  await launchCheckoutShell(app, page);
  await expect(page.locator('.terminal-tile[data-kind="shell"]')).toBeVisible();
  assert.deepEqual(await geometry(), manualGeometry);
  await expect(page.locator(".terminal-tile").first()).toHaveAttribute("data-kind", "shell");
});

test("Help Manual opens a contained offline guide and focuses the existing tile", {
  timeout: deadline(45000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const openMenu = async () => {
    await page.locator(".wordmark-menu").click();
    await page.getByRole("menuitem", { name: "Help", exact: true }).press("ArrowRight");
    await expect(page.getByRole("menuitem", { name: "Manual", exact: true })).toBeVisible();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  };
  await openMenu();
  await page.getByRole("menuitem", { name: "Manual", exact: true }).click();
  const tile = page
    .locator('.terminal-tile[data-kind="preview"]')
    .filter({ hasText: "manual.html" });
  await expect(tile).toBeVisible();
  const inventory = await page.evaluate(() => window.desktop.sidebarInventory());
  assert.equal(inventory.previews.length, 1);
  const { id } = inventory.previews[0];
  const facts = () =>
    app.evaluate(async ({ webContents }, id) => {
      const contents = webContents
        .getAllWebContents()
        .find((entry) => entry.getURL().startsWith(`foom-preview://${id}/`));
      if (!contents || contents.isLoading()) return null;
      return contents.executeJavaScript(
        `({title: document.title, sections: [...document.querySelectorAll('section')].map(s => s.id), rows: document.querySelectorAll('[data-command]').length, bridge: typeof window.desktop, node: typeof require, dark: matchMedia('(prefers-color-scheme: dark)').matches, background: getComputedStyle(document.documentElement).backgroundColor})`,
      );
    }, id);
  await expect.poll(async () => (await facts())?.title).toBe("Foom manual");
  const document = await facts();
  assert.ok(document.rows > 50);
  assert.equal(document.bridge, "undefined");
  assert.equal(document.node, "undefined");
  assert.equal(new Set(document.sections).size, 12);
  const blocked = await page.evaluate(
    (id) =>
      window.desktop.previews.network(id, true).then(
        () => false,
        () => true,
      ),
    id,
  );
  assert.equal(blocked, true);
  await page.evaluate(() => window.desktop.appMenu.execute("settings"));
  await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();
  await openMenu();
  await page.getByRole("menuitem", { name: "Manual", exact: true }).click();
  await expect(page.getByRole("region", { name: "Settings" })).toBeHidden();
  await page.evaluate(() => window.desktop.appMenu.execute("split-right"));
  await openMenu();
  await page.getByRole("menuitem", { name: "Manual", exact: true }).click();
  assert.equal((await page.evaluate(() => window.desktop.sidebarInventory())).previews.length, 1);
  assert.equal(
    await page.locator('.terminal-tile[data-focused="true"]').getAttribute("data-kind"),
    "preview",
  );
  if (process.platform === "darwin") {
    await app.evaluate(({ Menu }) => {
      const manual = Menu.getApplicationMenu()
        .items.find((item) => item.label === "Help")
        .submenu.items.find((item) => item.id === "manual");
      manual.click();
    });
    assert.equal((await page.evaluate(() => window.desktop.sidebarInventory())).previews.length, 1);
  }
  await page.evaluate(() => window.desktop.appMenu.execute("maximize"));
  for (const mode of ["light", "dark"]) {
    await page.evaluate(
      (colorMode) =>
        window.desktop.saveSetup({
          interfaceTheme: colorMode === "system" ? "follow" : `eclipse-${colorMode}`,
        }),
      mode,
    );
    await expect.poll(async () => (await facts())?.dark).toBe(mode === "dark");
    if (process.env.FOOM_MANUAL_SCREENSHOTS === "1" && process.platform === "linux") {
      await mkdir(evidencePath("screenshots-680"), { recursive: true });
      const handle = await app.evaluate(({ BrowserWindow }) => {
        const board = BrowserWindow.getAllWindows().find(
          (window) => window.webContents.getURL() === "app://bundle/index.html",
        );
        board.setBounds({ x: 0, y: 0, width: 1240, height: 850 });
        return board.getNativeWindowHandle().readUInt32LE();
      });
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
      execFileSync("import", [
        "-window",
        String(handle),
        evidencePath(`screenshots-680/manual-${mode}.png`),
      ]);
      await openMenu();
      execFileSync("import", [
        "-window",
        String(handle),
        evidencePath(`screenshots-680/menu-${mode}.png`),
      ]);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
    }
  }
  await page.evaluate(() => window.desktop.appMenu.execute("new-window"));
  await expect
    .poll(
      () =>
        app.windows().filter((candidate) => candidate.url() === "app://bundle/index.html").length,
    )
    .toBe(2);
  const other = app
    .windows()
    .find((candidate) => candidate !== page && candidate.url() === "app://bundle/index.html");
  assert.ok(other);
  await other.getByRole("navigation", { name: "Terminal sidebar" }).waitFor();
  await other.waitForFunction(() => document.hasFocus());
  await other.evaluate(() => window.desktop.appMenu.execute("manual"));
  assert.equal((await other.evaluate(() => window.desktop.sidebarInventory())).previews.length, 0);
  assert.equal((await page.evaluate(() => window.desktop.sidebarInventory())).previews.length, 1);
  await expect
    .poll(() => app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL()))
    .toBe(`foom-preview://${id}/manual.html`);
  await page.evaluate((id) => window.desktop.previews.close(id), id);
  await expect(tile).toHaveCount(0);
  await page.evaluate(() => window.desktop.appMenu.execute("manual"));
  await expect(tile).toBeVisible();
  assert.notEqual(
    (await page.evaluate(() => window.desktop.sidebarInventory())).previews[0].id,
    id,
  );
});

test("bundled manual search supports keyboard navigation and section jumps", async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  await page.evaluate(() => window.desktop.appMenu.execute("manual"));
  await expect(page.locator('.terminal-tile[data-kind="preview"]')).toBeVisible();
  const run = (code) =>
    app.evaluate(async ({ webContents }, code) => {
      const contents = webContents
        .getAllWebContents()
        .find((entry) => entry.getURL().startsWith("foom-preview://"));
      if (!contents || contents.isLoading()) return null;
      return contents.executeJavaScript(code);
    }, code);
  const key = (keyCode, modifiers = [], char = false) =>
    app.evaluate(
      ({ webContents }, { keyCode, modifiers, char }) => {
        const contents = webContents
          .getAllWebContents()
          .find((entry) => entry.getURL().startsWith("foom-preview://"));
        contents.focus();
        contents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
        if (char) contents.sendInputEvent({ type: "char", keyCode, modifiers });
        contents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      },
      { keyCode, modifiers, char },
    );
  const type = async (value) => {
    for (const character of value) await key(character, [], true);
  };
  await expect
    .poll(() => run("typeof document.querySelector('#manual-query')?.oninput"))
    .toBe("object");
  const index = JSON.parse(await readFile("build/manual/sections.json", "utf8"));
  assert.equal(index.length, 12);
  assert.deepEqual(
    index.map((section) => section.id),
    await run("Array.from(document.querySelectorAll('main section[id]'), section => section.id)"),
  );
  assert.match(index.find((section) => section.id === "shortcuts").text, /New Window/);
  await key("/");
  await expect.poll(() => run("document.activeElement.id")).toBe("manual-query");
  await type("worktree");
  await expect
    .poll(() => run("document.querySelectorAll('[role=option]').length"))
    .toBeGreaterThan(1);
  await key("Down");
  await expect
    .poll(() =>
      run("document.querySelector('#manual-query').getAttribute('aria-activedescendant')"),
    )
    .toBe("manual-result-1");
  await key("Up");
  await key("Return");
  await expect.poll(() => run("document.activeElement.id")).toBe("getting-started");
  assert.equal(
    await run("document.querySelector('#getting-started').classList.contains('search-hit')"),
    true,
  );
  assert.ok(
    await run(
      "Math.abs(document.querySelector('#getting-started').getBoundingClientRect().top - 80) < 2",
    ),
  );
  await key("f", [process.platform === "darwin" ? "meta" : "control"]);
  await expect.poll(() => run("document.activeElement.id")).toBe("manual-query");
  await type("resumable");
  await expect.poll(() => run("document.querySelectorAll('[role=option]').length")).toBe(1);
  assert.match(await run("document.querySelector('[role=option] span').textContent"), /resumable/);
  await key("Return");
  await expect.poll(() => run("document.activeElement.id")).toBe("repositories");
  await key("/");
  await type("no-section-matches-this");
  await expect.poll(() => run("document.querySelectorAll('[role=option]').length")).toBe(0);
  assert.equal(await run("document.querySelector('#manual-results').hidden"), true);
  await key("Escape");
  assert.equal(await run("document.querySelector('#manual-query').value"), "");
  await type("worktree");
  await run("document.querySelectorAll('[role=option]')[1].click()");
  await expect.poll(() => run("document.activeElement.id")).toBe("repositories");
  if (process.env.FOOM_MANUAL_SCREENSHOTS === "1") {
    await mkdir(evidencePath("screenshots-681"), { recursive: true });
    await key("/");
    await type("worktree");
    for (const mode of ["light", "dark"]) {
      await page.evaluate(
        (colorMode) =>
          window.desktop.saveSetup({
            interfaceTheme: colorMode === "system" ? "follow" : `eclipse-${colorMode}`,
          }),
        mode,
      );
      await expect
        .poll(() => run("matchMedia('(prefers-color-scheme: dark)').matches"))
        .toBe(mode === "dark");
      const png = await app.evaluate(async ({ webContents }) => {
        const contents = webContents
          .getAllWebContents()
          .find((entry) => entry.getURL().startsWith("foom-preview://"));
        return (await contents.capturePage()).toDataURL();
      });
      await writeFile(
        evidencePath(`screenshots-681/manual-search-${mode}.png`),
        Buffer.from(png.split(",")[1], "base64"),
      );
    }
  }
});
