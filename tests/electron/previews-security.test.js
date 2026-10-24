const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { expect } = require("./test-policy.js");
const {
  boardPage,
  confirmationPage,
  launchApp,
  quitAndWait,
  removeAfterApps,
} = require("./harness.js");
const { pickPreviewFile, previewContents, previewViewState } = require("./preview-fixture.js");

test("preview host isolates hostile pages, blocks network and navigation, scales bounds and clears closed partitions", async (context) => {
  const app = await launchApp(context, { fixture: "repository" });
  const page = await boardPage(app);
  const root = (await page.evaluate(() => window.desktop.workspace())).repositories[0].path;
  const server = require("node:http").createServer((_request, response) =>
    response.end("unwanted"),
  );
  let connections = 0;
  server.on("connection", () => connections++);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const external = `http://127.0.0.1:${server.address().port}/`;
  await writeFile(
    path.join(root, "hostile.html"),
    `<input id="input"><a id="external" href="${external}">external</a><a id="html" href="other.html">html</a><script>
    window.probes={ bridge: typeof window.desktop, require: typeof require, process: typeof process, electron: typeof electron, ipc: typeof ipcRenderer, top: top===window };
    window.popup=window.open("${external}")===null;
    window.networkFinished=false; Promise.allSettled([fetch("${external}"), fetch("file:///etc/passwd"), fetch("app://bundle/index.html")]).then(()=>window.networkFinished=true);
    window.geo="pending"; navigator.geolocation.getCurrentPosition(()=>window.geo="allowed", error=>window.geo=error.code);
    localStorage.setItem("private", "secret");
  </script>`,
  );
  await writeFile(
    path.join(root, "clean.html"),
    '<input><script>window.privateValue=localStorage.getItem("private")</script>',
  );
  const baseline = await app.evaluate(({ webContents }) => webContents.getAllWebContents().length);
  const id = await pickPreviewFile(app, page, root, "hostile.html");
  const clean = await pickPreviewFile(app, page, root, "clean.html");
  for (const preview of [id, clean]) {
    await page.evaluate(
      (id) =>
        window.desktop.previews.bounds(id, {
          x: 400,
          y: 100,
          width: 250,
          height: 180,
          visible: true,
        }),
      preview,
    );
  }
  // The hostile page's window.open asks for review at once; the trusted scrim
  // covers previews (#292) until it is answered, so answer before attaching.
  const linkDialog = await confirmationPage(app);
  await expect(linkDialog.getByRole("heading", { name: "Open this link?" })).toBeVisible();
  await linkDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(linkDialog.getByRole("heading", { name: "Open this link?" })).toHaveCount(0);
  for (const preview of [id, clean])
    await expect.poll(async () => (await previewViewState(app, preview)).attached).toBe(true);
  assert.deepEqual(await previewContents(app, id, "window.probes"), {
    bridge: "undefined",
    require: "undefined",
    process: "undefined",
    electron: "undefined",
    ipc: "undefined",
    top: true,
  });
  assert.equal(await previewContents(app, id, "window.popup"), true);
  assert.equal(await previewContents(app, clean, "window.privateValue"), null);
  await expect.poll(() => previewContents(app, id, "window.networkFinished")).toBe(true);
  await expect.poll(() => previewContents(app, id, "window.geo")).toBe(1);
  assert.equal(connections, 0);
  // Observe actual navigation prevention, rather than waiting an arbitrary interval.
  for (const link of ["external", "html"]) {
    const prevented = await app.evaluate(
      ({ webContents }, { id, link }) => {
        const wc = webContents
          .getAllWebContents()
          .find((entry) => entry.getURL().startsWith(`foom-preview://${id}/`));
        return new Promise((resolve) => {
          wc.once("will-frame-navigate", (event) => resolve(event.defaultPrevented));
          void wc.executeJavaScript(`document.getElementById(${JSON.stringify(link)}).click()`);
        });
      },
      { id, link },
    );
    assert.equal(prevented, true);
    if (link === "external") {
      await expect(linkDialog.getByRole("heading", { name: "Open this link?" })).toBeVisible();
      await linkDialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(linkDialog.getByRole("heading", { name: "Open this link?" })).toHaveCount(0);
    }
  }
  assert.equal(connections, 0);
  assert.deepEqual((await previewViewState(app, id)).bounds, {
    x: 400,
    y: 100,
    width: 250,
    height: 180,
  });
  await page.evaluate(() => window.desktop.saveSetup({ interfaceScale: 150 }));
  await expect
    .poll(async () => (await previewViewState(app, id)).bounds)
    .toEqual({ x: 600, y: 150, width: 375, height: 270 });
  assert.equal((await previewViewState(app, id)).zoom, 1.5);
  // The scaled minimum window size prevents shrinking the window, so move the
  // preview past the right edge instead; main clamps it to the content bounds.
  const contentWidth = await app.evaluate(
    ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "app://bundle/index.html")
        .getContentBounds().width,
  );
  const edge = Math.floor(contentWidth / 1.5) - 100;
  await page.evaluate(
    ({ id, edge }) =>
      window.desktop.previews.bounds(id, {
        x: edge,
        y: 100,
        width: 250,
        height: 180,
        visible: true,
      }),
    { id, edge },
  );
  assert.equal(
    (await previewViewState(app, id)).bounds?.width,
    contentWidth - Math.round(edge * 1.5),
  );
  const count = await app.evaluate(({ webContents }) => webContents.getAllWebContents().length);
  assert.equal(count, baseline + 2);
  await app.evaluate(({ session }, id) => {
    globalThis.closedPreviewPartition = session.fromPartition(`preview-${id}`);
  }, id);
  await page.evaluate((id) => window.desktop.previews.close(id), id);
  assert.equal(
    await app.evaluate(({ webContents }) => webContents.getAllWebContents().length),
    baseline + 1,
  );
  assert.equal(
    await app.evaluate(() =>
      globalThis.closedPreviewPartition.protocol.isProtocolHandled("foom-preview"),
    ),
    false,
  );
  assert.deepEqual(
    await app.evaluate(async () => {
      const cookies = await globalThis.closedPreviewPartition.cookies.get({});
      return { cookies, usage: await globalThis.closedPreviewPartition.getStoragePath() };
    }),
    { cookies: [], usage: null },
  );
  const inventory = await page.evaluate(() => window.desktop.sidebarInventory());
  assert.deepEqual(
    inventory.previews.map((entry) => entry.id),
    [clean],
  );
  await page.evaluate((id) => window.desktop.previews.close(id), clean);
  assert.equal(
    await app.evaluate(({ webContents }) => webContents.getAllWebContents().length),
    baseline,
  );
});

