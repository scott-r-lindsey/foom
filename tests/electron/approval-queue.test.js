const { revealApproval } = require("./approval-actions.js");
const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const { writeFile } = require("node:fs/promises");
const { evidencePath } = require("../helpers/evidence.js");
const { deadline, expect } = require("./test-policy.js");
const { launchApp, boardPage } = require("./harness.js");

async function launchApprovalFixture(context) {
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
  await app.evaluate(({ app, BrowserWindow, session, screen }) => {
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
    const { removalStatus, remoteRemovalStatus } = load(
      "./build/main/workspace/worktree-operations.js",
    );
    const parent = BrowserWindow.getAllWindows().find(
      (w) => w.webContents.getURL() === "app://bundle/index.html",
    );
    parent.setBounds({ x: 30, y: 10, width: 1200, height: 1000 });
    // Keep the full 720-CSS-pixel queue visible on shorter CI desktops too.
    const work = screen.getDisplayMatching(parent.getBounds()).workArea;
    parent.webContents.setZoomFactor(Math.max(0.5, Math.min(1, (work.height - 80) / 720)));
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
    fixture.add = (id, kind = "Worktree removal", expiresAt, changes = "", remote = false) => {
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
      if (expiresAt !== undefined) content.pairing = { code: "ABCD-EFGH", expiresAt };
      if (kind === "Worktree removal") {
        delete content.detail;
        content.removal = {
          group: "fixture",
          item: {
            id,
            branch: id,
            path: `/fixture/${id}`,
            ...(remote
              ? remoteRemovalStatus(changes, (value) => value)
              : removalStatus(Buffer.from(changes).toString("latin1"))),
          },
        };
      }
      void fixture.queue.request(content, controller.signal).then((result) => {
        if (!fixture.screenshots?.has(id)) fixture.results[id] = result;
      });
    };
    fixture.add("one");
    fixture.add("two");
  });
  return { app, board };
}

