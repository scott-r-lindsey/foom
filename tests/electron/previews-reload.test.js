const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, writeFile } = require("node:fs/promises");
const { expect } = require("./test-policy.js");
const { boardPage, launchApp } = require("./harness.js");
const { pickPreviewFile, previewContents, previewViewState } = require("./preview-fixture.js");

test("preview live reload handles saves, assets, missing files, scroll and closes watchers", async (context) => {
  const { rename, unlink } = require("node:fs/promises");
  const app = await launchApp(context, { fixture: "repository" });
  const page = await boardPage(app);
  const root = (await page.evaluate(() => window.desktop.workspace())).repositories[0].path;
  const document = (text) =>
    `<link rel="stylesheet" href="live.css"><div style="height:4000px">${text}</div>`;
  await writeFile(path.join(root, "live.html"), document("first"));
  await writeFile(path.join(root, "live.css"), "body { color: rgb(1, 2, 3); }");
  // Count native subscriptions and load starts, including replacement contents.
  await app.evaluate(({ app }, root) => {
    const fs = process.getBuiltinModule("node:fs");
    const original = fs.watch;
    globalThis.liveStats = { watchers: 0, burst: undefined };
    fs.watch = function (filename, ...args) {
      if (String(filename).startsWith(root)) {
        const callback = args.pop();
        args.push((event, name) => {
          const burst = globalThis.liveStats.burst;
          if (burst && (name === null || String(name) === "live.html")) {
            burst.lastEvent = performance.now();
            burst.firstEvent ??= burst.lastEvent;
          }
          callback(event, name);
        });
      }
      const watch = original.call(this, filename, ...args);
      if (String(filename).startsWith(root)) {
        globalThis.liveStats.watchers++;
        const close = watch.close.bind(watch);
        let closed = false;
        watch.close = () => {
          if (!closed) {
            closed = true;
            globalThis.liveStats.watchers--;
          }
          return close();
        };
      }
      return watch;
    };
    app.on("web-contents-created", (_event, contents) => {
      contents.on("did-start-loading", () => {
        if (!contents.getURL().startsWith("foom-preview://")) return;
        const burst = globalThis.liveStats.burst;
        if (burst) {
          burst.lastLoad = performance.now();
          burst.firstLoad ??= burst.lastLoad;
          burst.loads++;
        }
      });
    });
  }, root);
  const id = await pickPreviewFile(app, page, root, "live.html");
  await page.evaluate(
    (id) =>
      window.desktop.previews.bounds(id, {
        x: 400,
        y: 100,
        width: 250,
        height: 180,
        visible: true,
      }),
    id,
  );
  const loaded = async (text) => {
    await expect
      .poll(async () => {
        return previewContents(app, id, "document.body.textContent", { requireAttached: true });
      })
      .toContain(text);
    assert.equal((await previewViewState(app, id)).focused, false);
  };
  await loaded("first");
  // Force replacement while a read is pending, through both Electron's
  // executeJavaScript and CDP paths. Neither may strand or reject the poll.
  for (const [useDebugger, requireAttached] of [
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ]) {
    await app.evaluate(
      ({ webContents }, { id, useDebugger }) => {
        const contents = webContents
          .getAllWebContents()
          .find((entry) => entry.getURL().startsWith(`foom-preview://${id}/`));
        const execute = contents.executeJavaScript.bind(contents);
        contents.executeJavaScript = (code) => {
          contents.executeJavaScript = execute;
          let result;
          if (useDebugger) {
            contents.debugger.attach("1.3");
            result = contents.debugger.sendCommand("Runtime.evaluate", {
              expression: code,
              awaitPromise: true,
              returnByValue: true,
            });
          } else {
            result = execute(code);
          }
          contents.reload();
          return result;
        };
      },
      { id, useDebugger },
    );
    assert.equal(
      await previewContents(app, id, "new Promise(() => {})", { requireAttached }),
      undefined,
    );
    await loaded("first");
  }
  // A script error on the current contents is still a test failure.
  await assert.rejects(
    previewContents(app, id, "throw new Error('preview read failed')", { requireAttached: true }),
    /Script failed to execute/,
  );
  await previewContents(app, id, "window.scrollTo(0, 1200)");
  await expect.poll(() => previewContents(app, id, "window.scrollY")).toBe(1200);
  // Page-world overrides cannot spoof the isolated-world scroll capture.
  await previewContents(
    app,
    id,
    'Object.defineProperty(window, "scrollY", { value: 13 }); window.scrollTo = () => {}; undefined;',
  );
  await writeFile(path.join(root, "live.html"), document("direct"));
  await loaded("direct");
  assert.equal(await previewContents(app, id, "window.scrollY"), 1200);
  await writeFile(path.join(root, "live.tmp"), document("atomic"));
  await rename(path.join(root, "live.tmp"), path.join(root, "live.html"));
  await loaded("atomic");
  await app.evaluate(() => {
    globalThis.liveStats.burst = {
      loads: 0,
      firstEvent: undefined,
      firstLoad: undefined,
      lastEvent: undefined,
      lastLoad: undefined,
    };
  });
  // A burst may span several trailing/max-wait windows on a busy filesystem.
  // Test delayed reload, final content and eventual quiet, not a total load count.
  for (let index = 0; index < 20; index++)
    await writeFile(path.join(root, "live.html"), document(`burst ${index}`));
  await loaded("burst 19");
  // An earlier reload can read the final bytes while the last event is still
  // pending. Wait for a completed reload that started after that event.
  await expect
    .poll(() =>
      app.evaluate(({ webContents }, id) => {
        const contents = webContents
          .getAllWebContents()
          .find((entry) => entry.getURL().startsWith(`foom-preview://${id}/`));
        const burst = globalThis.liveStats.burst;
        return contents && !contents.isLoading() && burst.lastLoad >= burst.lastEvent;
      }, id),
    )
    .toBe(true);
  const burst = await app.evaluate(() => globalThis.liveStats.burst);
  assert.ok(burst.firstEvent !== undefined, "observed a native file event");
  assert.ok(burst.firstLoad !== undefined, "observed a reload after the writes");
  // Leave 20 ms for real timer precision around the 120 ms trailing delay.
  assert.ok(
    burst.firstLoad - burst.firstEvent >= 100,
    `reload waited for debounce: ${burst.firstLoad - burst.firstEvent} ms`,
  );
  // Elapsed quiet time is the behavior under test. Once the final page finishes,
  // no pending trailing or maximum-wait timer should cause another reload.
  await app.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1000)));
  assert.equal(await app.evaluate(() => globalThis.liveStats.burst.loads), burst.loads);
  await app.evaluate(() => {
    globalThis.liveStats.burst = undefined;
  });
  await writeFile(path.join(root, "live.css"), "body { color: rgb(4, 5, 6); }");
  await expect
    .poll(async () => {
      return previewContents(app, id, "getComputedStyle(document.body).color", {
        requireAttached: true,
      });
    })
    .toBe("rgb(4, 5, 6)");
  await unlink(path.join(root, "live.html"));
  await loaded("File not found. Waiting for it to appear.");
  await writeFile(path.join(root, "live.html"), document("recreated"));
  await loaded("recreated");
  assert.equal(await app.evaluate(() => globalThis.liveStats.watchers), 1);
  await page.evaluate((id) => window.desktop.previews.close(id), id);
  assert.equal(await app.evaluate(() => globalThis.liveStats.watchers), 0);
});

