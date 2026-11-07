const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdtemp, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { deadline, expect } = require("./test-policy.js");
const {
  boardPage,
  confirmationPage,
  launchApp,
  removeAfterApps,
  openSettingsScreen,
} = require("./harness.js");
const { evidencePath } = require("../helpers/evidence.js");

const plain = "https://plain.example.test/path?case=Case";
const target = "https://actual.example.test/oauth?state=" + "x".repeat(2100);
const osc = (url, text) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;

test("terminal links open and copy complete targets with trusted confirmation, wrapping and primary-only gestures", {
  timeout: deadline(60000),
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-links-"));
  removeAfterApps(context, root);
  const program = path.join(root, "output.cjs");
  await writeFile(
    program,
    `
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const show = () => {
      process.stdout.write("\\x1bc" + ${JSON.stringify(
        [
          osc(target, "Sign in to continue"),
          plain,
          "https://wrapped.example.test/" + "w".repeat(230),
          osc(
            "https://osc.example.test/" + "s".repeat(230),
            "https://osc.example.test/" + "s".repeat(230),
          ),
          "https://hard.example.test/part/\r\ncontinuation-should-stay-separate",
          osc("file:///etc/passwd", "https://refused-file.example.test/"),
          osc("javascript:alert(1)", "https://refused-js.example.test/"),
          "LINK_FIXTURE_READY",
        ].join("\r\n"),
      )});
    };
    show();
    process.stdin.on("data", (data) => {
      if (data.toString() === "m") process.stdout.write("\\x1b[?1000h\\x1b[?1006h\\r\\nMOUSE_LINKS_READY");
      if (data.toString().includes("q")) { process.stdout.write("\\x1b[?1000l\\x1b[?1006l"); process.exit(0); }
    });
  `,
  );
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  await app.evaluate(({ shell }) => {
    globalThis.terminalOpenedLinks = [];
    shell.openExternal = async (url) => {
      globalThis.terminalOpenedLinks.push(url);
    };
  });
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL() === "app://bundle/index.html")
      .setSize(1400, 1000);
  });
  const command = `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${program}"`;
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-rows")).toContainText("LINK_FIXTURE_READY");
  await openSettingsScreen(page);
  await expect(page.getByRole("region", { name: "Settings", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator(".board-row[data-kind='shell']").click();
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await writeFile(
    evidencePath("screenshots-1065/fixture-links.json"),
    JSON.stringify(
      await page.evaluate(() => ({
        links: Array.from(document.querySelectorAll(".terminal-link"), (element) =>
          element.getAttribute("aria-label"),
        ),
        rows: Array.from(
          document.querySelectorAll(".xterm-rows > div"),
          (element) => element.textContent,
        ),
      })),
      null,
      2,
    ),
  );
  const links = page.locator(".terminal-link");
  await expect(page.getByRole("link", { name: plain, exact: true })).toHaveCount(1);
  const label = page.getByRole("link", { name: target, exact: true });
  await expect(label).toHaveCount(1);
  await page.locator(".terminal-tile").getByRole("button", { name: "Hide", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(label).toBeFocused();
  const opened = () => app.evaluate(() => globalThis.terminalOpenedLinks);
  assert.deepEqual(await opened(), []);
  const point = async (url, row = 0) => {
    const bounds = await page
      .getByRole("link", { name: url, exact: true })
      .locator(":scope > span")
      .nth(row)
      .boundingBox();
    assert.ok(bounds);
    return { x: bounds.x + Math.min(15, bounds.width / 2), y: bounds.y + bounds.height / 2 };
  };
  const click = async (url, button = "left", row = 0, modifiers = []) => {
    const position = await point(url, row);
    for (const key of modifiers) await page.keyboard.down(key);
    await page.mouse.click(position.x, position.y, { button });
    for (const key of modifiers.reverse()) await page.keyboard.up(key);
  };
  const menu = page.getByRole("menu", { name: "Terminal menu", exact: true });
  const dialog = await confirmationPage(app);
  const heading = dialog.getByRole("heading", { name: "Open this link?" });
  const approve = async (url) => {
    await expect(heading).toBeVisible();
    await expect(dialog.locator(".facts")).toContainText(url);
    await dialog.getByRole("button", { name: "Open in browser", exact: true }).click();
  };

  // No earlier hover is required for Copy link, and Copy still reflects selection.
  await click(target, "right");
  await expect(menu.getByRole("menuitem", { name: "Copy link", exact: true })).toBeEnabled();
  await expect(menu.getByRole("menuitem", { name: "Copy", exact: true })).toBeDisabled();
  await menu.getByRole("menuitem", { name: "Copy link", exact: true }).click();
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), target);
  await expect(heading).toHaveCount(0);

  // Every activation confirms the full target and host; Cancel is the default.
  await click(target);
  await expect(heading).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await expect(dialog.locator(".facts")).toContainText(target);
  await expect(dialog.locator(".subject")).toHaveText("actual.example.test");
  for (const theme of ["light", "dark"]) {
    // Theme publications also update an already visible trusted window.
    await page.evaluate(
      (theme) => window.desktop.saveSetup({ interfaceTheme: `eclipse-${theme}` }),
      theme,
    );
    await expect
      .poll(() =>
        dialog.locator("html").evaluate((element) => getComputedStyle(element).colorScheme),
      )
      .toContain(theme);
    await dialog.screenshot({
      path: evidencePath(`screenshots-1065/${theme}-confirmation.png`),
      animations: "disabled",
    });
  }
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.deepEqual(await opened(), []);
  await click(target, "right");
  await menu.getByRole("menuitem", { name: "Open link", exact: true }).click();
  await expect(heading).toBeVisible();
  await dialog.getByRole("button", { name: "Open in browser", exact: true }).click();
  await expect.poll(opened).toEqual([target]);

  // Repeated secondary gestures after a primary press reproduce stale xterm state.
  await click(target, "right");
  await expect(menu).toBeVisible();
  await expect(heading).toHaveCount(0);
  await page.keyboard.press("Escape");
  await click(target, "middle");
  await expect(heading).toHaveCount(0);
  assert.deepEqual(await opened(), [target]);
  await click(plain);
  await approve(plain);
  await expect.poll(opened).toEqual([target, plain]);
  await expect(heading).toHaveCount(0);
  // Wrapped OSC and plain links confirm their complete targets from any row.
  const wrapped = "https://wrapped.example.test/" + "w".repeat(230);
  const wrappedOsc = "https://osc.example.test/" + "s".repeat(230);
  for (const url of [wrapped, wrappedOsc]) {
    const segments = page.getByRole("link", { name: url, exact: true }).locator(":scope > span");
    assert.ok((await segments.count()) > 1);
    const position = await point(url, 1);
    await page.mouse.move(position.x, position.y);
    await expect(page.locator(".xterm-screen")).toHaveAttribute("title", url);
    await expect(page.getByRole("link", { name: url, exact: true })).toHaveClass(/hovered/);
    await click(url, "right", 1);
    await menu.getByRole("menuitem", { name: "Copy link", exact: true }).click();
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), url);
    await click(url, "left", 1);
    await approve(url);
    await expect.poll(opened).toContain(url);
    await expect(heading).toHaveCount(0);
  }
  await expect(
    page.getByRole("link", { name: "https://hard.example.test/part/", exact: true }),
  ).toHaveCount(1);
  await expect(links).toHaveCount(5);
  const refusedCount = (await opened()).length;
  for (const text of ["https://refused-file.example.test/", "https://refused-js.example.test/"]) {
    const row = page.locator(".xterm-rows > div").filter({ hasText: text });
    const bounds = await row.boundingBox();
    assert.ok(bounds);
    await page.mouse.click(bounds.x + 15, bounds.y + bounds.height / 2);
    await expect(heading).toHaveCount(0);
  }
  assert.equal((await opened()).length, refusedCount);
  const keyboardLink = page.getByRole("link", { name: wrappedOsc, exact: true });
  await keyboardLink.focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu.getByRole("menuitem", { name: "Copy link", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), wrappedOsc);
  await keyboardLink.focus();
  await page.keyboard.press("Enter");
  await approve(wrappedOsc);
  await expect.poll(async () => (await opened()).length).toBe(refusedCount + 1);
  await expect(keyboardLink).toBeFocused();

  // Native selection remains selected when a link's right-click is captured.
  await click(plain, "right");
  await menu.getByRole("menuitem", { name: "Select all", exact: true }).click();
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (theme) => window.desktop.saveSetup({ interfaceTheme: `eclipse-${theme}` }),
      theme,
    );
    await click(plain, "right");
    await expect(menu.getByRole("menuitem", { name: "Copy", exact: true })).toBeEnabled();
    await expect(menu.getByRole("menuitem", { name: "Copy link", exact: true })).toBeEnabled();
    await page.screenshot({
      path: evidencePath(`screenshots-1065/${theme}-menu.png`),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
  }
  await click(plain, "right");
  await menu.getByRole("menuitem", { name: "Copy", exact: true }).click();
  assert.match(await app.evaluate(({ clipboard }) => clipboard.readText()), /LINK_FIXTURE_READY/);
  // Clear selection with an ordinary click away from links.
  await page.locator(".xterm-screen").click({ position: { x: 400, y: 500 } });
  await page.keyboard.type("m");
  await expect(page.locator(".xterm-rows")).toContainText("MOUSE_LINKS_READY");
  await click(plain, "right");
  await expect(menu).toHaveCount(0);
  await click(plain, "right", 0, ["Shift"]);
  await expect(menu.getByRole("menuitem", { name: "Copy link", exact: true })).toBeEnabled();
  await menu.getByRole("menuitem", { name: "Copy link", exact: true }).click();
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), plain);
  const count = (await opened()).length;
  await click(plain);
  await approve(plain);
  await expect.poll(async () => (await opened()).length).toBe(count + 1);
  await page.keyboard.type("q");
  const id = (await page.evaluate(() => window.desktop.workspace())).terminals[0].id;
  await expect
    .poll(() => page.evaluate(async (id) => (await window.desktop.tail(id, 5)).join("\n"), id))
    .toMatch(/[$#%>]\s*$/);
  await page.evaluate(
    (id) =>
      new Promise((resolve) => {
        const off = window.desktop.onExit((terminal, code) => {
          if (terminal === id) {
            off();
            resolve(code);
          }
        });
        window.desktop.input(id, "exit\r");
      }),
    id,
  );
  const exitedCount = (await opened()).length;
  await click(plain);
  await approve(plain);
  await expect.poll(async () => (await opened()).length).toBe(exitedCount + 1);
});