test("one trusted approval queue appends, merges, withdraws and snapshots decisions without stealing terminal input", {
  timeout: deadline(60000),
}, async (context) => {
  const { app, board } = await launchApprovalFixture(context);
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
  const { dialog, native, approve, row } = await openFixtureDialog(app, board);
  try {
    await expect
      .poll(() => native.evaluate((window) => window.isVisible() && window.isFocused()))
      .toBe(true);
    await expect(dialog.getByText(/Repeated 2 times · one decision/)).toBeVisible();
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
      dialog.getByRole("button", { name: "Approve all clean removals (2)", exact: true }),
    ).toBeEnabled();
    await expect(dialog.locator(".approval-placeholder")).toHaveCount(0);
    if (process.env.FOOM_CONFIRMATION_SCREENSHOTS === "1")
      await captureRemovalQueue(app, dialog, native);
    await dialog
      .getByRole("button", { name: "Approve all clean removals (2)", exact: true })
      .click();
    await expect
      .poll(() => app.evaluate(() => globalThis.approvalFixture.results))
      .toEqual({ one: true, two: true, three: false, "while-typing": false });
    await app.evaluate(() => {
      const f = globalThis.approvalFixture;
      f.add("later");
      f.add("authority", "Authority");
      const changes = Array.from(
        { length: 300 },
        (_, index) => `?? file-${String(index).padStart(3, "0")}-${"x".repeat(86)}.txt\n`,
      ).join("");
      f.add("remote-300", "Worktree removal", undefined, changes, true);
    });
    await app.evaluate(() => globalThis.approvalFixture.dialog.openApprovals());
    await expect(dialog.locator(".approval-row")).toHaveCount(3);
    const remote = row("remote-300");
    await expect(remote.getByRole("button", { name: "Discard 300 files and remove" })).toHaveText(
      "Discard 300 files and remove",
    );
    const records = remote.getByRole("list", { name: "Uncommitted changes" });
    await expect(records.getByRole("listitem")).toHaveCount(39);
    await expect(records.getByRole("listitem").first()).toContainText("file-000-");
    await expect(remote.getByText("and 261 more", { exact: true })).toBeVisible();
    await expect(approve("later")).toBeEnabled();
    await app.evaluate(() => globalThis.approvalFixture.abort["remote-300"].abort());
    await expect(dialog.locator(".approval-row")).toHaveCount(2);
    await expect(approve("later")).toBeEnabled();
    await approve("later").click();
    await expect(dialog.locator(".approval-row")).toHaveCount(1);
    await expect(
      dialog.getByRole("button", { name: "Approve all clean removals (0)", exact: true }),
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
  await verifyDirtyDiscardRequiresVisibleConsequence(app, board);
});

async function openFixtureDialog(app, board) {
  await board.getByRole("button", { name: /approvals? waiting/ }).click();
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
  await expect
    .poll(() => native.evaluate((window) => window.isFocused() && window.isVisible()))
    .toBe(true);
  const row = (id) =>
    dialog.locator(".approval-row").filter({
      has: dialog.getByRole("heading", { name: new RegExp(`^(?:/fixture/|Review )${id}$`) }),
    });
  return {
    dialog,
    native,
    row,
    approve: (id) => row(id).getByRole("button", { name: /^Approve ·/ }),
  };
}

async function captureRemovalQueue(app, dialog, native) {
  const shot = async (name, dark) => {
    await app.evaluate(({ app }, dark) => {
      const load = process
        .getBuiltinModule("node:module")
        .createRequire(app.getAppPath() + "/package.json");
      const { resolveInterfaceTheme } = load("./build/shared/interface-themes.js");
      const fixture = globalThis.approvalFixture;
      fixture.theme = resolveInterfaceTheme("follow", dark);
      fixture.dialog.refresh();
    }, dark);
    await expect
      .poll(() => dialog.evaluate(() => getComputedStyle(document.body).color))
      .toBe(dark ? "rgb(244, 239, 255)" : "rgb(20, 16, 31)");
    await expect(dialog.getByRole("button", { name: /Approve all clean removals/ })).toBeEnabled();
    const image = await native.evaluate(async (window) =>
      (await window.webContents.capturePage()).toPNG().toString("base64"),
    );
    await writeFile(evidencePath(`1293/${name}.png`), Buffer.from(image, "base64"));
  };
  await shot("after-two-rows-light", false);
  const extra = [
    "fix-toolbar",
    "review-keyboard-navigation",
    "update-test-fixtures",
    "simplify-theme-tokens",
  ];
  await app.evaluate((_, extra) => {
    for (const id of extra) globalThis.approvalFixture.add(id);
  }, extra);
  await expect(
    dialog.getByRole("button", { name: "Approve all clean removals (6)" }),
  ).toBeEnabled();
  await shot("clean-light", false);
  await shot("clean-dark", true);
  const dirty = "review-local-changes";
  await app.evaluate((_, id) => {
    globalThis.approvalFixture.add(
      id,
      "Worktree removal",
      undefined,
      " M src/sidebar.tsx\0?? notes.txt\0",
    );
  }, dirty);
  await revealApproval(
    dialog,
    dialog.getByRole("button", { name: "Discard 2 files and remove", exact: true }),
  );
  await expect(
    dialog.getByRole("button", { name: "Approve all clean removals (6)" }),
  ).toBeEnabled();
  await shot("mixed-light", false);
  await shot("mixed-dark", true);
  await app.evaluate(
    (_, ids) => {
      for (const id of ids) {
        const fixture = globalThis.approvalFixture;
        fixture.screenshots ??= new Set();
        fixture.screenshots.add(id);
        fixture.abort[id].abort();
      }
    },
    [...extra, dirty],
  );
  await expect(dialog.locator(".approval-placeholder")).toHaveCount(0);
}

function assertRetainedFootprint(before, after, message) {
  assert.ok(before && after, message);
  const { y: beforeY, ...beforeBounds } = before;
  const { y: afterY, ...afterBounds } = after;
  assert.deepEqual(afterBounds, beforeBounds, message);
  // Applying the measured row height as CSS can round to a different layout
  // subpixel at fractional zoom. A whole-pixel shift must still fail.
  assert.ok(
    Math.abs(afterY - beforeY) <= 1 / 16,
    `${message}. Vertical position changed from ${beforeY} to ${afterY} CSS px`,
  );
}

async function verifyDirtyDiscardRequiresVisibleConsequence(app, board) {
  const leading = Array.from({ length: 16 }, (_, index) => `scroll-${index}`);
  const trailing = Array.from({ length: 10 }, (_, index) => `tail-${index}`);
  const clean = [...leading, ...trailing];
  const changes = Array.from(
    { length: 40 },
    (_, index) => `?? src/review/file-${index + 1}.ts\0`,
  ).join("");
  await app.evaluate(
    (_, { leading, trailing, changes }) => {
      const fixture = globalThis.approvalFixture;
      for (const id of leading) fixture.add(id);
      fixture.add("dirty", "Worktree removal", undefined, changes);
      for (const id of trailing) fixture.add(id);
    },
    { leading, trailing, changes },
  );
  const { dialog, native, row, approve } = await openFixtureDialog(app, board);
  try {
    const dirty = row("dirty");
    const box = dirty.getByRole("region", { name: "Review files to discard" });
    const summary = dirty.getByText("Discards 40 files", { exact: true });
    const discard = dirty.getByRole("button", { name: "Discard 40 files and remove", exact: true });
    await expect(discard).toHaveText("Discard 40 files and remove");
    await discard.evaluate((button) => {
      const viewport = button.closest(".approval-scroll");
      viewport.scrollTop +=
        button.getBoundingClientRect().top - viewport.getBoundingClientRect().top + 2;
    });
    const clipped = await dirty.evaluate((element) => {
      const viewport = element.closest(".approval-scroll").getBoundingClientRect();
      const button = element.querySelector("[data-approval-discard]").getBoundingClientRect();
      return button.top < viewport.top && button.bottom > viewport.top;
    });
    assert.ok(clipped, "The button is partially clipped at the top of the queue");
    // An off-screen clean control still enables after the movement guard settles.
    await expect(approve(leading[0])).not.toBeInViewport();
    await expect(approve(leading[0])).toBeEnabled();
    await expect(discard).toBeDisabled();
    const viewport = dialog.getByRole("region", { name: "Pending approvals" });
    assert.ok(
      await viewport.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const rows = Array.from(element.querySelectorAll(".approval-row")).filter(
          (row) => !row.querySelector("[data-approval-discard]"),
        );
        const visible = rows.filter((row) => {
          const rect = row.getBoundingClientRect();
          return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
        });
        return element.scrollTop > 0 && visible.length < rows.length / 2;
      }),
      "Most clean removal rows are outside the visible queue",
    );
    await dialog
      .getByRole("button", { name: `Approve all clean removals (${clean.length})`, exact: true })
      .click();
    await expect
      .poll(() =>
        app.evaluate((_, ids) => {
          const results = globalThis.approvalFixture.results;
          return ids.every((id) => results[id] === true) && results.dirty === undefined;
        }, clean),
      )
      .toBe(true);
    await expect(dialog.locator(".approval-row")).toHaveCount(1);
    assert.ok(await box.evaluate((element) => element.scrollHeight > element.clientHeight));
    if (process.env.FOOM_CONFIRMATION_SCREENSHOTS === "1") {
      await revealApproval(dialog, discard);
      const image = await native.evaluate(async (window) =>
        (await window.webContents.capturePage()).toPNG().toString("base64"),
      );
      await writeFile(evidencePath("1293/long-40-light.png"), Buffer.from(image, "base64"));
    }

    await app.evaluate(({ BrowserWindow }) => {
      const parent = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "app://bundle/index.html",
      );
      parent.webContents.setZoomFactor(2);
      globalThis.approvalFixture.dialog.refresh();
    });
    await expect
      .poll(() => native.evaluate((window) => window.webContents.getZoomFactor()))
      .toBeCloseTo(2);
    await revealApproval(dialog, discard);
    await expect(box).not.toBeInViewport({ ratio: 1 });
    await expect(summary).toBeInViewport({ ratio: 1 });
    assert.equal(await box.evaluate((element) => element.scrollTop), 0);
    await discard.click();
    await expect
      .poll(() => app.evaluate(() => globalThis.approvalFixture.results.dirty))
      .toBe(true);
  } finally {
    await native.dispose();
  }
}