test("preview live reload follows retargeted symlinks and junctions", async (context) => {
  const { symlink, rename } = require("node:fs/promises");
  const app = await launchApp(context, { fixture: "repository" });
  const page = await boardPage(app);
  const root = (await page.evaluate(() => window.desktop.workspace())).repositories[0].path;
  for (const name of ["one", "two"]) {
    await mkdir(path.join(root, name));
    await writeFile(path.join(root, name, "index.html"), `<p>${name}</p>`);
  }
  const kind = process.platform === "win32" ? "junction" : "dir";
  await symlink(path.join(root, "one"), path.join(root, "alias"), kind);
  const id = await pickPreviewFile(app, page, root, "alias/index.html");
  await page.evaluate(
    (id) =>
      window.desktop.previews.bounds(id, {
        x: 400,
        y: 100,
        width: 250,
        height: 180,
        visible: true,
      }),
    id,
  );
  const text = async () =>
    previewContents(app, id, "document.body.textContent", { requireAttached: true });
  await expect.poll(text).toContain("one");
  await symlink(path.join(root, "two"), path.join(root, "next-alias"), kind);
  // Windows does not rename over an existing directory junction. Move the old
  // entry aside, then rename the replacement, within the debounce window.
  await rename(path.join(root, "alias"), path.join(root, "old-alias"));
  await rename(path.join(root, "next-alias"), path.join(root, "alias"));
  await expect.poll(text).toContain("two");
  await writeFile(path.join(root, "two", "index.html"), "<p>new target changed</p>");
  await expect.poll(text).toContain("new target changed");
  await page.evaluate((id) => window.desktop.previews.close(id), id);
});
