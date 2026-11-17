const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { writeFile } = require("node:fs/promises");
const { expect } = require("./test-policy.js");
const { composedPreview, previewContents, previewViewState } = require("./preview-fixture.js");
const { evidencePath } = require("../helpers/evidence.js");

for (const kind of ["md", "html"]) {
  test(`preview history restores scroll, goes forward and recovers missing ${kind} links`, async (context) => {
    const link = (name, target) =>
      kind === "md" ? `[${name}](${target})` : `<a href="${target}">${name}</a>`;
    const original =
      kind === "md"
        ? `# Original document\n\n${link("Next chapter", `next.${kind}`)}\n\n${"A paragraph of the original document.\n\n".repeat(180)}`
        : `<h1>Original document</h1>${link("Next chapter", `next.${kind}`)}<div style="height:5000px">Original content</div>`;
    const { app, page, id, tile } = await composedPreview(context, 1, original, `start.${kind}`);
    const root = (await page.evaluate(() => window.desktop.workspace())).terminals[0].worktree;
    await writeFile(
      path.join(root, `next.${kind}`),
      kind === "md"
        ? `# Next chapter\n\n${link("Missing chapter", `missing.${kind}`)}`
        : `<h1>Next chapter</h1>${link("Missing chapter", `missing.${kind}`)}`,
    );
    const text = () =>
      previewContents(app, id, "document.body.textContent", { requireAttached: true });
    const loaded = (value) => expect.poll(text).toContain(value);
    const clickLink = async (label) => {
      await previewContents(
        app,
        id,
        `Array.from(document.querySelectorAll('a')).find(a => a.textContent === ${JSON.stringify(label)}).click()`,
      );
    };
    await loaded("Original document");
    await expect(tile.getByRole("button", { name: "Back", exact: true })).toHaveCount(0);
    await previewContents(app, id, "window.scrollTo(0, 1200)");
    await expect.poll(() => previewContents(app, id, "window.scrollY")).toBe(1200);
    await clickLink("Next chapter");
    await loaded("Next chapter");
    assert.equal(await previewContents(app, id, "window.scrollY"), 0);
    const back = tile.getByRole("button", { name: "Back", exact: true });
    const forward = tile.getByRole("button", { name: "Forward", exact: true });
    await expect(back).toBeEnabled();
    await expect(forward).toBeDisabled();
    await back.click();
    await loaded("Original document");
    await expect.poll(() => previewContents(app, id, "window.scrollY")).toBe(1200);
    await expect(back).toBeDisabled();
    await forward.click();
    await loaded("Next chapter");
    await tile.getByRole("button", { name: "Reload", exact: true }).click();
    await loaded("Next chapter");
    await clickLink("Missing chapter");
    await loaded("File not found. Waiting for it to appear.");
    assert.ok((await text()).includes(`missing.${kind}`));
    await expect(back).toBeEnabled();
    await expect(forward).toBeDisabled();
    if (process.env.FOOM_SCREENSHOTS === "1") {
      for (const theme of ["light", "dark"]) {
        await page.evaluate(
          (theme) => window.desktop.saveSetup({ interfaceTheme: `eclipse-${theme}` }),
          theme,
        );
        await app.evaluate(({ nativeTheme }, theme) => {
          nativeTheme.themeSource = theme;
        }, theme);
        // Window capture includes the board's inert preview canvas. Reload also
        // refreshes that canvas after the native page adopts its new scheme.
        await page.evaluate((id) => {
          window.previewScreenshotReady = new Promise((resolve) => {
            const off = window.desktop.previews.onSnapshots((snapshots) => {
              if (snapshots.some((snapshot) => snapshot.id === id)) {
                off();
                resolve();
              }
            });
          });
          return window.desktop.previews.reload(id);
        }, id);
        await loaded("File not found");
        await page.evaluate(() => window.previewScreenshotReady);
        await expect
          .poll(() =>
            previewContents(app, id, "matchMedia('(prefers-color-scheme: dark)').matches"),
          )
          .toBe(theme === "dark");
        await previewContents(
          app,
          id,
          "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        );
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        await app.evaluate(({ webContents }, id) => {
          const contents = webContents
            .getAllWebContents()
            .find((entry) => entry.getURL().startsWith(`foom-preview://${id}/`));
          contents.sendInputEvent({ type: "mouseMove", x: 10, y: 10 });
        }, id);
        await expect
          .poll(() =>
            page.evaluate(
              ({ id, theme }) => {
                const canvas = document.querySelector(`.preview-snapshot[data-preview="${id}"]`);
                const context = canvas?.getContext("2d");
                if (!context) return false;
                const expected = theme === "dark" ? [5, 4, 10] : [243, 240, 250];
                const background = context.getImageData(0, 0, 1, 1).data;
                if (!expected.every((value, index) => value === background[index])) return false;
                const pixels = context.getImageData(20, 35, 280, 65).data;
                return pixels.some(
                  (value, index) => index % 4 !== 3 && value !== expected[index % 4],
                );
              },
              { id, theme },
            ),
          )
          .toBe(true);
        await page.screenshot({ path: evidencePath(`previews-1208/missing-${kind}-${theme}.png`) });
      }
    }
    // The keyboard shortcut traverses the native preview, preserving human focus.
    await app.evaluate(({ webContents }, id) => {
      const contents = webContents
        .getAllWebContents()
        .find((entry) => entry.getURL().startsWith(`foom-preview://${id}/`));
      contents.sendInputEvent({ type: "mouseDown", x: 30, y: 30, button: "left", clickCount: 1 });
      contents.sendInputEvent({ type: "mouseUp", x: 30, y: 30, button: "left", clickCount: 1 });
    }, id);
    await expect.poll(async () => (await previewViewState(app, id)).focused).toBe(true);
    const shortcut = async (direction) =>
      app.evaluate(({ webContents }, direction) => {
        const contents = webContents.getFocusedWebContents();
        const keyCode =
          process.platform === "darwin"
            ? direction === "back"
              ? "["
              : "]"
            : direction === "back"
              ? "Left"
              : "Right";
        const modifiers = [process.platform === "darwin" ? "meta" : "alt"];
        contents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
        contents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      }, direction);
    await shortcut("back");
    await loaded("Next chapter");
    await expect.poll(async () => (await previewViewState(app, id)).focused).toBe(true);
    await shortcut("forward");
    await loaded("File not found");
    await back.click();
    await loaded("Next chapter");
    // Missing targets retain live watches and reload the current history entry.
    await forward.click();
    await loaded("File not found");
    await writeFile(path.join(root, `missing.${kind}`), "Recovered chapter");
    await loaded("Recovered chapter");
    await back.click();
    await loaded("Next chapter");
  });
}

test("preview history restores raster image mode and pan, and revalidates image bytes", async (context) => {
  const { app, page, id, tile } = await composedPreview(
    context,
    1,
    '<h1>Image gallery</h1><img src="thumbnail.png" alt="Sample"><a href="sample%20image.png?full=1#image">Open image</a>',
    "gallery.html",
  );
  const root = (await page.evaluate(() => window.desktop.workspace())).terminals[0].worktree;
  const image = path.join(root, "sample image.png");
  const sharp = require("sharp");
  const png = (width, height) =>
    sharp({ create: { width, height, channels: 3, background: "blue" } })
      .png()
      .toBuffer();
  const pixels = await png(1600, 1200);
  const read = (code) => previewContents(app, id, code, { requireAttached: true });
  const expectGallery = async () => {
    await expect
      .poll(() => read('document.querySelector("img[alt=Sample]")?.naturalWidth'))
      .toBe(23);
  };
  const expectImage = async () => {
    await expect.poll(() => read('document.querySelector("main img")?.naturalWidth')).toBe(1600);
    assert.equal(await read("document.scripts.length"), 0);
    assert.equal(
      await read('document.querySelector("img").src.startsWith("data:image/png;")'),
      true,
    );
  };
  const mode = () => read('document.querySelector("header a:target")?.textContent ?? "Fit"');
  const scroll = () => read("[window.scrollX, window.scrollY]");
  await writeFile(image, pixels);
  await writeFile(path.join(root, "thumbnail.png"), await png(23, 11));
  await expectGallery();
  await read('document.querySelector("a").click()');
  await expectImage();
  const back = tile.getByRole("button", { name: "Back", exact: true });
  const forward = tile.getByRole("button", { name: "Forward", exact: true });
  await expect(back).toBeEnabled();
  await expect(forward).toBeDisabled();
  assert.equal(await mode(), "Fit");
  await read('document.querySelector("#foom-actual-size").click()');
  await expect.poll(mode).toBe("Actual size");
  await read("window.scrollTo(150, 200)");
  await expect.poll(scroll).toEqual([150, 200]);
  await back.click();
  await expectGallery();
  await expect(back).toBeDisabled();
  await forward.click();
  await expectImage();
  assert.equal(await mode(), "Actual size");
  assert.deepEqual(await scroll(), [150, 200]);

  await read('document.querySelector("#fit").click()');
  await expect.poll(mode).toBe("Fit");
  for (const replacement of [pixels.subarray(0, 16), await png(4001, 4000)]) {
    await back.click();
    await expectGallery();
    await expect(forward).toBeEnabled();
    await writeFile(image, replacement);
    await forward.click();
    await expect
      .poll(() => read("document.body.textContent"))
      .toBe("Invalid or oversized image. PNG, JPEG and WebP only (16 MiB, 16 million pixels).");
    await expect(back).toBeEnabled();
    await writeFile(image, pixels);
    await expectImage();
    assert.equal(await mode(), "Fit");
  }
});
