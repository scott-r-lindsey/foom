const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { deadline, expect } = require("./test-policy.js");
const { launchApp, boardPage } = require("./harness.js");

test("one trusted approval queue appends, merges, withdraws and snapshots decisions without stealing terminal input", {
  timeout: deadline(60000),
}, async (context) => {
  let app;
  context.after(async () => {
    if (app)
      await app
        .evaluate(() => {
          const f = globalThis.approvalFixture;
          f?.off();
          f?.dialog.dispose();
        })
        .catch(() => {});
  });
  app = await launchApp(context, { fixture: "running-shell" });
  const board = await boardPage(app);
  // Real main-owned queue and native isolation/renderer; data and agent attribution are fixtures.
  await app.evaluate(({ app, BrowserWindow, session }) => {
    const load = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const path = load("node:path");
    const { Approvals } = load(
      path.join(app.getAppPath(), "build/main/confirmations/approvals.js"),
    );
    const { TrustedDialog } = load(
      path.join(app.getAppPath(), "build/main/confirmations/trusted-dialog.js"),
    );
    const { resolveInterfaceTheme } = load(
      path.join(app.getAppPath(), "build/shared/interface-themes.js"),
    );
    const parent = BrowserWindow.getAllWindows().find(
      (w) => w.webContents.getURL() === "app://bundle/index.html",
    );
    parent.setBounds({ x: 30, y: 10, width: 1200, height: 1000 });
    globalThis.approvalFixture = {
      theme: resolveInterfaceTheme("eclipse-light", false),
      results: {},
      abort: {},
    };
    const fixture = globalThis.approvalFixture;
    fixture.dialog = new TrustedDialog(
      parent,
      session.fromPartition("confirmation"),
      () => fixture.theme,
    );
    fixture.queue = new Approvals(
      (content, signal) => fixture.dialog.request(content, signal),
      () => fixture.theme,
    );
    fixture.off = fixture.queue.feed.subscribe(() =>
      parent.webContents.send("approval:count", fixture.queue.feed.current().length),
    );
    fixture.add = (id, kind = "Worktree removal") => {
      const controller = new AbortController();
      fixture.abort[id] = controller;
      const content = {
        title: `Review ${id}`,
        accept: `Remove ${id}`,
        subject: `fixture/${id}`,
        detail: "Remove the clean worktree. Keep its branch.",
        approval: {
          kind,
          origin: "Fixture Claude · Tile/session fixture-1 · fixture-repository",
          key: id,
        },
      };
      if (kind === "Worktree removal") {
        delete content.detail;
        content.removal = {
          group: "fixture",
          item: { id, branch: id, path: `/fixture/${id}`, changes: "" },
        };
      }
      void fixture.queue
        .request(content, controller.signal)
        .then((result) => (fixture.results[id] = result));
    };
    fixture.add("one");
    fixture.add("two");
  });
  await expect(board.getByRole("button", { name: "2 approvals waiting" })).toBeVisible();
  const input = board.locator(".xterm-helper-textarea").first();
  await input.focus();
  await board.keyboard.type("printf approval-input-preserved");
  await app.evaluate(() => globalThis.approvalFixture.add("while-typing"));
  await expect(board.getByRole("button", { name: "3 approvals waiting" })).toBeVisible();
  await board.keyboard.press("Enter");
  await expect(input).toBeFocused();
  assert.deepEqual(await app.evaluate(() => globalThis.approvalFixture.results), {});
  await app.evaluate(() => globalThis.approvalFixture.abort["while-typing"].abort());
  await app.evaluate(() => globalThis.approvalFixture.add("two"));
  await expect(board.getByRole("button", { name: "2 approvals waiting" })).toBeVisible();
  // Open with an explicit user click. The board capability is production-owned;
  // the fixture keeps its own presenter so it can exercise cancellation directly.
  await board.getByRole("button", { name: "2 approvals waiting" }).click();
  await app.evaluate(() => globalThis.approvalFixture.dialog.openApprovals());
  let dialog;
  await expect
    .poll(async () => {
      for (const page of app.windows())
        if (
          page.url() === "app://confirmation/confirmation.html" &&
          (await page.locator(".approval-queue").count())
        ) {
          dialog = page;
          return true;
        }
      return false;
    })
    .toBe(true);
  const native = await app.browserWindow(dialog);
  const row = (id) =>
    dialog
      .locator(".approval-row")
      .filter({ has: dialog.locator(".subject", { hasText: new RegExp(`^${id}$`) }) });
  const approve = (id) => row(id).getByRole("button", { name: /^Approve ·/ });
  try {
    await expect
      .poll(() => native.evaluate((window) => window.isVisible() && window.isFocused()))
      .toBe(true);
    await expect(dialog.getByText("Repeated 2 times · one decision")).toBeVisible();
    await expect(dialog.locator(".approval-row")).toHaveCount(2);
    assert.equal(
      await app.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().filter(
            (window) =>
              window.webContents.getURL() === "app://confirmation/confirmation.html" &&
              window.isVisible(),
          ).length,
      ),
      1,
    );
    await expect(approve("one")).toBeEnabled();
    const before = await dialog.locator(".approval-row").first().boundingBox();
    const nativeBefore = await native.evaluate((window) => window.getBounds());
    await app.evaluate(() => globalThis.approvalFixture.add("three"));
    await expect(dialog.locator(".approval-row")).toHaveCount(3);
    const after = await dialog.locator(".approval-row").first().boundingBox();
    assert.equal(before.y, after.y, "Arrivals must not move existing rows");
    assert.equal(nativeBefore.y, (await native.evaluate((window) => window.getBounds())).y);
    await expect(approve("three")).toBeDisabled();
    await app.evaluate(() => globalThis.approvalFixture.abort.three.abort());
    await expect(dialog.locator(".approval-row")).toHaveCount(2);
    await expect(
      dialog.getByRole("button", { name: "Approve all visible removals (2)", exact: true }),
    ).toBeEnabled();
    if (process.env.FOOM_CONFIRMATION_SCREENSHOTS === "1") {
      await mkdir("test-results/1105-electron", { recursive: true });
      for (const dark of [false, true]) {
        await app.evaluate(({ app }, dark) => {
          const load = process
            .getBuiltinModule("node:module")
            .createRequire(app.getAppPath() + "/package.json");
          const path = load("node:path");
          const { resolveInterfaceTheme } = load(
            path.join(app.getAppPath(), "build/shared/interface-themes.js"),
          );
          const f = globalThis.approvalFixture;
          f.theme = resolveInterfaceTheme("follow", dark);
          f.dialog.refresh();
        }, dark);
        await expect
          .poll(() => dialog.evaluate(() => getComputedStyle(document.body).color))
          .toBe(dark ? "rgb(244, 239, 255)" : "rgb(20, 16, 31)");
        await dialog.evaluate(() => new Promise(requestAnimationFrame));
        const image = await native.evaluate(async (window) =>
          (await window.webContents.capturePage()).toPNG().toString("base64"),
        );
        await writeFile(
          path.resolve(`test-results/1105-electron/approvals-${dark ? "dark" : "light"}.png`),
          Buffer.from(image, "base64"),
        );
      }
    }
    await dialog
      .getByRole("button", { name: "Approve all visible removals (2)", exact: true })
      .click();
    await expect
      .poll(() => app.evaluate(() => globalThis.approvalFixture.results))
      .toEqual({ one: true, two: true, three: false, "while-typing": false });
    await app.evaluate(() => {
      const f = globalThis.approvalFixture;
      f.add("later");
      f.add("authority", "Authority");
    });
    await app.evaluate(() => globalThis.approvalFixture.dialog.openApprovals());
    await expect(dialog.locator(".approval-row")).toHaveCount(2);
    await expect(approve("later")).toBeEnabled();
    await approve("later").click();
    await expect(dialog.locator(".approval-row")).toHaveCount(1);
    await expect(
      dialog.getByRole("button", { name: "Approve all visible removals (0)", exact: true }),
    ).toBeDisabled();
    await dialog.getByRole("button", { name: "Decline", exact: true }).click();
    await expect
      .poll(() => app.evaluate(() => globalThis.approvalFixture.results.authority))
      .toBe(false);
    await app.evaluate(() => globalThis.approvalFixture.add("hidden"));
    await app.evaluate(() => globalThis.approvalFixture.dialog.openApprovals());
    await expect(dialog.getByRole("button", { name: "Hide", exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Hide", exact: true }).click();
    await expect.poll(() => native.evaluate((window) => window.isVisible())).toBe(false);
    const waiting = board.getByRole("button", { name: "1 approval waiting" });
    await expect(waiting).toBeVisible();
    assert.ok(
      ["rgb(140, 80, 0)", "rgb(255, 178, 62)"].includes(
        await waiting.evaluate((element) => getComputedStyle(element).color),
      ),
    );
    assert.equal(await app.evaluate(() => globalThis.approvalFixture.results.hidden), undefined);
    await app.evaluate(() => globalThis.approvalFixture.abort.hidden.abort());
    await expect(waiting).toHaveCount(0);
  } finally {
    await native.dispose();
  }
});
