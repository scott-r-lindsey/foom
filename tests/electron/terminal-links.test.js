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

  // No earlier hover is required for Copy link, and Copy still reflects selection.
  await click(target, "right");
  await expect(menu.getByRole("menuitem", { name: "Copy link", exact: true })).toBeEnabled();
  await expect(menu.getByRole("menuitem", { name: "Copy", exact: true })).toBeDisabled();
  await menu.getByRole("menuitem", { name: "Copy link", exact: true }).click();
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), target);
  await expect(heading).toHaveCount(0);

  // A mismatch confirms the real target and host; Cancel is the default.
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
  await expect.poll(opened).toEqual([target, plain]);
  await expect(heading).toHaveCount(0);
  // Exact match is full and case-sensitive, including all joined OSC rows.
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
  // Exit is a parser event; wait for its hidden cursor to be painted before
  // asserting the matching-link skip on the settled exited screen.
  await expect(page.locator(".xterm-cursor")).toHaveCount(0);
  const exitedCount = (await opened()).length;
  await click(plain);
  await expect.poll(async () => (await opened()).length).toBe(exitedCount + 1);
});

test("terminal link security confirms gaps, hidden colors and noncanonical targets while preserving OAuth and oversized replay", {
  timeout: deadline(60000),
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-link-security-"));
  removeAfterApps(context, root);
  const program = path.join(root, "security.cjs");
  const gap = "https://evil.test/x";
  const hidden = ["rgb-osc", "rgb-plain", "palette-osc", "palette-plain"].map((kind) => {
    const url = `https://good.example@evil.test/${kind}`;
    const sgr = kind.startsWith("rgb") ? "38;2;0;0;0;48;2;0;0;0" : "30;40";
    const text = `https://good.example\x1b[${sgr}m@evil.test/${kind}\x1b[0m`;
    return { url, output: kind.endsWith("osc") ? osc(url, text) : text };
  });
  const suspicious = [
    "https://good.example\u2215login.evil.test/",
    "https://evil.test\\.good.example/",
    "https://good.example/\u200bpath",
    "https://good.example@evil.test/",
    "https://good.example%2Flogin@evil.test/",
  ].flatMap((base) => [
    { url: base + "?osc", output: osc(base + "?osc", base + "?osc") },
    { url: base + "?plain", output: base + "?plain" },
  ]);
  const oauth =
    "https://login.example/oauth?redirect_uri=https%3A%2F%2Fapp.example%2Fcallback&scope=openid%20profile&state=" +
    "x".repeat(2100);
  const contrastOutput =
    "\x1bc\x1b]10;#000001\x1b\\\x1b]11;#000000\x1b\\" +
    osc("https://contrast.example.test/path", "https://contrast.example.test/path") +
    "\r\nCONTRAST_READY";
  const resetColors = "\x1b]110;\x1b\\\x1b]111;\x1b\\\x1bc";
  const budgetTargets = Array.from({ length: 300 }, (_, i) =>
    `https://budget.test/${i}/`.padEnd(16000, "x"),
  );
  await writeFile(
    program,
    `
    process.stdin.setRawMode(true); process.stdin.resume();
    const osc = (url, text, id = "") => "\\x1b]8;" + id + ";" + url + "\\x1b\\\\" + text + "\\x1b]8;;\\x1b\\\\";
    const gap = ${JSON.stringify(gap)};
    const targets = ${JSON.stringify(budgetTargets)};
    const clipped = "https://good.example.evil.test/" + "x".repeat(process.stdout.columns * 2);
    process.stdout.write("\\x1bc" + osc(gap, "https://", "id=a") + "good.example/account" + " ".repeat(process.stdout.columns - 28 + 30) + osc(gap, "evil.test/x", "id=a") + "\\r\\n" + ${JSON.stringify(
      [...hidden, ...suspicious]
        .map((entry) => entry.output)
        .concat("https://a.test/\u061cpath", "SECURITY_READY")
        .join("\r\n"),
    )});
    process.stdin.on("data", (data) => {
      if (data.toString() === "o") process.stdout.write("\\x1bc" + osc(${JSON.stringify(oauth)}, ${JSON.stringify(oauth)}) + "\\r\\nOAUTH_READY");
      if (data.toString() === "p") process.stdout.write("\\x1bc" + ${JSON.stringify(oauth)} + "\\r\\nPLAIN_OAUTH_READY");
      if (data.toString() === "b") process.stdout.write("\\x1bc" + targets.map(url => osc(url, "x")).join("") + "\\r\\nBUDGET_READY");
      if (data.toString() === "a") process.stdout.write("\\x1bc" + targets.slice(0, 150).map(url => osc(url, "n")).join("") + "\\r\\nNORMAL_BUDGET_READY\\x1b[?1049h" + targets.slice(150).map(url => osc(url, "a")).join("") + "\\r\\nALT_BUDGET_READY");
      if (data.toString() === "n") process.stdout.write("\\x1b[?1049l");
      if (data.toString() === "c") process.stdout.write(${JSON.stringify(contrastOutput)});
      if (data.toString() === "v") process.stdout.write(${JSON.stringify(resetColors)} + "\\r\\n".repeat(process.stdout.rows - 1) + osc(clipped, clipped) + "\\r\\nCLIPPED_READY");
      if (data.toString() === "q") process.exit(0);
    });
  `,
  );
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  await app.evaluate(({ shell }) => {
    globalThis.securityOpenedLinks = [];
    shell.openExternal = async (url) => {
      globalThis.securityOpenedLinks.push(url);
    };
  });
  await page.keyboard.type(
    `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${program}"`,
  );
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-rows")).toContainText("SECURITY_READY");
  const id = (await page.evaluate(() => window.desktop.workspace())).terminals[0].id;
  const dialog = await confirmationPage(app);
  const heading = dialog.getByRole("heading", { name: "Open this link?" });
  const opened = () => app.evaluate(() => globalThis.securityOpenedLinks);
  const click = async (url) => {
    const bounds = await page
      .getByRole("link", { name: url, exact: true })
      .locator(":scope > span")
      .first()
      .boundingBox();
    assert.ok(bounds);
    await page.mouse.click(bounds.x + Math.min(10, bounds.width / 2), bounds.y + bounds.height / 2);
  };
  // Confirm this fixture really hides a suffix in the rendered app, not only in cell metadata.
  const styles = await page
    .locator(".xterm-rows span")
    .filter({ hasText: "@evil.test/rgb-osc" })
    .first()
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return { foreground: style.color, background: style.backgroundColor };
    });
  assert.equal(styles.foreground, styles.background);
  for (const url of [
    gap,
    ...hidden.map((entry) => entry.url),
    ...suspicious.map((entry) => entry.url),
  ]) {
    await click(url);
    await expect(heading).toBeVisible();
    await expect(dialog.locator(".facts")).toContainText(new URL(url).host);
    assert.deepEqual(await opened(), []);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(heading).toHaveCount(0);
  }
  await expect(
    page.getByRole("link", { name: "https://a.test/\u061cpath", exact: true }),
  ).toHaveCount(0);
  for (const [mode, marker] of [
    ["o", "OAUTH_READY"],
    ["p", "PLAIN_OAUTH_READY"],
  ]) {
    await page.evaluate(({ id, mode }) => window.desktop.input(id, mode), { id, mode });
    await expect(page.locator(".xterm-rows")).toContainText(marker);
    await click(oauth);
    await expect.poll(opened).toHaveLength(mode === "o" ? 1 : 2);
    await expect(heading).toHaveCount(0);
  }
  assert.deepEqual(await opened(), [oauth, oauth]);
  await page.evaluate((id) => window.desktop.input(id, "c"), id);
  await expect(page.locator(".xterm-rows")).toContainText("CONTRAST_READY");
  await click("https://contrast.example.test/path");
  await expect(heading).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.evaluate((id) => window.desktop.input(id, "v"), id);
  await expect(page.locator(".xterm-rows")).toContainText("CLIPPED_READY");
  await page.locator(".xterm-screen").hover();
  await page.mouse.wheel(0, -10000);
  const clipped = page.locator('.terminal-link[aria-label^="https://good.example.evil.test/"]');
  await expect(clipped).toHaveCount(1);
  const clipUrl = await clipped.getAttribute("aria-label");
  assert.ok(clipUrl);
  await expect(clipped.locator(":scope > span")).toHaveCount(1);
  await click(clipUrl);
  await expect(heading).toBeVisible();
  assert.deepEqual(await opened(), [oauth, oauth]);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.evaluate((id) => window.desktop.input(id, "b"), id);
  await expect(page.locator(".xterm-rows")).toContainText("BUDGET_READY");
  await openSettingsScreen(page);
  await page.keyboard.press("Escape");
  await page.locator(".board-row[data-kind='shell']").click();
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await expect(page.locator(".xterm-rows")).toContainText("BUDGET_READY");
  await expect(page.getByRole("link", { name: budgetTargets[0], exact: true })).toHaveCount(1);
  await expect(page.getByRole("link", { name: budgetTargets.at(-1), exact: true })).toHaveCount(1);
  await page.evaluate((id) => window.desktop.input(id, "a"), id);
  await expect(page.locator(".xterm-rows")).toContainText("ALT_BUDGET_READY");
  await openSettingsScreen(page);
  await page.keyboard.press("Escape");
  await page.locator(".board-row[data-kind='shell']").click();
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await expect(page.locator(".xterm-rows")).toContainText("ALT_BUDGET_READY");
  await page.evaluate((id) => window.desktop.input(id, "n"), id);
  await expect(page.locator(".xterm-rows")).toContainText("NORMAL_BUDGET_READY");
  await page.evaluate((id) => window.desktop.input(id, "q"), id);
});