test("trusted approval gestures cannot retarget withdrawals, expiry or arrivals and synthetic decisions grant nothing", {
  timeout: deadline(60000),
}, async (context) => {
  const { app, board } = await launchApprovalFixture(context);
  const { dialog, native, row, approve } = await openFixtureDialog(app, board);
  const result = (id) => app.evaluate((_, id) => globalThis.approvalFixture.results[id], id);
  const bulk = () => dialog.getByRole("button", { name: /Approve all clean removals/ });
  const add = (id, kind = "Worktree removal") =>
    app.evaluate((_, { id, kind }) => globalThis.approvalFixture.add(id, kind), { id, kind });
  const abort = (id) => app.evaluate((_, id) => globalThis.approvalFixture.abort[id].abort(), id);
  try {
    await expect(approve("one")).toBeEnabled();
    await expect(approve("two")).toBeEnabled();
    const first = await approve("one").boundingBox();
    const second = await approve("two").boundingBox();
    const x = first.x + first.width / 2;
    const y = first.y + first.height / 2;
    await dialog.mouse.move(x, y);
    await abort("one");
    await expect(dialog.locator(".approval-placeholder")).toContainText("Request ended");
    assertRetainedFootprint(
      second,
      await approve("two").boundingBox(),
      "Withdrawal retains its inert footprint",
    );
    await dialog.mouse.click(x, y);
    assert.equal(await result("two"), undefined);
    await expect(dialog.locator(".approval-placeholder")).toHaveCount(0);
    await expect(approve("two")).toBeDisabled();
    await dialog.mouse.click(x, y);
    assert.equal(
      await result("two"),
      undefined,
      "A control moved under a stationary pointer must re-arm",
    );
    await expect(approve("two")).toBeEnabled();
    await approve("two").click();
    await expect.poll(() => result("two")).toBe(true);

    // Pairing uses its real absolute main-owned expiry; no timers are mocked.
    await app.evaluate(() => {
      const f = globalThis.approvalFixture;
      f.add("expires", "Credentials", Date.now() + 2500);
      f.add("after-expiry");
      f.dialog.openApprovals();
    });
    await expect(approve("expires")).toBeEnabled();
    const expiryBox = await approve("after-expiry").boundingBox();
    await expect.poll(() => result("expires")).toBe(false);
    await expect(dialog.locator(".approval-placeholder")).toHaveCount(1);
    assertRetainedFootprint(
      expiryBox,
      await approve("after-expiry").boundingBox(),
      "Expiry retains its inert footprint",
    );
    await expect(dialog.locator(".approval-placeholder")).toHaveCount(0);
    await expect(approve("after-expiry")).toBeDisabled();
    await expect(approve("after-expiry")).toBeEnabled();
    await expect(bulk()).toBeEnabled();

    // A native mouse press snapshots the original set, even through another row's guard.
    const box = await bulk().boundingBox();
    await dialog.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await dialog.mouse.down();
    await add("after-press");
    await expect(approve("after-press")).toBeEnabled();
    await expect(bulk()).toBeEnabled();
    assert.deepEqual(
      await bulk().boundingBox(),
      box,
      "Updating the bulk count must retain its geometry",
    );
    await expect(bulk()).toBeFocused();
    await dialog.mouse.up();
    await expect.poll(() => result("after-expiry")).toBe(true);
    assert.equal(
      await result("after-press"),
      undefined,
      "A later arrival cannot join the pressed snapshot",
    );
    await expect(dialog.locator(".approval-placeholder")).toHaveCount(0);
    await expect(bulk()).toBeEnabled();

    // Space activates on release: its key-down must snapshot exactly like pointer-down.
    await bulk().focus();
    await dialog.keyboard.down("Space");
    await add("after-keydown");
    await expect(approve("after-keydown")).toBeEnabled();
    await expect(bulk()).toBeEnabled();
    await dialog.keyboard.up("Space");
    await expect.poll(() => result("after-press")).toBe(true);
    assert.equal(await result("after-keydown"), undefined);
    await expect(dialog.locator(".approval-placeholder")).toHaveCount(0);
    await expect(bulk()).toBeEnabled();

    // Revalidate only surviving captured IDs. A withdrawn captured row is excluded.
    await add("withdraw-captured");
    await expect(approve("withdraw-captured")).toBeEnabled();
    await expect(bulk()).toBeEnabled();
    const captureBox = await bulk().boundingBox();
    await dialog.mouse.move(
      captureBox.x + captureBox.width / 2,
      captureBox.y + captureBox.height / 2,
    );
    await dialog.mouse.down();
    await abort("withdraw-captured");
    await add("after-withdrawal");
    await expect(approve("after-withdrawal")).toBeEnabled();
    await expect(bulk()).toBeEnabled();
    await dialog.mouse.up();
    await expect.poll(() => result("after-keydown")).toBe(true);
    assert.equal(await result("withdraw-captured"), false);
    assert.equal(await result("after-withdrawal"), undefined);
    await expect(dialog.locator(".approval-placeholder")).toHaveCount(0);
    await expect(bulk()).toBeEnabled();

    await add("authority", "Authority");
    await expect(approve("authority")).toBeEnabled();
    const synthetic = async (button) => {
      const trusted = await button.evaluate((element) => {
        const events = [];
        const record = (event) => events.push(event.isTrusted);
        element.addEventListener("click", record);
        element.click();
        element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
        element.click();
        element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
        element.click();
        element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: " " }));
        element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: " " }));
        element.click();
        element.removeEventListener("click", record);
        return events;
      });
      assert.deepEqual(trusted, [false, false, false, false]);
    };
    await synthetic(approve("authority"));
    await synthetic(row("authority").getByRole("button", { name: "Decline", exact: true }));
    await synthetic(bulk());
    assert.equal(await result("authority"), undefined);
    assert.equal(await result("after-withdrawal"), undefined);
    // Genuine keyboard decisions still work for sensitive individual approvals and declines.
    await approve("authority").focus();
    await dialog.keyboard.press("Enter");
    await expect.poll(() => result("authority")).toBe(true);
    await expect(dialog.locator(".approval-placeholder")).toHaveCount(0);
    await expect(
      row("after-withdrawal").getByRole("button", { name: "Decline", exact: true }),
    ).toBeEnabled();
    await row("after-withdrawal").getByRole("button", { name: "Decline", exact: true }).focus();
    await dialog.keyboard.press("Space");
    await expect.poll(() => result("after-withdrawal")).toBe(false);
  } finally {
    await native.dispose();
  }
});