test("preview external links always use trusted review and drop scripted requests while pending", async (context) => {
  const app = await launchApp(context, { fixture: "repository" });
  const page = await boardPage(app);
  const root = (await page.evaluate(() => window.desktop.workspace())).repositories[0].path;
  await writeFile(path.join(root, "links.html"), "<p>Links</p>");
  await app.evaluate(({ shell }) => {
    globalThis.previewExternalOpened = [];
    shell.openExternal = async (url) => {
      globalThis.previewExternalOpened.push(url);
    };
  });
  const id = await pickPreviewFile(app, page, root, "links.html");
  await expect.poll(async () => (await previewViewState(app, id)).loading).toBe(false);
  const dialog = await confirmationPage(app);
  await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://confirmation/confirmation.html",
    ).webContents;
    const send = contents.send.bind(contents);
    globalThis.previewLinkReviews = [];
    contents.send = (channel, ...args) => {
      if (channel === "confirmation:render" && args[0]) globalThis.previewLinkReviews.push(args[0]);
      send(channel, ...args);
    };
  });
  const url = "https://example.com/full/path?query=shown%20in%20full#fragment";
  await previewContents(
    app,
    id,
    `window.open(${JSON.stringify(url)}); window.open('http://example.com/dropped'); location.href='https://example.com/also-dropped';`,
  );
  await expect(dialog.getByRole("heading", { name: "Open this link?" })).toBeVisible();
  await expect(dialog.locator(".facts dd")).toHaveText(url);
  assert.equal(await app.evaluate(() => globalThis.previewLinkReviews.length), 1);
  assert.deepEqual(await app.evaluate(() => globalThis.previewExternalOpened), []);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Open this link?" })).toHaveCount(0);
  assert.deepEqual(await app.evaluate(() => globalThis.previewExternalOpened), []);
  await previewContents(
    app,
    id,
    "window.open('file:///tmp/never'); window.open('javascript:alert(1)'); window.open('data:text/plain,never')",
  );
  assert.equal(await app.evaluate(() => globalThis.previewLinkReviews.length), 1);
  await previewContents(app, id, "window.open('mailto:hello@example.com?subject=Preview')");
  await expect(dialog.locator(".facts dd")).toHaveText("mailto:hello@example.com?subject=Preview");
  await dialog.getByRole("button", { name: "Open in browser", exact: true }).click();
  await expect
    .poll(() => app.evaluate(() => globalThis.previewExternalOpened))
    .toEqual(["mailto:hello@example.com?subject=Preview"]);
  await previewContents(app, id, "window.open('http://example.com/cancel-on-close')");
  await expect(dialog.locator(".facts dd")).toHaveText("http://example.com/cancel-on-close");
  await page.evaluate((id) => window.desktop.previews.close(id), id);
  await expect(dialog.getByRole("heading", { name: "Open this link?" })).toHaveCount(0);
  assert.deepEqual(await app.evaluate(() => globalThis.previewExternalOpened), [
    "mailto:hello@example.com?subject=Preview",
  ]);
});