test("terminal links retain complete targets under oversized normal and alternate replay", {
  timeout: deadline(60000),
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-link-budget-"));
  removeAfterApps(context, root);
  const program = path.join(root, "budget.cjs");
  const targets = Array.from({ length: 300 }, (_, i) =>
    `https://budget.test/${i}/`.padEnd(16000, "x"),
  );
  await writeFile(
    program,
    `
    process.stdin.setRawMode(true); process.stdin.resume();
    const targets = ${JSON.stringify(targets)};
    const osc = url => "\\x1b]8;;" + url + "\\x1b\\\\x\\x1b]8;;\\x1b\\\\";
    process.stdout.write("\\x1bcBUDGET_FIXTURE_READY");
    process.stdin.on("data", data => {
      if (data.toString() === "b") process.stdout.write("\\x1bc" + targets.map(osc).join("") + "\\r\\nBUDGET_READY");
      if (data.toString() === "a") process.stdout.write("\\x1bc" + targets.slice(0,150).map(osc).join("") + "\\r\\nNORMAL_BUDGET_READY\\x1b[?1049h" + targets.slice(150).map(osc).join("") + "\\r\\nALT_BUDGET_READY");
      if (data.toString() === "n") process.stdout.write("\\x1b[?1049l");
    });
  `,
  );
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  await page.keyboard.type(
    `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${program}"`,
  );
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-rows")).toContainText("BUDGET_FIXTURE_READY");
  const id = (await page.evaluate(() => window.desktop.workspace())).terminals[0].id;
  const reattach = async (marker) => {
    await openSettingsScreen(page);
    await page.keyboard.press("Escape");
    await page.locator(".board-row[data-kind='shell']").click();
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
    await expect(page.locator(".xterm-rows")).toContainText(marker);
  };
  await page.evaluate((id) => window.desktop.input(id, "b"), id);
  await expect(page.locator(".xterm-rows")).toContainText("BUDGET_READY");
  await reattach("BUDGET_READY");
  for (const url of [targets[0], targets.at(-1)])
    await expect(page.getByRole("link", { name: url, exact: true })).toHaveCount(1);
  await page.evaluate((id) => window.desktop.input(id, "a"), id);
  await expect(page.locator(".xterm-rows")).toContainText("ALT_BUDGET_READY");
  await reattach("ALT_BUDGET_READY");
  await expect(page.getByRole("link", { name: targets.at(-1), exact: true })).toHaveCount(1);
  await page.evaluate((id) => window.desktop.input(id, "n"), id);
  await expect(page.locator(".xterm-rows")).toContainText("NORMAL_BUDGET_READY");
  await expect(page.getByRole("link", { name: targets[0], exact: true })).toHaveCount(1);
});

