const { evidencePath } = require("../helpers/evidence.js");
const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { writeFile } = require("node:fs/promises");
const { expect } = require("./test-policy.js");
const { boardPage, confirmationPage, launchApp } = require("./harness.js");
const {
  composedPreview,
  pickPreviewFile,
  previewContents,
  previewViewState,
} = require("./preview-fixture.js");
const { expectTileHeaderHitTargets, sizeTileBoard } = require("./tile-fixture.js");

async function expectPreviewSnapshot(page, id) {
  const snapshot = page.locator(`.preview-snapshot[data-preview="${id}"]`);
  await expect(snapshot).toBeVisible();
  await expect
    .poll(() =>
      snapshot.evaluate((canvas) =>
        Array.from(
          canvas.getContext("2d").getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data,
        ),
      ),
    )
    .toEqual([18, 52, 86, 255]);
  await expect(snapshot).toHaveCSS("pointer-events", "none");
}

test("short preview tiles keep their native views attached when zoom wraps the headers", async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  await sizeTileBoard(app, page, 1280, 720);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const [terminal] = (await page.evaluate(() => window.desktop.workspace())).terminals;
  const previews = [];
  for (let index = 0; index < 6; index++) {
    const file = `stack-${index}.html`;
    await writeFile(path.join(terminal.worktree, file), "<p>Stacked preview</p>");
    const id = await pickPreviewFile(app, page, terminal.worktree, file);
    assert.ok(id);
    previews.push(id);
  }
  await page.evaluate(
    ({ previews, session }) => {
      const stack = (index) => {
        const tile = {
          kind: "tile",
          id: `tile-${index}`,
          content: { kind: "preview", preview: previews[index] },
        };
        return index === previews.length - 1
          ? tile
          : {
              kind: "split",
              id: `row-${index}`,
              direction: "vertical",
              ratio: 1 / (previews.length - index),
              first: tile,
              second: stack(index + 1),
            };
      };
      localStorage.setItem(
        `foom.tiles.v1.${window.desktop.windows.id}`,
        JSON.stringify({
          version: 2,
          focused: "tile-0",
          tree: {
            kind: "split",
            id: "columns",
            direction: "horizontal",
            ratio: 0.18,
            first: stack(0),
            second: { kind: "tile", id: "shell", content: { kind: "terminal", session } },
          },
        }),
      );
    },
    { previews, session: terminal.id },
  );
  await page.reload();
  const tiles = page.locator(".terminal-tile[data-preview-id]");
  await expect(tiles).toHaveCount(previews.length);
  const first = page.locator(`[data-preview-id="${previews[0]}"]`);
  await expect.poll(async () => (await previewViewState(app, previews[0])).visible).toBe(true);
  await first.getByRole("button", { name: "Tile 1 menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Allow network…", exact: true }).click();
  const confirmation = await confirmationPage(app);
  await confirmation.getByRole("button", { name: "Allow network", exact: true }).click();
  await expect(page.locator(".board-confirmation-scrim")).toHaveCount(0);
  const network = first.getByRole("img", { name: "Network enabled", exact: true });
  await expect(network).toBeVisible();
  const initialPixelRatio = await page.evaluate(() => devicePixelRatio);
  await page.evaluate(() =>
    window.desktop.saveSetup({ interfaceScale: 250, terminalFontSize: 10 }),
  );
  await expect
    .poll(() => page.evaluate(() => devicePixelRatio))
    .toBeCloseTo(initialPixelRatio * 2.5);
  // Reproduce the smaller display's content area on runners with larger work areas.
  const window = await app.browserWindow(page);
  try {
    await window.evaluate((window) => window.setMinimumSize(1, 1));
    await sizeTileBoard(app, page, 512, 288);
  } finally {
    await window.dispose();
  }
  await expect.poll(() => first.evaluate((tile) => tile.offsetWidth)).toBeLessThan(100);
  await expect
    .poll(() => tiles.evaluateAll((tiles) => Math.min(...tiles.map((tile) => tile.offsetHeight))))
    .toBeLessThan(55);

  for (const [index, id] of previews.entries()) {
    const tile = page.locator(`[data-preview-id="${id}"]`);
    const body = tile.locator(".tile-shell:visible");
    await expect(body).toBeVisible();
    await expect
      .poll(async () => {
        const view = await previewViewState(app, id);
        return view.attached && view.visible && view.bounds.height > 0;
      })
      .toBe(true);
    await expectTileHeaderHitTargets(tile, [
      `Tile ${index + 1} menu`,
      "Maximize tile",
      "Reload",
      "Close",
    ]);
  }
  for (const mark of [first.locator(".preview-glyph"), network.locator("svg")]) {
    assert.ok(
      await mark.evaluate((icon) => {
        const { left, right, top, bottom } = icon.getBoundingClientRect();
        return icon.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2));
      }),
    );
  }
});