test("preview network permission allows local HTTPS only and resets after restart", async (context) => {
  const profile = await mkdtemp(path.join(tmpdir(), "foom-preview-network-"));
  removeAfterApps(context, profile);
  const options = { args: [`--user-data-dir=${profile}`] };
  const certificateRoot = path.join(__dirname, "../fixtures/preview-network");
  const secure = require("node:https").createServer(
    {
      key: await readFile(path.join(certificateRoot, "key.pem")),
      cert: await readFile(path.join(certificateRoot, "cert.pem")),
    },
    (_request, response) => {
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.end("secure");
    },
  );
  const plain = require("node:http").createServer((_request, response) => response.end("blocked"));
  let secureConnections = 0,
    plainConnections = 0;
  secure.on("connection", () => secureConnections++);
  plain.on("connection", () => plainConnections++);
  context.after(async () => {
    for (const server of [secure, plain]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
  for (const server of [secure, plain])
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const secureUrl = `https://127.0.0.1:${secure.address().port}/`;
  const plainUrl = `http://127.0.0.1:${plain.address().port}/`;
  const app = await launchApp(context, { ...options, fixture: "running-shell" });
  const page = await boardPage(app);
  const root = (await page.evaluate(() => window.desktop.workspace())).terminals[0].worktree;
  await writeFile(
    path.join(root, "network.html"),
    `<p>Network probe</p><script>
    window.results=null;
    Promise.all([${JSON.stringify(secureUrl)}, ${JSON.stringify(plainUrl)}].map(url => fetch(url).then(response=>response.text()).catch(()=>"blocked"))).then(results => window.results=results);
  </script>`,
  );
  await app.evaluate(({ app }) => {
    app.on("session-created", (partition) => {
      // Trust only this test's loopback certificate; never disable app-wide verification.
      partition.setCertificateVerifyProc((request, callback) =>
        callback(request.hostname === "127.0.0.1" ? 0 : -3),
      );
    });
  });
  const id = await pickPreviewFile(app, page, root, "network.html");
  const bounds = { x: 400, y: 100, width: 250, height: 180, visible: true };
  await page.evaluate(({ id, bounds }) => window.desktop.previews.bounds(id, bounds), {
    id,
    bounds,
  });
  await expect.poll(async () => (await previewViewState(app, id)).attached).toBe(true);
  await expect
    .poll(() => previewContents(app, id, "window.results"))
    .toEqual(["blocked", "blocked"]);
  assert.equal(secureConnections, 0);
  assert.equal(plainConnections, 0);
  const dialog = await confirmationPage(app);
  await page.evaluate((id) => {
    window.previewNetworkChange = window.desktop.previews.network(id, true);
  }, id);
  await expect(
    dialog.getByRole("heading", { name: "Allow network for this preview?" }),
  ).toBeVisible();
  await expect(
    dialog.getByText("This page can send files from this worktree to the internet", {
      exact: true,
    }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.evaluate(() => window.previewNetworkChange);
  assert.equal(
    (await page.evaluate(() => window.desktop.sidebarInventory())).previews.find(
      (preview) => preview.id === id,
    ).network,
    false,
  );
  await page.evaluate((id) => {
    window.previewNetworkChange = window.desktop.previews.network(id, true);
  }, id);
  await dialog.getByRole("button", { name: "Allow network", exact: true }).click();
  await page.evaluate(() => window.previewNetworkChange);
  await expect.poll(async () => (await previewViewState(app, id)).attached).toBe(true);
  await expect
    .poll(() => previewContents(app, id, "window.results"))
    .toEqual(["secure", "blocked"]);
  assert.ok(secureConnections > 0);
  assert.equal(plainConnections, 0);
  assert.equal(
    (await page.evaluate(() => window.desktop.sidebarInventory())).previews.find(
      (preview) => preview.id === id,
    ).network,
    true,
  );
  await quitAndWait(app, async () => {
    await app.evaluate(({ app }) => app.quit());
    await dialog.getByRole("button", { name: "Stop all and quit", exact: true }).click();
  });
  const restored = await launchApp(context, { ...options, fixture: "restored" });
  const restoredPage = await boardPage(restored);
  // Board startup can finish before the persisted previews have been restored.
  await expect
    .poll(async () =>
      (await restoredPage.evaluate(() => window.desktop.sidebarInventory())).previews.some(
        (preview) => preview.id === id,
      ),
    )
    .toBe(true);
  const restoredInventory = await restoredPage.evaluate(() => window.desktop.sidebarInventory());
  assert.equal(restoredInventory.previews.find((preview) => preview.id === id).network, false);
  const before = secureConnections;
  await restoredPage.evaluate(({ id, bounds }) => window.desktop.previews.bounds(id, bounds), {
    id,
    bounds,
  });
  await expect.poll(async () => (await previewViewState(restored, id)).attached).toBe(true);
  await expect
    .poll(() => previewContents(restored, id, "window.results"))
    .toEqual(["blocked", "blocked"]);
  assert.equal(secureConnections, before);
  assert.equal(plainConnections, 0);
});