test("terminal links always confirm plain, matching OSC, differing OSC and long OAuth targets with trusted input", {
  timeout: deadline(60000),
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-link-confirm-"));
  removeAfterApps(context, root);
  const program = path.join(root, "confirm.cjs");
  const oauth =
    "https://login.example/oauth?redirect_uri=https%3A%2F%2Fapp.example%2Fcallback&scope=openid%20profile&state=" +
    "x".repeat(2100);
  const cases = [
    { url: plain, output: plain },
    {
      url: "https://matching.example/path",
      output: osc("https://matching.example/path", "https://matching.example/path"),
    },
    {
      url: "https://destination.example/path",
      output: osc("https://destination.example/path", "https://friendly.example/path"),
    },
    { url: oauth, output: osc(oauth, oauth) },
  ];
  await writeFile(
    program,
    `
    process.stdin.setRawMode(true); process.stdin.resume();
    const cases = ${JSON.stringify(cases)};
    process.stdout.write("\\x1bcCONFIRM_FIXTURE_READY");
    process.stdin.on("data", data => {
      const index = Number(data.toString());
      if (Number.isInteger(index) && cases[index]) process.stdout.write("\\x1bc" + cases[index].output + "\\r\\nCONFIRM_CASE_" + index);
    });
  `,
  );
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  await app.evaluate(({ shell }) => {
    globalThis.confirmedLinks = [];
    shell.openExternal = async (url) => {
      globalThis.confirmedLinks.push(url);
    };
  });
  await page.keyboard.type(
    `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${program}"`,
  );
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-rows")).toContainText("CONFIRM_FIXTURE_READY");
  const id = (await page.evaluate(() => window.desktop.workspace())).terminals[0].id;
  const dialog = await confirmationPage(app);
  const heading = dialog.getByRole("heading", { name: "Open this link?" });
  const opened = () => app.evaluate(() => globalThis.confirmedLinks);
  for (const [index, { url }] of cases.entries()) {
    await page.evaluate(({ id, index }) => window.desktop.input(id, String(index)), { id, index });
    await expect(page.locator(".xterm-rows")).toContainText(`CONFIRM_CASE_${index}`);
    const link = page.getByRole("link", { name: url, exact: true });
    await expect(link).toHaveCount(1);
    const bounds = await link.locator(":scope > span").first().boundingBox();
    assert.ok(bounds);
    const x = bounds.x + Math.min(10, bounds.width / 2);
    const y = bounds.y + bounds.height / 2;
    const before = await opened();
    await page.mouse.click(x, y, { button: "right" });
    await page.getByRole("menuitem", { name: "Copy link", exact: true }).click();
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), url);
    await expect(heading).toHaveCount(0);
    assert.deepEqual(await opened(), before);
    await page.mouse.click(x, y);
    await expect(heading).toBeVisible();
    await expect(dialog.locator(".facts")).toContainText(url);
    assert.deepEqual(await opened(), before);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.deepEqual(await opened(), before);
    await link.focus();
    await page.keyboard.press("Enter");
    await expect(heading).toBeVisible();
    await expect(dialog.locator(".facts")).toContainText(url);
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await dialog.keyboard.press("Enter");
    await expect(heading).toHaveCount(0);
    assert.deepEqual(await opened(), before);
    await link.focus();
    await page.keyboard.press("Enter");
    await expect(heading).toBeVisible();
    await expect(dialog.locator(".facts")).toContainText(url);
    assert.deepEqual(await opened(), before);
    await dialog.getByRole("button", { name: "Open in browser", exact: true }).click();
    await expect.poll(opened).toEqual([...before, url]);
  }
});
