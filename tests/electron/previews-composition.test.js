const { evidencePath } = require("../helpers/evidence.js");
const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const { expect } = require("./test-policy.js");
const { confirmationPage } = require("./harness.js");
const { previewContents, previewViewState, composedPreview } = require("./preview-fixture.js");

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

test("preview composition keeps tile and row panels visible and usable above captured pages", async (context) => {
  const { app, page, id, tile, bounds } = await composedPreview(context, 2);
  await tile.getByRole("button", { name: "Tile 2 menu" }).click();
  await expect(page.getByRole("menuitem", { name: "Split down" })).toBeVisible();
  await expect.poll(async () => (await previewViewState(app, id)).visible).toBe(false);
  await expectPreviewSnapshot(page, id);
  await expect(page.locator(".preview-snapshot")).toHaveCSS("left", `${bounds.x}px`);
  await expect(page.locator(".preview-snapshot")).toHaveCSS("width", `${bounds.width}px`);
  await page.screenshot({
    path: evidencePath("preview-overlays-panel.png"),
    animations: "disabled",
  });
  await page.getByRole("menuitem", { name: "Split down" }).click();
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
  // Lengthen only the product animation being observed, never a test deadline.
  await page.addStyleTag({ content: ".terminal-tile { transition-duration: 1s; }" });
  await tile.getByRole("button", { name: "Maximize tile" }).click();
  await expectPreviewSnapshot(page, id);
  assert.equal((await previewViewState(app, id)).visible, true);
  await tile.getByRole("button", { name: "Restore tile" }).click();
  await expectPreviewSnapshot(page, id);
  await expect.poll(async () => (await previewViewState(app, id)).visible).toBe(true);
  const title = await page.locator('[data-tile="shell"] .tile-title').boundingBox();
  assert.ok(title);
  await page.mouse.move(title.x + 10, title.y + 10);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { steps: 12 });
  await expect(page.locator(".tile-drop-preview")).toBeVisible();
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