test("native queue recentering re-arms decisions before a stationary screen-point click", {
  timeout: deadline(60000),
}, async (context) => {
  const { app, board } = await launchApprovalFixture(context);
  const { dialog, native, row, approve } = await openFixtureDialog(app, board);
  try {
    await expect(approve("one")).toBeEnabled();
    const decline = await row("one")
      .getByRole("button", { name: "Decline", exact: true })
      .boundingBox();
    const cssBefore = await approve("one").boundingBox();
    const before = await native.evaluate((window) => window.getContentBounds());
    const zoom = await native.evaluate((window) => window.webContents.getZoomFactor());
    const screenPoint = {
      x: before.x + (decline.x + decline.width / 2) * zoom,
      y: before.y + (decline.y + decline.height / 2) * zoom,
    };
    await dialog.mouse.move((screenPoint.x - before.x) / zoom, (screenPoint.y - before.y) / zoom);
    await app.evaluate(({ BrowserWindow }, zoom) => {
      const parent = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "app://bundle/index.html",
      );
      parent.setBounds({ x: 30, y: 10, width: Math.round(1200 - 200 * zoom), height: 1000 });
    }, zoom);
    await expect
      .poll(() => native.evaluate((window) => window.getContentBounds().x))
      .not.toBe(before.x);
    await expect(approve("one")).toBeDisabled();
    const after = await native.evaluate((window) => window.getContentBounds());
    const cssAfter = await approve("one").boundingBox();
    assert.deepEqual(cssAfter, cssBefore, "Native recentering leaves the CSS rectangle unchanged");
    const click = { x: (screenPoint.x - after.x) / zoom, y: (screenPoint.y - after.y) / zoom };
    assert.ok(
      click.x >= cssAfter.x &&
        click.x <= cssAfter.x + cssAfter.width &&
        click.y >= cssAfter.y &&
        click.y <= cssAfter.y + cssAfter.height,
      "The old Decline screen point now hits Approve",
    );
    await dialog.mouse.click(click.x, click.y);
    assert.equal(await app.evaluate(() => globalThis.approvalFixture.results.one), undefined);
    await expect(approve("one")).toBeEnabled();
    await approve("one").click();
    await expect.poll(() => app.evaluate(() => globalThis.approvalFixture.results.one)).toBe(true);
  } finally {
    await native.dispose();
  }
});