test("preview composition keeps tile and row panels visible and usable above captured pages", async (context) => {
  const { app, page, id, tile, bounds } = await composedPreview(context, 2);
  await tile.getByRole("button", { name: "Tile 2 menu" }).click();
  await expect(page.getByRole("menuitem", { name: "Split terminal up" })).toBeVisible();
  await expect.poll(async () => (await previewViewState(app, id)).visible).toBe(false);
  await expectPreviewSnapshot(page, id);
  await expect(page.locator(".preview-snapshot")).toHaveCSS("left", `${bounds.x}px`);
  await expect(page.locator(".preview-snapshot")).toHaveCSS("width", `${bounds.width}px`);
  await page.screenshot({
    path: evidencePath("preview-overlays-panel.png"),
    animations: "disabled",
  });
  await page.getByRole("menuitem", { name: "Split terminal up" }).click();
  await expect(page.locator(".terminal-tile")).toHaveCount(3);
  await expect.poll(async () => (await previewViewState(app, id)).visible).toBe(true);
  await page.locator(".board-row").first().click({ button: "right" });
  await expect(page.locator(".row-menu")).toBeVisible();
  await expectPreviewSnapshot(page, id);
  await page.reload();
  await expect(page.locator(".row-menu")).toHaveCount(0);
  await expectPreviewSnapshot(page, id);
  await expect.poll(async () => (await previewViewState(app, id)).visible).toBe(true);
});

test("preview composition puts the trusted confirmation scrim above previews and restores on cancel", async (context) => {
  const { app, page, id } = await composedPreview(context);
  await app.evaluate(({ app }) => app.quit());
  const dialog = await confirmationPage(app);
  await expect(page.locator(".board-confirmation-scrim:popover-open")).toBeVisible();
  await expect.poll(async () => (await previewViewState(app, id)).visible).toBe(false);
  await expectPreviewSnapshot(page, id);
  await page.screenshot({
    path: evidencePath("preview-overlays-scrim.png"),
    animations: "disabled",
  });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".board-confirmation-scrim")).toHaveCount(0);
  await expectPreviewSnapshot(page, id);
  await expect.poll(async () => (await previewViewState(app, id)).visible).toBe(true);
  assert.equal((await previewViewState(app, id)).focused, false);
});