for (const scenario of ["press", "paint"])
  test(`terminal links confirm press-time and unpainted gestures: ${scenario}`, {
    timeout: deadline(60000),
  }, async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), "foom-link-frame-"));
    removeAfterApps(context, root);
    const program = path.join(root, "frame.cjs");
    const evil = "https://evil.test/path";
    const unseen = "https://unseen.test/path";
    const oauth =
      "https://login.test/oauth?state=" +
      "x".repeat(400) +
      "&redirect_uri=https%3A%2F%2Fapp.test%2F";
    await writeFile(
      program,
      `
    process.stdin.setRawMode(true); process.stdin.resume();
    const osc = (url, label) => "\\x1b]8;;" + url + "\\x1b\\\\" + label + "\\x1b]8;;\\x1b\\\\";
    const show = (url, label, marker) => process.stdout.write("\\x1bc" + osc(url, label) + "\\r\\n" + marker);
    show(${JSON.stringify(evil)}, "https://good.example/path", "PRESS_READY");
    process.stdout.write("\\x1b[?1000h\\x1b[?1006h");
    process.stdin.on("data", data => {
      const value = data.toString();
      if (/\\x1b\\[<0;\\d+;\\d+M/.test(value)) show(${JSON.stringify(evil)}, ${JSON.stringify(evil)}, "REWRITTEN");
      if (value === "u") show(${JSON.stringify(unseen)}, ${JSON.stringify(unseen)}, "UNSEEN_PARSED");
      if (value === "o") show(${JSON.stringify(oauth)}, ${JSON.stringify(oauth)}, "OAUTH_SETTLED");
      if (value === "q") process.exit(0);
    });
  `,
    );
    const app = await launchApp(context, { fixture: "running-shell" });
    const page = await boardPage(app);
    await app.evaluate(({ shell, ipcMain }) => {
      globalThis.frameLinksOpened = [];
      globalThis.frameLinksAcks = {};
      shell.openExternal = async (url) => {
        globalThis.frameLinksOpened.push(url);
      };
      ipcMain.on("terminal:ack", (_event, id, token, count) => {
        const tokens = (globalThis.frameLinksAcks[id] ??= {});
        tokens[token] = (tokens[token] ?? 0) + count;
      });
    });
    await page.evaluate(() => {
      window.frameLinksData = {};
      window.frameLinksText = "";
      window.desktop.onData((_id, token, data) => {
        window.frameLinksData[token] = (window.frameLinksData[token] ?? 0) + data.length;
        window.frameLinksText += data;
      });
    });
    await page.keyboard.type(
      `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${program}"`,
    );
    await page.keyboard.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText("PRESS_READY");
    const id = (await page.evaluate(() => window.desktop.workspace())).terminals[0].id;
    const dialog = await confirmationPage(app);
    const heading = dialog.getByRole("heading", { name: "Open this link?" });
    const opened = () => app.evaluate(() => globalThis.frameLinksOpened);
    const bounds = await page
      .getByRole("link", { name: evil, exact: true })
      .locator(":scope > span")
      .first()
      .boundingBox();
    assert.ok(bounds);
    const point = { x: bounds.x + 10, y: bounds.y + bounds.height / 2 };
    if (scenario === "press") {
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      await expect(page.locator(".xterm-rows")).toContainText("REWRITTEN");
      await page.mouse.up();
      await expect(heading).toBeVisible();
      assert.deepEqual(await opened(), []);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    }
    if (scenario === "paint") {
      // Hold real xterm rendering, not parsing. ACKs establish the parser barrier.
      await page.evaluate(() => {
        window.savedFrameRequest = window.requestAnimationFrame;
        window.savedFrameCancel = window.cancelAnimationFrame;
        window.heldFrames = new Map();
        let next = 1000000;
        window.requestAnimationFrame = (callback) => {
          const id = ++next;
          window.heldFrames.set(id, callback);
          return id;
        };
        window.cancelAnimationFrame = (id) => {
          window.heldFrames.delete(id);
        };
      });
      try {
        await page.evaluate((id) => window.desktop.input(id, "u"), id);
        await expect
          .poll(() => page.evaluate(() => window.frameLinksText.includes("UNSEEN_PARSED")))
          .toBe(true);
        await expect
          .poll(async () => {
            const delivered = await page.evaluate(() => window.frameLinksData);
            const parsed = await app.evaluate((_electron, id) => globalThis.frameLinksAcks[id], id);
            return Object.entries(delivered).every(([token, count]) => parsed?.[token] >= count);
          })
          .toBe(true);
        await expect(page.locator(".xterm-rows")).not.toContainText(unseen);
        await page.mouse.click(point.x, point.y);
        await expect(heading).toBeVisible();
        await expect(dialog.locator(".facts")).toContainText(unseen);
        assert.deepEqual(await opened(), []);
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      } finally {
        await page.evaluate(() => {
          window.requestAnimationFrame = window.savedFrameRequest;
          window.cancelAnimationFrame = window.savedFrameCancel;
          for (const callback of window.heldFrames.values()) window.requestAnimationFrame(callback);
          window.heldFrames.clear();
        });
      }
    }
    await page.evaluate((id) => window.desktop.input(id, "o"), id);
    await expect(page.locator(".xterm-rows")).toContainText("OAUTH_SETTLED");
    const settled = await page
      .getByRole("link", { name: oauth, exact: true })
      .locator(":scope > span")
      .first()
      .boundingBox();
    assert.ok(settled);
    await page.mouse.click(settled.x + 10, settled.y + settled.height / 2);
    await expect.poll(opened).toEqual([oauth]);
    await expect(heading).toHaveCount(0);
    await page.evaluate((id) => window.desktop.input(id, "q"), id);
  });