test("preview composition keeps maximize and restore live and excludes preview hit testing throughout tile drags", async (context) => {
  const { app, page, id, tile, bounds } = await composedPreview(context);
  await page.evaluate(() => {
    window.previewDragTrace = [];
    for (const type of ["pointerdown", "dragstart", "dragover", "dragend"]) {
      document.addEventListener(
        type,
        (event) => {
          window.previewDragTrace.push({
            type,
            at: performance.now(),
            tile: event.target.closest?.("[data-tile]")?.dataset.tile,
            x: event.clientX,
            y: event.clientY,
          });
          if (window.previewDragTrace.length > 64) window.previewDragTrace.shift();
        },
        true,
      );
    }
  });
  // Lengthen only the product animation being observed, never a test deadline.
  await page.addStyleTag({ content: ".terminal-tile { transition-duration: 1s; }" });
  await tile.getByRole("button", { name: "Maximize tile" }).click();
  await expectPreviewSnapshot(page, id);
  assert.equal((await previewViewState(app, id)).visible, true);
  await tile.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
  await tile.getByRole("button", { name: "Restore tile" }).click();
  await expectPreviewSnapshot(page, id);
  await expect.poll(async () => (await previewViewState(app, id)).visible).toBe(true);
  // A live native view and decoded snapshot precede restore's geometry transition.
  // Until it finishes, the preview can still cover the shell's title at mouse-down.
  await page.locator(".terminal-tile").evaluateAll(async (elements) => {
    await Promise.all(
      elements.flatMap((element) => element.getAnimations().map((animation) => animation.finished)),
    );
  });
  const title = await page.locator('[data-tile="shell"] .tile-title').boundingBox();
  assert.ok(title);
  await page.mouse.move(title.x + 10, title.y + 10);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { steps: 12 });
  try {
    await expect
      .poll(() =>
        page.evaluate(
          () => window.previewDragTrace.find((event) => event.type === "dragstart")?.tile,
        ),
      )
      .toBe("shell");
    await expect(page.locator(".tile-drop-preview")).toBeVisible();
  } catch (error) {
    context.diagnostic(JSON.stringify(await page.evaluate(() => window.previewDragTrace)));
    throw error;
  }
  await expectPreviewSnapshot(page, id);
  assert.equal((await previewViewState(app, id)).visible, false);
  await page.screenshot({
    path: evidencePath("preview-overlays-drag.png"),
    animations: "disabled",
  });
  assert.equal(await previewContents(app, id, "window.pointerCount"), 0);
  await page.mouse.up();
  await expect(page.locator(".tile-drop-preview")).toHaveCount(0);
  await expect.poll(async () => (await previewViewState(app, id)).visible).toBe(true);
});

// A frame is covered by either the visible native child or opaque decoded pixels.
// Sample throughout each action, including its first frame, rather than waiting
// for a snapshot to eventually appear (which concealed the original black gap).
async function assertPreviewFrames(app, page, id, action, liveOnly = false) {
  const frames = [];
  let finished = false;
  const operation = action().finally(() => {
    finished = true;
  });
  try {
    do {
      frames.push(
        await app.evaluate(async ({ BrowserWindow }, id) => {
          const board = BrowserWindow.getAllWindows().find(
            (window) => window.webContents.getURL() === "app://bundle/index.html",
          );
          const view = board.contentView.children.find((view) =>
            view.webContents?.getURL().startsWith(`foom-preview://${id}/`),
          );
          const live = Boolean(view?.getVisible());
          const opaque = await board.webContents.executeJavaScript(`(() => {
          const canvas = document.querySelector('.preview-snapshot[data-preview="${id}"]');
          if (!canvas || !canvas.width || !canvas.height || getComputedStyle(canvas).visibility === 'hidden') return false;
          return [[.1,.1],[.5,.5],[.9,.9]].every(([x,y]) => canvas.getContext('2d').getImageData(Math.floor(canvas.width*x),Math.floor(canvas.height*y),1,1).data[3] === 255);
        })()`);
          return { live, opaque, attached: Boolean(view) };
        }, id),
      );
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    } while (!finished);
  } finally {
    await operation;
  }
  assert.ok(frames.length);
  for (const frame of frames) {
    assert.ok(frame.live || frame.opaque, `Empty preview frame: ${JSON.stringify(frame)}`);
    assert.ok(frame.attached, "Composition must not remove the native child");
    if (liveOnly) assert.ok(frame.live, "Geometry animations must keep the preview live");
  }
}

async function previewFrameRegression(context, file, content) {
  const { app, page, id, tile } = await composedPreview(context, 1, content, file);
  const settle = () =>
    tile.evaluate(async (element) => {
      await Promise.all(
        element.getAnimations().map((animation) => animation.finished.catch(() => {})),
      );
    });
  await assertPreviewFrames(
    app,
    page,
    id,
    async () => {
      await tile.getByRole("button", { name: "Maximize tile" }).click();
      await settle();
    },
    true,
  );
  await assertPreviewFrames(
    app,
    page,
    id,
    async () => {
      await tile.getByRole("button", { name: "Restore tile" }).click();
      await settle();
    },
    true,
  );
  await assertPreviewFrames(app, page, id, async () => {
    await tile.getByRole("button", { name: "Tile 2 menu" }).click();
    await expect.poll(async () => (await previewViewState(app, id)).visible).toBe(false);
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await previewViewState(app, id)).visible).toBe(true);
  });
  await assertPreviewFrames(app, page, id, async () => {
    await app.evaluate(({ app }) => app.quit());
    const dialog = await confirmationPage(app);
    await expect(page.locator(".board-confirmation-scrim:popover-open")).toBeVisible();
    await expect.poll(async () => (await previewViewState(app, id)).visible).toBe(false);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.poll(async () => (await previewViewState(app, id)).visible).toBe(true);
  });
}

test("preview composition has no empty frames for a realistic HTML page", async (context) => {
  const content = `<!doctype html><html><head><style>
    html { background:#edf1f8; color:#243149; font:16px system-ui; }
    body { margin:0; } header { padding:32px; background:#263953; color:white; }
    main { padding:24px; display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:20px; }
    article { background:white; padding:24px; border-radius:12px; box-shadow:0 2px 8px #abc; }
    svg { width:100%; height:100px; } code { background:#edf1f8; }
  </style></head><body><header><h1>Release dashboard</h1><p>Build progress across active projects</p><input placeholder="Filter projects"></header><main>
  ${Array.from({ length: 24 }, (_, i) => `<article><h2>Project ${i + 1}</h2><p>Review the latest build and deployment notes.</p><svg viewBox="0 0 200 100"><path d="M0 90 L40 60 L80 75 L130 20 L200 10" fill="none" stroke="#5679a5" stroke-width="5"/></svg><code>build ${i + 100}</code><ul><li>Assets compiled</li><li>Checks complete</li></ul></article>`).join("")}
  </main></body></html>`;
  await previewFrameRegression(context, "dashboard.html", content);
});

test("preview composition has no empty frames for a Markdown page", async (context) => {
  await previewFrameRegression(
    context,
    "notes.md",
    "# Release notes\n\n" +
      Array.from(
        { length: 80 },
        (_, i) =>
          `## Project ${i + 1}\n\nReview **compiled assets**, deployment notes, and \`build checks\`.\n\n- Ready for review\n- Documentation updated\n`,
      ).join("\n"),
  );
});

test("preview gutter drags keep the native view attached and resize it in place", async (context) => {
  const { app, page, id, tile, bounds } = await composedPreview(context);
  const gutter = page.getByRole("separator", { name: "Resize tiles" });
  const handle = await gutter.boundingBox();
  assert.ok(handle);
  const y = handle.y + handle.height / 2;
  await page.mouse.move(handle.x + handle.width / 2, y);
  await page.mouse.down();
  await expect(gutter).toHaveAttribute("data-dragging", "true");
  // Every step leaves the view attached: no hide/show churn and no snapshot swap.
  for (const offset of [20, 40, 60, 80]) {
    await page.mouse.move(handle.x - offset, y);
    await expect(gutter).not.toHaveAttribute("aria-valuenow", "50");
    assert.equal((await previewViewState(app, id)).attached, true);
  }
  assert.equal((await previewViewState(app, id)).visible, true);
  await page.mouse.up();
  await expect(gutter).toHaveAttribute("data-dragging", "false");
  const finalBounds = await tile.locator(".tile-shell:not([hidden])").boundingBox();
  assert.ok(finalBounds);
  assert.ok(finalBounds.width > bounds.width);
  await expect
    .poll(async () => (await previewViewState(app, id)).bounds)
    .toEqual({
      x: Math.round(finalBounds.x),
      y: Math.round(finalBounds.y),
      width: Math.round(finalBounds.width),
      height: Math.round(finalBounds.height),
    });
  assert.equal((await previewViewState(app, id)).attached, true);
});
