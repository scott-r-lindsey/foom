const { evidencePath } = require("../helpers/evidence.js");
const { gitSync: isolatedGit } = require("../helpers/git.js");
const { AxeBuilder } = require("@axe-core/playwright");
const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { deadline, expect } = require("./test-policy.js");
const {
  assertAccessible,
  assertConfirmationFocus,
  boardPage,
  captureConfirmationDesktop,
  confirmationPage,
  launchApp,
  openSettingsScreen,
  quitAndWait,
  removeAfterApps,
} = require("./harness.js");

// Capture the composed desktop, never the dialog CDP target: CDP can see and
// click a window hidden underneath its parent. A blank patch halfway down the
// dialog's left padding and a blank patch inside its dark commit button avoid
// text and borders. The button keeps the comparison distinct from a pale board.
async function confirmationDesktop(app, name, footer) {
  await mkdir("test-results", { recursive: true });
  const evidence = await app.evaluate(
    async ({ BrowserWindow, desktopCapturer, screen }, footer) => {
      const dialog = BrowserWindow.getAllWindows().find(
        (window) =>
          window.webContents.getURL() === "app://confirmation/confirmation.html" &&
          window.isVisible(),
      );
      const bounds = dialog.getContentBounds();
      const display = screen.getDisplayMatching(bounds);
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: {
          width: Math.round(display.bounds.width * display.scaleFactor),
          height: Math.round(display.bounds.height * display.scaleFactor),
        },
      });
      const source = sources.find((source) => source.display_id === String(display.id));
      if (!source || source.thumbnail.isEmpty()) throw Error("No composed screen capture");
      const image = source.thumbnail;
      const size = image.getSize();
      const scaleX = size.width / display.bounds.width;
      const scaleY = size.height / display.bounds.height;
      const patches = [{ x: 12, y: Math.floor(bounds.height / 2), width: 6, height: 6 }, footer];
      const pixel = (image) =>
        Array.from(image.resize({ width: 1, height: 1 }).toBitmap()).slice(0, 3);
      const actual = patches.flatMap((patch) =>
        pixel(
          image.crop({
            x: Math.round((bounds.x - display.bounds.x + patch.x) * scaleX),
            y: Math.round((bounds.y - display.bounds.y + patch.y) * scaleY),
            width: Math.max(1, Math.round(patch.width * scaleX)),
            height: Math.max(1, Math.round(patch.height * scaleY)),
          }),
        ),
      );
      // These are only color references. The assertion uses composed desktop
      // pixels above, which include native stacking and the board scrim.
      const expected = (
        await Promise.all(
          patches.map(async (patch) => pixel(await dialog.webContents.capturePage(patch))),
        )
      ).flat();
      return {
        actual,
        expected,
        png: image.toPNG().toString("base64"),
        windows: BrowserWindow.getAllWindows().map((window) => ({
          id: window.id,
          url: window.webContents.getURL(),
          bounds: window.getBounds(),
          visible: window.isVisible(),
          focused: window.isFocused(),
          enabled: window.isEnabled(),
          parent: window.getParentWindow()?.id,
        })),
      };
    },
    footer,
  );
  await writeFile(
    evidencePath(`confirmation-stacking-${name}.png`),
    Buffer.from(evidence.png, "base64"),
  );
  return { actual: evidence.actual, expected: evidence.expected, windows: evidence.windows };
}

function dialogAboveBoard(evidence) {
  return evidence.actual.every(
    (channel, index) => Math.abs(channel - evidence.expected[index]) <= 12,
  );
}

function assertDialogAboveBoard(evidence) {
  assert.ok(
    dialogAboveBoard(evidence),
    `The composed desktop must show the dialog surface above the scrim: ${JSON.stringify(evidence)}`,
  );
}

test("trusted quit dialog appears above the board on first show and after hide/show reuse", {
  timeout: deadline(45_000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const board = await boardPage(app);
  const dialog = await confirmationPage(app);
  const evidence = [];
  const paintErrors = [];
  for (const phase of ["first", "reused"]) {
    await app.evaluate(({ app }) => app.quit());
    await expect(dialog.getByRole("alertdialog")).toHaveAccessibleName(
      "Quit with 1 terminal running?",
    );
    await expect(board.locator(".board-confirmation-scrim")).toBeVisible();
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find(
              (window) => window.webContents.getURL() === "app://confirmation/confirmation.html",
            )
            .isVisible(),
        ),
      )
      .toBe(true);
    // Wait for painted content without activating the CDP page or native window.
    await dialog.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const commit = await dialog
      .getByRole("button", { name: "Stop all and quit", exact: true })
      .boundingBox();
    if (!commit) throw Error("Missing quit commit button bounds");
    const footer = {
      x: Math.floor(commit.x + 4),
      y: Math.floor(commit.y + commit.height / 2 - 2),
      width: 4,
      height: 4,
    };
    // Renderer animation frames do not prove the native compositor finished
    // showing the window. Observe the same desktop pixels used by the assertion.
    let capture;
    try {
      await expect
        .poll(async () => {
          capture = await confirmationDesktop(app, phase, footer);
          return dialogAboveBoard(capture);
        })
        .toBe(true);
    } catch (error) {
      paintErrors.push(error);
    }
    if (!capture) throw paintErrors[paintErrors.length - 1];
    evidence.push(capture);
    if (phase === "reused") {
      // Negative control: a native opaque window covering the card must fail
      // the same check even though the dialog CDP target remains readable.
      const blocker = await app.evaluate(({ BrowserWindow }) => {
        const dialog = BrowserWindow.getAllWindows().find(
          (window) => window.webContents.getURL() === "app://confirmation/confirmation.html",
        );
        const cover = new BrowserWindow({
          ...dialog.getBounds(),
          frame: false,
          backgroundColor: "#00ff00",
          alwaysOnTop: true,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        return cover.id;
      });
      try {
        await expect
          .poll(() =>
            app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isVisible(), blocker),
          )
          .toBe(true);
        let covered;
        await expect
          .poll(async () => {
            covered = await confirmationDesktop(app, "covered-control", footer);
            return covered.actual.every(
              (channel, index) => Math.abs(channel - [0, 255, 0][index % 3]) <= 12,
            );
          })
          .toBe(true);
        assert.throws(() => assertDialogAboveBoard(covered));
      } finally {
        await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).destroy(), blocker);
      }
    }
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(board.locator(".board-confirmation-scrim")).toHaveCount(0);
    await expect(dialog.getByRole("alertdialog")).toHaveCount(0);
  }
  // Keep both captures even when the first show fails, so CI distinguishes
  // first-show ordering from a parent link lost only through hide/show.
  for (const capture of evidence) assertDialogAboveBoard(capture);
  if (paintErrors.length) throw paintErrors[0];
});

test("macOS quit from an inactive app activates trusted consent and keeps board close guarded", {
  skip: process.platform !== "darwin",
  timeout: deadline(45_000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const board = await boardPage(app);
  const dialog = await confirmationPage(app);
  for (const accept of [false, true]) {
    await app.evaluate(({ app }) => app.hide());
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow() === null))
      .toBe(true);
    // Keep the board available without activating Foom, as with Dock -> Quit.
    const inactive = await app.evaluate(({ app, BrowserWindow }) => {
      const board = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "app://bundle/index.html",
      );
      board.showInactive();
      const inactive = BrowserWindow.getFocusedWindow() === null;
      app.quit();
      return inactive;
    });
    assert.equal(inactive, true, "Quit must start without a focused Foom window");
    await expect(dialog.getByRole("alertdialog")).toHaveAccessibleName(
      "Quit with 1 terminal running?",
    );
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find(
              (window) => window.webContents.getURL() === "app://confirmation/confirmation.html",
            )
            .isFocused(),
        ),
      )
      .toBe(true);
    // The native board close button must not bypass or replace pending consent.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "app://bundle/index.html")
        .close();
    });
    await expect(board.locator(".board-confirmation-scrim")).toBeVisible();
    assert.equal(app.process().exitCode, null);
    if (accept) {
      await quitAndWait(app, () =>
        dialog
          .getByRole("button", {
            name: "Stop all and quit",
            exact: true,
          })
          .click(),
      );
    } else {
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(board.locator(".board-confirmation-scrim")).toHaveCount(0);
      assert.equal(
        await board.evaluate(async () => (await window.desktop.workspace()).terminals[0].exited),
        false,
      );
    }
  }
});

test("trusted dialog presentation failure releases the board and allows a new request", {
  timeout: deadline(45_000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const board = await boardPage(app);
  const dialog = await confirmationPage(app);
  await app.evaluate(({ BrowserWindow }) => {
    const dialog = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://confirmation/confirmation.html",
    );
    globalThis.realConfirmationPresentation = {
      show: dialog.show.bind(dialog),
      setParentWindow: dialog.setParentWindow.bind(dialog),
      moveTop: dialog.moveTop.bind(dialog),
      focus: dialog.focus.bind(dialog),
    };
    globalThis.realConfirmationContentsFocus = dialog.webContents.focus.bind(dialog.webContents);
    globalThis.failedConfirmationShows = 0;
    // Model refusal of every native presentation path: on macOS, moveTop or
    // focus can map a hidden window even when show is intercepted. The trusted
    // renderer still measures and renders its card.
    dialog.show = () => {
      globalThis.failedConfirmationShows++;
    };
    dialog.setParentWindow = () => {};
    dialog.moveTop = () => {};
    dialog.focus = () => {};
    dialog.webContents.focus = () => {};
  });
  try {
    await app.evaluate(({ app }) => app.quit());
    await expect(board.locator(".board-confirmation-scrim")).toBeVisible();
    await expect(board.locator(".board-confirmation-scrim")).toHaveCount(0);
    await expect(dialog.getByRole("alertdialog")).toHaveCount(0);
    assert.equal(await app.evaluate(() => globalThis.failedConfirmationShows), 2);
    assert.equal(app.process().exitCode, null, "Failed presentation must cancel quit");
    assert.equal(
      await board.evaluate(async () => (await window.desktop.workspace()).terminals[0].exited),
      false,
    );
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => {
          const board = BrowserWindow.getAllWindows().find(
            (window) => window.webContents.getURL() === "app://bundle/index.html",
          );
          return board.isEnabled() && board.isFocusable();
        }),
      )
      .toBe(true);
  } finally {
    await app.evaluate(({ BrowserWindow }) => {
      Object.assign(
        BrowserWindow.getAllWindows().find(
          (window) => window.webContents.getURL() === "app://confirmation/confirmation.html",
        ),
        globalThis.realConfirmationPresentation,
      );
      BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "app://confirmation/confirmation.html",
      ).webContents.focus = globalThis.realConfirmationContentsFocus;
    });
  }
  // DOM visibility precedes native presentation. Hide at main's explicit
  // presentation publication, after every native show/raise/focus call.
  await app.evaluate(({ BrowserWindow }) => {
    const dialog = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://confirmation/confirmation.html",
    );
    globalThis.confirmationHideTrace = [];
    const record = (phase) => {
      globalThis.confirmationHideTrace.push({
        phase,
        visible: dialog.isVisible(),
        focused: dialog.isFocused(),
        minimized: dialog.isMinimized(),
      });
    };
    for (const event of ["show", "hide", "focus", "blur", "minimize"])
      dialog.on(event, () => record(event));
    const send = dialog.webContents.send.bind(dialog.webContents);
    dialog.webContents.send = (channel, ...args) => {
      send(channel, ...args);
      if (channel === "confirmation:render" && args[0]?.presented === true) {
        dialog.webContents.send = send;
        record("presented");
        // macOS key focus takes precedence over occlusion reporting. Relinquish
        // it explicitly so this fixture represents an unavailable native child.
        dialog.blur();
        record("after-blur");
        dialog.hide();
        record("after-hide");
        setImmediate(() => record("after-native-callback"));
      }
    };
  });
  await app.evaluate(({ app }) => app.quit());
  await expect(board.locator(".board-confirmation-scrim")).toBeVisible();
  try {
    await expect(board.locator(".board-confirmation-scrim")).toHaveCount(0);
  } catch (error) {
    console.error(
      "Native confirmation hide trace:",
      await app.evaluate(() => globalThis.confirmationHideTrace),
    );
    throw error;
  }
  await expect(dialog.getByRole("alertdialog")).toHaveCount(0);
  assert.equal(app.process().exitCode, null, "Hiding during presentation must cancel quit");
  assert.equal(
    await board.evaluate(async () => (await window.desktop.workspace()).terminals[0].exited),
    false,
  );
  await app.evaluate(({ app }) => app.quit());
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(board.locator(".board-confirmation-scrim")).toHaveCount(0);
});

for (const loss of ["off-screen", "silent-hide"]) {
  test(`two boards recover a ${loss} trusted dialog from blocked board input without approval`, {
    skip: process.platform !== "linux",
    timeout: deadline(45_000),
  }, async (context) => {
    const app = await launchApp(context, { fixture: "running-shell" });
    const first = await boardPage(app);
    await first.evaluate(() => window.desktop.appMenu.execute("new-window"));
    let board;
    await expect
      .poll(() => {
        board = app
          .windows()
          .find((page) => page !== first && page.url() === "app://bundle/index.html");
        return Boolean(board);
      })
      .toBe(true);
    await expect(board.locator(".board-home")).toBeVisible();
    await app.evaluate(({ app }) => app.quit());
    let dialog;
    await expect
      .poll(async () => {
        for (const page of app.windows()) {
          if (
            page.url() === "app://confirmation/confirmation.html" &&
            (await page.getByRole("alertdialog").count())
          ) {
            dialog = page;
            return true;
          }
        }
        return false;
      })
      .toBe(true);
    // Counting DOM content does not establish native presentation.
    await expect(dialog.getByRole("alertdialog")).toBeVisible();
    // Quit belongs to the focused second board, not the first board's preloaded child.
    await expect(board.locator(".board-confirmation-scrim")).toBeVisible();
    await board.evaluate(() => {
      globalThis.blockedBoardEvents = 0;
      document.addEventListener("mousedown", () => globalThis.blockedBoardEvents++);
      document.addEventListener("keydown", () => globalThis.blockedBoardEvents++);
    });
    const lost = await app.evaluate(({ BrowserWindow }, loss) => {
      const dialog = BrowserWindow.getAllWindows().find(
        (window) =>
          window.webContents.getURL() === "app://confirmation/confirmation.html" &&
          window.isVisible(),
      );
      globalThis.lostDialogId = dialog.id;
      const parent = dialog.getParentWindow();
      if (loss === "off-screen") {
        dialog.setBounds({ ...dialog.getBounds(), x: -10000 });
      } else {
        // Model a WM unmap with no Electron hide notification. Do not fake the
        // native visibility/focus getters; recovery must map the real window.
        const emit = dialog.emit;
        dialog.emit = function (event, ...args) {
          if (event === "hide") return true;
          return emit.call(this, event, ...args);
        };
        dialog.once("show", () => {
          dialog.emit = emit;
        });
        dialog.hide();
      }
      return {
        focused: dialog.isFocused(),
        visible: dialog.isVisible(),
        bounds: dialog.getBounds(),
        enabled: parent.isEnabled(),
      };
    }, loss);
    if (process.platform === "linux") assert.equal(lost.enabled, true);
    if (loss === "off-screen") {
      assert.equal(lost.focused, true, "Native key focus alone must not prove reachability");
      assert.equal(lost.visible, true);
      assert.ok(lost.bounds.x < 0);
    }
    // Send to the blocked board surface. The native guard consumes the click
    // and must show/position/raise the child, not merely focus a hidden window.
    await app.evaluate(({ BrowserWindow }) => {
      const parent = BrowserWindow.fromId(globalThis.lostDialogId).getParentWindow();
      parent.webContents.sendInputEvent({
        type: "mouseDown",
        x: 12,
        y: 12,
        button: "left",
        clickCount: 1,
      });
      parent.webContents.sendInputEvent({
        type: "mouseUp",
        x: 12,
        y: 12,
        button: "left",
        clickCount: 1,
      });
    });
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow, screen }) => {
          const child = BrowserWindow.fromId(globalThis.lostDialogId);
          const bounds = child.getBounds();
          const work = screen.getDisplayMatching(bounds).workArea;
          return (
            child.isVisible() &&
            child.isFocused() &&
            bounds.x >= work.x &&
            bounds.y >= work.y &&
            bounds.x + bounds.width <= work.x + work.width &&
            bounds.y + bounds.height <= work.y + work.height
          );
        }),
      )
      .toBe(true);
    await expect(board.locator(".board-confirmation-scrim")).toBeVisible();
    assert.equal(await board.evaluate(() => globalThis.blockedBoardEvents), 0);
    assert.equal(app.process().exitCode, null);
    assert.equal(
      await first.evaluate(async () => (await window.desktop.workspace()).terminals[0].exited),
      false,
    );
    const commit = await dialog
      .getByRole("button", { name: "Stop all and quit", exact: true })
      .boundingBox();
    await expect
      .poll(async () =>
        dialogAboveBoard(
          await confirmationDesktop(app, loss, {
            x: Math.floor(commit.x + 4),
            y: Math.floor(commit.y + commit.height / 2 - 2),
            width: 4,
            height: 4,
          }),
        ),
      )
      .toBe(true);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(board.locator(".board-confirmation-scrim")).toHaveCount(0);
    assert.equal(app.process().exitCode, null);
    // Quit through this second board's child after proving cancellation kept it alive.
    await app.evaluate(({ app }) => app.quit());
    await expect(dialog.getByRole("button", { name: "Stop all and quit" })).toBeVisible();
    await quitAndWait(app, () => dialog.getByRole("button", { name: "Stop all and quit" }).click());
  });
}

// Exercise the real app/PTY lifecycle; control only the native dialog response so
// these checks run on all three desktop platforms without OS-specific UI drivers.
for (const action of ["close", "quit", "shortcut"]) {
  test(`quit via ${action} confirms, cancel preserves PTYs, and confirm reaps shells`, {
    timeout: deadline(45_000),
  }, async (context) => {
    const app = await launchApp(context, { fixture: "running-shell" });
    let page = await boardPage(app);
    if (action === "close" && process.platform === "darwin") {
      await page.evaluate(() => window.desktop.appMenu.execute("close-window"));
      await expect.poll(() => page.isClosed()).toBe(true);
      assert.equal(app.process().exitCode, null);
      await expect
        .poll(() =>
          app.evaluate(({ Menu }) => {
            const menu = Menu.getApplicationMenu();
            return ["new-window", "quit"].map((id) => {
              const item = menu.getMenuItemById(id);
              return {
                enabled: item.enabled,
                accelerator: item.accelerator,
                registered: item.registerAccelerator,
              };
            });
          }),
        )
        .toEqual([
          { enabled: true, accelerator: "Command+N", registered: true },
          { enabled: true, accelerator: "Command+Q", registered: true },
        ]);
      await app.evaluate(({ app }) => app.emit("activate"));
      page = await boardPage(app);
      await expect
        .poll(async () => (await page.evaluate(() => window.desktop.workspace())).terminals.length)
        .toBe(1);
      await page.locator(".session-name").click();
    }
    await page.waitForFunction(
      () => !/Starting|Unable/.test(document.querySelector(".tile-status").textContent),
    );
    await page.evaluate(() => {
      window.quitOutput = "";
      window.desktop.onData((_id, _token, data) => {
        window.quitOutput += data;
      });
    });
    const command =
      process.platform === "win32"
        ? 'Write-Output ("QUIT_PID:" + $PID)'
        : "printf 'QUIT_%s:%s\\n' PID $$";
    // A reopened board can report a running session before its view attaches.
    // Query the app-owned PTY without racing keyboard input against attachment.
    const first = await page.evaluate(
      async () => (await window.desktop.workspace()).terminals[0].id,
    );
    await page.evaluate(({ id, command }) => window.desktop.input(id, command + "\r"), {
      id: first,
      command,
    });
    await expect
      .poll(() => page.evaluate((id) => window.desktop.tail(id, 40), first))
      .toEqual(expect.arrayContaining([expect.stringMatching(/QUIT_PID:\d+/)]));
    const firstPid = await page.evaluate(
      async (id) =>
        Number((await window.desktop.tail(id, 40)).join("\n").match(/QUIT_PID:(\d+)/)[1]),
      first,
    );
    const second = await page.evaluate(async () => (await window.desktop.create(80, 24)).id);
    await page.evaluate(({ id, command }) => window.desktop.input(id, command + "\r"), {
      id: second,
      command,
    });
    // This terminal deliberately has no tile. Its headless screen and PTY must
    // keep running, without acquiring a renderer view outside the board layout.
    await expect
      .poll(() => page.evaluate((id) => window.desktop.tail(id, 40), second))
      .toEqual(expect.arrayContaining([expect.stringMatching(/QUIT_PID:\d+/)]));
    const secondPid = await page.evaluate(
      async (id) =>
        Number((await window.desktop.tail(id, 40)).join("\n").match(/QUIT_PID:(\d+)/)[1]),
      second,
    );
    const requestQuit = () =>
      app.evaluate(({ app, BrowserWindow }, method) => {
        const window = BrowserWindow.getAllWindows().find(
          (window) => window.webContents.getURL() === "app://bundle/index.html",
        );
        setTimeout(() => {
          if (method === "close" && process.platform !== "darwin") window.close();
          else if (method === "quit" || method === "close") app.quit();
          else {
            window.focus();
            window.webContents.sendInputEvent({
              type: "keyDown",
              keyCode: "Q",
              modifiers: process.platform === "darwin" ? ["meta"] : ["control", "shift"],
            });
          }
        }, 50);
      }, action);
    await requestQuit();
    const confirmation = await confirmationPage(app);
    await expect(confirmation.getByRole("alertdialog")).toHaveAccessibleName(
      "Quit with 2 terminals running?",
    );
    await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
    await confirmation.keyboard.press("Enter");
    await expect(confirmation.getByRole("alertdialog")).toHaveCount(0);
    for (const pid of [firstPid, secondPid]) process.kill(pid, 0);
    const alive =
      process.platform === "win32"
        ? 'Write-Output ("CANCEL_" + "ALIVE")'
        : "printf 'CANCEL_%s\\n' ALIVE";
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type(alive);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.quitOutput.includes("CANCEL_ALIVE"));
    await quitAndWait(app, async () => {
      await requestQuit();
      await confirmation.getByRole("button", { name: "Stop all and quit" }).click();
    });
    for (const pid of [firstPid, secondPid]) {
      await expect
        .poll(() => {
          try {
            process.kill(pid, 0);
            return false;
          } catch (error) {
            if (error.code === "ESRCH") return true;
            throw error;
          }
        })
        .toBe(true);
    }
  });
}

test("closing with an exited terminal quits without confirmation", {
  timeout: deadline(45_000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  await page.waitForFunction(
    () => !/Starting|Unable/.test(document.querySelector(".tile-status").textContent),
  );
  const background = await app.evaluate(({ BrowserWindow, nativeTheme }) => ({
    actual: BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .getBackgroundColor()
      .toUpperCase(),
    expected: nativeTheme.shouldUseDarkColors ? "#05040A" : "#F3F0FA",
  }));
  assert.equal(background.actual, background.expected);
  // A created PTY is not yet a ready PowerShell prompt on a cold Windows runner.
  if (process.platform === "win32")
    await expect.poll(() => page.locator(".xterm-rows").innerText()).toMatch(/PS [\s\S]*>/);
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("exit");
  await page.keyboard.press("Enter");
  await page.getByRole("status").filter({ hasText: "Shell exited" }).waitFor();
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = () => {
      throw new Error("Unexpected quit confirmation");
    };
  });
  await quitAndWait(app, () =>
    app.evaluate(({ app, BrowserWindow }) => {
      if (process.platform === "darwin") app.quit();
      else
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL() === "app://bundle/index.html")
          .close();
    }),
  );
});

test("trusted quit dialog isolates answers, passes axe in every theme and survives a board crash", {
  timeout: deadline(45000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const board = await boardPage(app);
  const dialog = await confirmationPage(app);
  const processes = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => window.webContents.getOSProcessId()),
  );
  assert.equal(new Set(processes).size, 2, "Confirmation must use a separate renderer process");
  for (const colorMode of [
    "eclipse-light",
    "eclipse-dark",
    "high-contrast",
    "deep-field",
    "moonlight",
    "graphite",
    "midnight-indigo",
  ]) {
    await board.evaluate(
      (interfaceTheme) => window.desktop.saveSetup({ interfaceTheme }),
      colorMode,
    );
    await app.evaluate(({ app }) => app.quit());
    await expect(dialog.getByRole("alertdialog")).toBeVisible();
    await expect(board.locator(".board-confirmation-scrim")).toBeVisible();
    const bounds = await app.evaluate(({ BrowserWindow }) => {
      const parent = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "app://bundle/index.html",
      );
      if (process.platform === "darwin") {
        if (!parent.isEnabled() || parent.isFocusable())
          throw Error("macOS board must block focus without attaching a disabling sheet");
      } else if (process.platform === "win32") {
        if (parent.isEnabled()) throw Error("Windows parent must be disabled during confirmation");
      } else if (!parent.isEnabled()) {
        throw Error("Linux parent must receive blocked input for dialog recovery");
      }
      const bounds = parent.getBounds();
      parent.setBounds({
        ...bounds,
        x: bounds.x + 10,
        y: bounds.y + 10,
        width: bounds.width - 20,
        height: bounds.height - 20,
      });
      return bounds;
    });
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => {
          const parent = BrowserWindow.getAllWindows().find(
            (window) => window.webContents.getURL() === "app://bundle/index.html",
          );
          const child = BrowserWindow.getAllWindows().find(
            (window) => window.webContents.getURL() === "app://confirmation/confirmation.html",
          );
          const p = parent.getContentBounds();
          const c = child.getBounds();
          return (
            c.x >= p.x &&
            c.y >= p.y &&
            c.x + c.width <= p.x + p.width &&
            c.y + c.height <= p.y + p.height &&
            Math.abs(c.x + c.width / 2 - p.x - p.width / 2) <= 1 &&
            Math.abs(c.y + c.height / 2 - p.y - p.height / 2) <= 1
          );
        }),
      )
      .toBe(true);
    const id = await dialog.evaluate(() => {
      let id;
      const off = window.confirmation.render((request) => {
        id = request?.id;
      });
      off();
      return id;
    });
    await app.evaluate(({ BrowserWindow, ipcMain }, id) => {
      const board = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "app://bundle/index.html",
      ).webContents;
      ipcMain.emit(
        "confirmation:answer",
        { sender: board, senderFrame: board.mainFrame },
        id,
        true,
      );
    }, id);
    await assertConfirmationFocus(app, dialog, dialog.getByRole("button", { name: "Cancel" }));
    assert.equal(await board.evaluate(() => "confirmation" in window), false);
    await mkdir("test-results", { recursive: true });
    await dialog.screenshot({
      path: evidencePath(`confirmation-${colorMode}.png`),
      animations: "disabled",
    });
    await board.screenshot({
      path: evidencePath(`confirmation-board-${colorMode}.png`),
      animations: "disabled",
    });
    captureConfirmationDesktop(`quit-${colorMode}`);
    await dialog.evaluate(() => {
      let request;
      const off = window.confirmation.render((value) => {
        request = value;
      });
      off();
      if (!request?.sessions) throw Error("Missing quit inventory");
      const sessions = request.sessions.map((item) => ({ ...item, location: "x".repeat(60) }));
      // Main-authored fixtures travel through the real preload, retaining the original request ID.
      window.dialogLayoutRequest = {
        ...request,
        sessions,
        worktrees: [{ branch: "x".repeat(60), reason: "resumable conversation" }],
      };
    });
    const layoutRequest = await dialog.evaluate(() => window.dialogLayoutRequest);
    await app.evaluate(({ BrowserWindow }, request) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "app://confirmation/confirmation.html")
        .webContents.send("confirmation:render", request);
    }, layoutRequest);
    await expect(dialog.locator(".sub").first()).toHaveText("x".repeat(60));
    assert.equal(
      await dialog.locator(".why").evaluateAll((labels) =>
        labels.every((label) => {
          const style = getComputedStyle(label);
          return (
            style.whiteSpace === "nowrap" &&
            label.scrollWidth <= label.clientWidth &&
            label.getBoundingClientRect().height <= 19
          );
        }),
      ),
      true,
      "State labels remain on one line beside long locations",
    );
    const scan = await new AxeBuilder({ page: dialog }).setLegacyMode().analyze();
    assert.deepEqual(scan.violations, []);
    await dialog.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Stop all and quit" })).toBeFocused();
    await dialog.keyboard.press("Tab");
    await assertConfirmationFocus(app, dialog, dialog.getByRole("button", { name: "Cancel" }));
    await dialog.keyboard.press("Escape");
    await expect(dialog.getByRole("alertdialog")).toHaveCount(0);
    await expect(board.locator(".board-confirmation-scrim")).toHaveCount(0);
    await app.evaluate(({ BrowserWindow }, bounds) => {
      const parent = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "app://bundle/index.html",
      );
      if (!parent.isEnabled()) throw Error("Parent must be enabled after cancellation");
      parent.setBounds(bounds);
    }, bounds);
  }
  const boardPid = await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    ).webContents;
    globalThis.boardCrash = null;
    contents.once("render-process-gone", (_event, details) => {
      globalThis.boardCrash = { reason: details.reason, crashed: contents.isCrashed() };
    });
    return contents.getOSProcessId();
  });
  assert.ok(Number.isInteger(boardPid) && boardPid > 0, "Board renderer PID must be valid");
  // Terminate only this test app's board renderer, then wait for main to observe the loss.
  process.kill(boardPid);
  await expect
    .poll(() => app.evaluate(() => globalThis.boardCrash))
    .toMatchObject({ crashed: true });
  await quitAndWait(app, async () => {
    await app.evaluate(({ app }) => app.quit());
    await expect(dialog.getByRole("alertdialog")).toHaveAccessibleName(
      "Quit with 1 terminal running?",
    );
    await dialog.getByRole("button", { name: "Stop all and quit" }).click();
  });
});

test("trusted card follows interface scale and clears its scrim on every dismissal", {
  timeout: deadline(45000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const board = await boardPage(app);
  let dialog = await confirmationPage(app);
  const expectDialogFits = async (zoom) => {
    await dialog.evaluate(() => document.fonts.ready.then(() => {}));
    await expect
      .poll(async () => {
        const layout = await dialog.evaluate(() => {
          const card = document.querySelector(".confirmation-window");
          const content = document.querySelector(".confirmation-content");
          return {
            height: card.getBoundingClientRect().height,
            overflow: content.scrollHeight - content.clientHeight,
          };
        });
        const height = await app.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()
              .find((w) => w.webContents.getURL() === "app://confirmation/confirmation.html")
              .getBounds().height,
        );
        return {
          heightFits: Math.abs(height - Math.ceil(layout.height * zoom)) <= 2,
          overflow: layout.overflow,
        };
      })
      .toEqual({ heightFits: true, overflow: 0 });
  };
  for (const interfaceScale of [125, 80]) {
    await board.evaluate(
      (interfaceScale) =>
        window.desktop.saveSetup({ interfaceScale: interfaceScale === 125 ? 120 : interfaceScale }),
      interfaceScale,
    );
    await board.evaluate(() => {
      const modal = document.createElement("dialog");
      modal.id = "scrim-test-modal";
      modal.textContent = "An existing board dialog";
      document.body.append(modal);
      modal.showModal();
    });
    // Settings currently offers 10% steps; exercise the requested fractional zoom in main.
    if (interfaceScale === 125)
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
          .find((w) => w.webContents.getURL() === "app://bundle/index.html")
          .webContents.setZoomFactor(1.25);
      });
    await app.evaluate(({ app }) => app.quit());
    await expect(dialog.getByRole("alertdialog")).toBeVisible();
    await expect(board.locator(".board-confirmation-scrim")).toBeVisible();
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => {
          const parent = BrowserWindow.getAllWindows().find(
            (w) => w.webContents.getURL() === "app://bundle/index.html",
          );
          const child = BrowserWindow.getAllWindows().find(
            (w) => w.webContents.getURL() === "app://confirmation/confirmation.html",
          );
          return {
            zoom: child.webContents.getZoomFactor(),
            boardZoom: parent.webContents.getZoomFactor(),
            width: child.getBounds().width,
          };
        }),
      )
      .toEqual({
        zoom: interfaceScale / 100,
        boardZoom: interfaceScale / 100,
        width: (540 * interfaceScale) / 100,
      });
    await expect(board.locator(".board-confirmation-scrim:popover-open")).toHaveCount(1);
    // Native width can settle before font layout and resize IPC finish. Check
    // the rendered content at each scale instead of retaining a transient height.
    await expectDialogFits(interfaceScale / 100);
    // A settings change while open must update the existing trusted renderer, too.
    await board.evaluate(() =>
      window.desktop.saveSetup({ interfaceScale: 100, interfaceTheme: "eclipse-dark" }),
    );
    await expect
      .poll(() =>
        dialog.evaluate(() => ({
          width: innerWidth,
          theme: document.documentElement.style.colorScheme,
        })),
      )
      .toEqual({ width: 540, theme: "dark" });
    await expectDialogFits(1);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(board.locator(".board-confirmation-scrim")).toHaveCount(0);
    await board.evaluate(() => document.getElementById("scrim-test-modal").remove());
  }
  // Exercise the same main-only API used by aborted control requests without granting the board access.
  const mainModule = path.resolve("build/main/confirmations/trusted-dialog.js");
  await app.evaluate(({ BrowserWindow, session }, mainModule) => {
    const load = process.getBuiltinModule("node:module").createRequire(mainModule);
    const { TrustedDialog } = load(mainModule);
    const { resolveInterfaceTheme } = load("../../shared/interface-themes.js");
    const parent = BrowserWindow.getAllWindows().find(
      (w) => w.webContents.getURL() === "app://bundle/index.html",
    );
    globalThis.testConfirmation = new TrustedDialog(
      parent,
      session.fromPartition("confirmation"),
      () => resolveInterfaceTheme("follow", false),
    );
    globalThis.dialogReuseTrace = [];
    const native = globalThis.testConfirmation.window;
    const record = (kind, value) => {
      globalThis.dialogReuseTrace.push({
        kind,
        value,
        time: Date.now(),
        request: globalThis.testConfirmation.pending?.id,
      });
      if (globalThis.dialogReuseTrace.length > 64) globalThis.dialogReuseTrace.shift();
    };
    for (const method of ["isVisible", "isFocused"]) {
      const original = native[method].bind(native);
      native[method] = () => {
        const value = original();
        record(method, value);
        return value;
      };
    }
    for (const event of ["show", "hide", "focus", "blur", "minimize"])
      native.prependListener(event, () => record(event));
    globalThis.testAbort = new AbortController();
    globalThis.testAnswer = undefined;
    void globalThis.testConfirmation
      .request({ title: "Abort test", accept: "Accept" }, globalThis.testAbort.signal)
      .then((answer) => {
        globalThis.testAnswer = answer;
      });
  }, mainModule);
  try {
    await expect
      .poll(async () => {
        const windows = app.windows();
        for (const page of windows)
          if (await page.getByRole("alertdialog", { name: "Abort test" }).count()) return true;
        return false;
      })
      .toBe(true);
    await expect(board.locator(".board-confirmation-scrim")).toBeVisible();
    await app.evaluate(() => globalThis.testAbort.abort());
    await expect(board.locator(".board-confirmation-scrim")).toHaveCount(0);
    await expect.poll(() => app.evaluate(() => globalThis.testAnswer)).toBe(false);
    // A mixed batch keeps Decline as Enter's default; per-item abort leaves its peers open.
    const queueBatch = () =>
      app.evaluate(() => {
        globalThis.batchAnswers = {};
        globalThis.batchAbort = new AbortController();
        for (const id of ["clean", "dirty", "abort"]) {
          void globalThis.testConfirmation
            .request(
              {
                title: "Remove worktrees?",
                accept: "Approve all",
                removal: {
                  group: "batch-test",
                  item: {
                    id,
                    branch: id,
                    path: `/trees/${id}`,
                    changes: id === "dirty" ? "?? keep.txt\0" : "",
                  },
                },
              },
              id === "abort" ? globalThis.batchAbort.signal : undefined,
            )
            .then((answer) => {
              globalThis.batchAnswers[id] = answer;
            });
        }
      });
    await queueBatch();
    let batchPage;
    await expect
      .poll(async () => {
        for (const candidate of app.windows()) {
          if (await candidate.getByRole("alertdialog", { name: "Remove worktrees?" }).count()) {
            batchPage = candidate;
            return true;
          }
        }
        return false;
      })
      .toBe(true);
    await expect(batchPage.getByRole("checkbox")).toHaveCount(3);
    await assertConfirmationFocus(
      app,
      batchPage,
      batchPage.getByRole("button", { name: "Decline" }),
    );
    await batchPage.keyboard.press("Enter");
    await expect
      .poll(() => app.evaluate(() => globalThis.batchAnswers))
      .toEqual({
        clean: false,
        dirty: false,
        abort: false,
      });
    await queueBatch();
    await expect(batchPage.getByRole("checkbox")).toHaveCount(3);
    try {
      await batchPage.getByRole("checkbox", { name: "dirty", exact: true }).check();
    } catch (error) {
      console.error(
        "Trusted dialog reuse diagnostics:",
        await app.evaluate(() => ({
          trace: globalThis.dialogReuseTrace,
          answers: globalThis.batchAnswers,
          pending: Boolean(globalThis.testConfirmation.pending),
        })),
      );
      throw error;
    }
    await expect(
      batchPage.getByRole("button", { name: "Discard changes and remove selected" }),
    ).toBeVisible();
    await app.evaluate(() => globalThis.batchAbort.abort());
    await expect(batchPage.getByRole("checkbox")).toHaveCount(2);
    await expect.poll(() => app.evaluate(() => globalThis.batchAnswers)).toEqual({ abort: false });
    await expect(batchPage.getByRole("checkbox", { name: "dirty", exact: true })).not.toBeChecked();
    await assertConfirmationFocus(
      app,
      batchPage,
      batchPage.getByRole("button", { name: "Decline" }),
    );
    await batchPage.getByRole("checkbox", { name: "dirty", exact: true }).check();
    await batchPage.getByRole("button", { name: "Discard changes and remove selected" }).click();
    await expect
      .poll(() => app.evaluate(() => globalThis.batchAnswers))
      .toEqual({
        abort: false,
        clean: false,
        dirty: true,
      });
    await queueBatch();
    await expect(batchPage.getByRole("checkbox")).toHaveCount(3);
    await batchPage.getByRole("button", { name: "Discard changes and remove all" }).click();
    await expect
      .poll(() => app.evaluate(() => globalThis.batchAnswers))
      .toEqual({
        clean: true,
        dirty: true,
        abort: true,
      });
    await app.evaluate(() => {
      globalThis.testAnswer = undefined;
      void globalThis.testConfirmation
        .request({
          title: "Accept test",
          accept: "Accept",
          changes: "?? changed.txt\0".repeat(80),
          sessions: [
            { id: "needs", name: "Needs attention", location: "repo", state: "needs_input" },
            { id: "failed", name: "Failed session", location: "repo", state: "failed" },
          ],
        })
        .then((answer) => {
          globalThis.testAnswer = answer;
        });
    });
    let acceptPage;
    await expect
      .poll(async () => {
        for (const page of app.windows())
          if (await page.getByRole("alertdialog", { name: "Accept test" }).count()) {
            acceptPage = page;
            return true;
          }
        return false;
      })
      .toBe(true);
    await expect(board.locator(".board-confirmation-scrim")).toBeVisible();
    await expect
      .poll(() =>
        acceptPage
          .locator(".confirmation-content")
          .evaluate((element) => element.scrollHeight > element.clientHeight),
      )
      .toBe(true);
    const longScan = await new AxeBuilder({ page: acceptPage }).setLegacyMode().analyze();
    assert.deepEqual(longScan.violations, []);
    await assertConfirmationFocus(
      app,
      acceptPage,
      acceptPage.getByRole("button", { name: "Cancel" }),
    );
    await acceptPage.keyboard.press("Tab");
    await acceptPage.keyboard.press("Tab");
    await assertConfirmationFocus(
      app,
      acceptPage,
      acceptPage.getByRole("region", { name: "Details" }),
    );
    const cues = await acceptPage.evaluate(() => ({
      failed: getComputedStyle(document.querySelector('[data-state="failed"]')).borderRadius,
      attention: getComputedStyle(document.querySelector('[data-state="needs_input"]')).boxShadow,
    }));
    assert.equal(cues.failed, "0px");
    assert.notEqual(cues.attention, "none");
    await acceptPage.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(board.locator(".board-confirmation-scrim")).toHaveCount(0);
    await expect.poll(() => app.evaluate(() => globalThis.testAnswer)).toBe(true);
  } finally {
    await app.evaluate(() => globalThis.testConfirmation.dispose());
  }
  await app.evaluate(({ app }) => app.quit());
  await expect(dialog.getByRole("alertdialog")).toBeVisible();
  const dialogPid = await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows().find(
      (w) => w.webContents.getURL() === "app://confirmation/confirmation.html",
    ).webContents;
    globalThis.confirmationCrash = null;
    contents.once("render-process-gone", (_event, details) => {
      globalThis.confirmationCrash = details.reason;
    });
    return contents.getOSProcessId();
  });
  assert.ok(Number.isInteger(dialogPid) && dialogPid > 0, "Trusted renderer PID must be valid");
  // Unlike a renderer-directed crash request, this also kills an unresponsive renderer.
  // Target only this fixture's trusted process and wait for main to observe its loss.
  process.kill(dialogPid, "SIGKILL");
  await expect
    .poll(() => app.evaluate(() => globalThis.confirmationCrash))
    .toMatch(/^(crashed|killed)$/);
  await expect(board.locator(".board-confirmation-scrim")).toHaveCount(0);
  await app.evaluate(({ app }) => app.quit());
  dialog = await confirmationPage(app);
  await expect(dialog.getByRole("alertdialog")).toBeVisible();
  await quitAndWait(app, async () => {
    await dialog.getByRole("button", { name: "Stop all and quit" }).click();
  });
});

test("config file agent arguments require trusted Allow before a fake Codex launch", {
  timeout: deadline(60_000),
}, async (context) => {
  const { chmod, copyFile, readdir } = require("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "foom-config-arguments-"));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  const output = path.join(root, "argv.json");
  await Promise.all([bin, home, repo].map((directory) => mkdir(directory)));
  for (const agent of ["claude", "codex", "agy"]) {
    const executable = path.join(bin, process.platform === "win32" ? `${agent}.exe` : agent);
    await copyFile(process.execPath, executable);
    await chmod(executable, 0o755);
  }
  isolatedGit(["init", "-q", "-b", "main"], { cwd: repo });
  isolatedGit(
    [
      "-c",
      "user.name=Foom",
      "-c",
      "user.email=foom@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ],
    { cwd: repo },
  );
  const app = await launchApp(context, {
    fixture: "agent",
    env: { HOME: home, PATH: bin, TEST_ARGV: output },
  });
  const page = await boardPage(app);
  await app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
  }, repo);
  const repository = await page.evaluate(() => window.desktop.addRepository());
  assert.ok(repository);
  await openSettingsScreen(page);
  const sections = page.getByRole("navigation", { name: "Settings sections" });
  await sections.getByRole("button", { name: "Foom config", exact: true }).click();
  const file = path.join(home, ".foom/config/settings.json");
  const original = await readFile(file, "utf8");
  const args = [
    "--eval",
    'require("node:fs").writeFileSync(process.env.TEST_ARGV, JSON.stringify([...process.execArgv, ...process.argv.slice(1)]));process.stdin.resume()',
    "fixture",
    "--ask-for-approval",
    "never",
  ];
  const proposal = JSON.stringify({
    ...JSON.parse(original),
    agentArguments: { claude: [], codex: args, agy: [] },
  });
  const banner = page.getByRole("region", { name: "Change waiting for approval" });
  await writeFile(file, proposal);
  await expect(banner).toContainText("change Codex launch arguments");
  assert.deepEqual(
    (await page.evaluate(() => window.desktop.setupState())).settings.agentArguments.codex,
    [],
  );
  await banner.getByRole("button", { name: "Keep it on" }).click();
  await expect(banner).toHaveCount(0);
  assert.equal(await readFile(file, "utf8"), original);
  await writeFile(file, proposal);
  await expect(banner).toBeVisible();
  await banner.getByRole("button", { name: "Allow", exact: true }).click();
  const disclosure = await confirmationPage(app);
  await expect(disclosure.getByRole("alertdialog")).toHaveAccessibleName(
    "Allow agent launch arguments?",
  );
  await expect(disclosure.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(disclosure.getByRole("alertdialog")).toContainText("Codex before");
  await expect(disclosure.getByRole("alertdialog")).toContainText("Codex after");
  assert.deepEqual(
    await disclosure.locator(".argument-lines").last().locator("code").allTextContents(),
    args,
  );
  await disclosure.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(banner).toHaveCount(0);
  assert.deepEqual(
    (await page.evaluate(() => window.desktop.setupState())).settings.agentArguments.codex,
    args,
  );
  await page.keyboard.press("Escape");
  await page.evaluate(
    (repo) =>
      window.desktop.sidebarCommand({
        kind: "launch",
        repository: repo,
        worktree: repo,
        run: "codex",
      }),
    repository.path,
  );
  await expect
    .poll(async () => {
      try {
        return JSON.parse(await readFile(output, "utf8"));
      } catch {
        return null;
      }
    })
    .toEqual(args);
  // Existing sessions retain their arguments; a removal is held too.
  await openSettingsScreen(page);
  await sections.getByRole("button", { name: "Foom config", exact: true }).click();
  const approved = await readFile(file, "utf8");
  await writeFile(file, original);
  await expect(banner).toContainText("change Codex launch arguments");
  await banner.getByRole("button", { name: "Keep it on" }).click();
  await expect(banner).toHaveCount(0);
  assert.equal(await readFile(file, "utf8"), approved);
  const bypass = "--dangerously-bypass-approvals-and-sandbox";
  await writeFile(
    file,
    JSON.stringify({
      ...JSON.parse(approved),
      agentArguments: { claude: [], codex: [...args, bypass], agy: [] },
    }),
  );
  await expect(banner).toBeVisible();
  await banner.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(disclosure.getByRole("alertdialog")).toHaveAccessibleName(
    "Allow agent launch arguments?",
  );
  await expect(disclosure.getByRole("alertdialog")).toContainText("Codex bypass");
  await expect(disclosure.locator(".argument-lines").last()).toHaveText(bypass);
  await assertAccessible(disclosure);
  await disclosure.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(banner).toHaveCount(0);
  assert.equal(
    (await page.evaluate(() => window.desktop.setupState())).settings.agentBypassAcknowledged.codex,
    true,
  );
  // Saving defaults from the card retains the prior main-owned bypass acknowledgement.
  await sections.getByRole("button", { name: "Agents", exact: true }).click();
  const input = page.getByLabel("Codex default arguments");
  await expect(input).toBeVisible();
  await input.fill([...args, bypass, "--model", "fixture"].join("\n"));
  await input.blur();
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.desktop.setupState())).settings.agentArguments.codex,
    )
    .toEqual([...args, bypass, "--model", "fixture"]);
  await expect(disclosure.getByRole("alertdialog")).toHaveCount(0);
  for (const name of [".claude", ".codex", ".gemini"])
    assert.ok(!(await readdir(home)).includes(name));
});

test("trusted confirmations keep their first shown bounds while the parent is static", {
  timeout: deadline(45_000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  await boardPage(app);
  await app.evaluate(({ BrowserWindow, ipcMain }, mainModule) => {
    const load = process.getBuiltinModule("node:module").createRequire(mainModule);
    const { TrustedDialog } = load(mainModule);
    const request = TrustedDialog.prototype.request;
    TrustedDialog.prototype.request = function (...args) {
      globalThis.placementDialog = this;
      return request.apply(this, args);
    };
    globalThis.placementTrace = [];
    const child = BrowserWindow.getAllWindows().find(
      (w) => w.webContents.getURL() === "app://confirmation/confirmation.html",
    );
    const parent = child.getParentWindow();
    const record = (kind, size) =>
      globalThis.placementTrace.push({
        kind,
        size,
        time: Date.now(),
        bounds: child.getBounds(),
        parent: parent.getContentBounds(),
        visible: child.isVisible(),
      });
    globalThis.recordPlacement = record;
    record("initial");
    ipcMain.prependListener("confirmation:size", (event, size) => {
      if (event.sender === child.webContents) record("size", size);
    });
    const setBounds = child.setBounds.bind(child);
    child.setBounds = (...args) => {
      setBounds(...args);
      record("setBounds");
    };
    for (const event of ["show", "resize", "move", "focus"]) child.on(event, () => record(event));
  }, path.resolve("build/main/confirmations/trusted-dialog.js"));
  const traces = [];
  for (const kind of ["quit", "disclosure"]) {
    if (kind !== "quit")
      await app.evaluate(() => {
        globalThis.placementTrace.length = 0;
      });
    if (kind === "quit") await app.evaluate(({ app }) => app.quit());
    else
      await app.evaluate(() => {
        void globalThis.placementDialog.request({
          title: "Allow access?",
          accept: "Allow",
          glyph: "shield",
          detail:
            "Review this permission disclosure before allowing access to the selected repository. ".repeat(
              4,
            ),
        });
      });
    const dialog = await confirmationPage(app);
    await expect(dialog.getByRole("alertdialog")).toBeVisible();
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find(
              (window) => window.webContents.getURL() === "app://confirmation/confirmation.html",
            )
            .isVisible(),
        ),
      )
      .toBe(true);
    // Elapsed time is the behavior under test: include the one-second recovery check.
    await new Promise((resolve) => setTimeout(resolve, 2100));
    traces.push({
      kind,
      events: await app.evaluate(() => {
        globalThis.recordPlacement("after-recovery");
        return globalThis.placementTrace;
      }),
    });
    await dialog.getByRole("button", { name: "Cancel" }).click();
  }
  await mkdir("test-results", { recursive: true });
  await writeFile("test-results/confirmation-placement.json", JSON.stringify(traces, null, 2));
  for (const { events } of traces) {
    const first = events.findIndex((event) => event.kind === "show");
    assert.ok(first >= 0, "Must observe first native show");
    for (const event of events.slice(first)) {
      assert.deepEqual(event.parent, events[first].parent, "Parent must remain static");
      assert.deepEqual(event.bounds, events[first].bounds);
    }
  }
});

// Use the production main-only dialog API with a harmless action so approval
// leaves the shell alive. No renderer capability is added for these fixtures.
async function focusRestoreDialog(app) {
  const mainModule = path.resolve("build/main/confirmations/trusted-dialog.js");
  await app.evaluate(({ BrowserWindow, session }, mainModule) => {
    const load = process.getBuiltinModule("node:module").createRequire(mainModule);
    const { TrustedDialog } = load(mainModule);
    const { resolveInterfaceTheme } = load("../../shared/interface-themes.js");
    const parent = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
    globalThis.focusRestoreDialog = new TrustedDialog(
      parent,
      session.fromPartition("confirmation"),
      () => resolveInterfaceTheme("follow", false),
    );
  }, mainModule);
}
async function escapeFocusedConfirmation(app) {
  // CDP keyboard.press sends key-up to its original page even after key-down
  // dismisses it. Follow native focus, as the terminal typing assertions do.
  await app.evaluate(({ webContents }) => {
    const contents = webContents.getFocusedWebContents();
    if (!contents || contents.getURL() !== "app://confirmation/confirmation.html")
      throw Error("The trusted confirmation must own native keyboard focus");
    contents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    contents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  });
}
async function requestFocusRestore(app) {
  await app.evaluate(() => {
    globalThis.focusRestoreAbort = new AbortController();
    globalThis.focusRestoreAnswer = undefined;
    void globalThis.focusRestoreDialog
      .request(
        { title: "Focus restoration", accept: "Approve" },
        globalThis.focusRestoreAbort.signal,
      )
      .then((answer) => {
        globalThis.focusRestoreAnswer = answer;
      });
  });
  let page;
  await expect
    .poll(async () => {
      for (const candidate of app.windows()) {
        if (await candidate.getByRole("alertdialog", { name: "Focus restoration" }).count()) {
          page = candidate;
          return true;
        }
      }
      return false;
    })
    .toBe(true);
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
  await assertConfirmationFocus(
    app,
    page,
    page.getByRole("button", { name: "Cancel", exact: true }),
  );
  return page;
}

test("modal dismissal restores the same terminal input for cancel, approve, Escape, abort and Settings", async (context) => {
  const { typeIntoFocusedContents } = require("./preview-fixture.js");
  const app = await launchApp(context, { fixture: "running-shell" });
  const board = await boardPage(app);
  const id = await board.evaluate(async () => (await window.desktop.workspace()).terminals[0].id);
  await board.locator(".xterm-helper-textarea").focus();
  await focusRestoreDialog(app);
  try {
    for (const action of ["Cancel", "Approve", "Escape", "abort"]) {
      const dialog = await requestFocusRestore(app);
      if (action === "abort") await app.evaluate(() => globalThis.focusRestoreAbort.abort());
      else if (action === "Escape") await escapeFocusedConfirmation(app);
      else await dialog.getByRole("button", { name: action, exact: true }).click();
      await expect(board.locator(".board-confirmation-scrim")).toHaveCount(0);
      await expect
        .poll(() => app.evaluate(() => globalThis.focusRestoreAnswer))
        .toBe(action === "Approve");
      await expect(board.locator(".xterm-helper-textarea")).toBeFocused();
      await expect
        .poll(() =>
          app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL()),
        )
        .toBe("app://bundle/index.html");
      const text = `focus${action.toLowerCase()}`;
      await typeIntoFocusedContents(app, text);
      await expect
        .poll(async () => (await board.evaluate((id) => window.desktop.tail(id, 30), id)).join(""))
        .toContain(text);
    }
    await board.evaluate(() => window.desktop.appMenu.execute("about"));
    await expect(board.getByRole("dialog", { name: "About Foom" })).toBeVisible();
    await board.keyboard.press("Escape");
    await expect(board.getByRole("dialog", { name: "About Foom" })).toHaveCount(0);
    await expect(board.locator(".xterm-helper-textarea")).toBeFocused();
    await typeIntoFocusedContents(app, "aboutrestored");
    await expect
      .poll(async () => (await board.evaluate((id) => window.desktop.tail(id, 30), id)).join(""))
      .toContain("aboutrestored");
    await board.evaluate(() => window.desktop.appMenu.execute("settings"));
    await expect(board.getByRole("heading", { name: "General", exact: true })).toBeFocused();
    await board.keyboard.press("Escape");
    await expect(board.getByRole("region", { name: "Settings" })).toHaveCount(0);
    await expect(board.locator(".xterm-helper-textarea")).toBeFocused();
    await typeIntoFocusedContents(app, "settingsrestored");
    await expect
      .poll(async () => (await board.evaluate((id) => window.desktop.tail(id, 30), id)).join(""))
      .toContain("settingsrestored");
    await board.evaluate(() => {
      window.closedFocusTrace = [];
      const record = (kind, target = document.activeElement) => {
        window.closedFocusTrace.push({
          kind,
          time: performance.now(),
          tag: target instanceof Element ? target.tagName : null,
          className: target instanceof Element ? target.getAttribute("class") : null,
          active: document.activeElement?.tagName,
          focused: document.hasFocus(),
          scrim: Boolean(document.querySelector(".board-confirmation-scrim")),
        });
        if (window.closedFocusTrace.length > 32) window.closedFocusTrace.shift();
      };
      const entered = (event) => record("focusin", event.target);
      const left = (event) => record("focusout", event.target);
      document.addEventListener("focusin", entered);
      document.addEventListener("focusout", left);
      const focus = HTMLElement.prototype.focus;
      HTMLElement.prototype.focus = function (...args) {
        record("focus-attempt", this);
        return focus.apply(this, args);
      };
      const off = window.desktop.confirmations.onScrim((visible) => record(`scrim:${visible}`));
      window.stopClosedFocusTrace = () => {
        off();
        document.removeEventListener("focusin", entered);
        document.removeEventListener("focusout", left);
        HTMLElement.prototype.focus = focus;
      };
    });
    await requestFocusRestore(app);
    await board.evaluate((id) => window.desktop.kill(id), id);
    await expect
      .poll(() =>
        board.evaluate(
          async (id) =>
            (await window.desktop.workspace()).terminals.some((terminal) => terminal.id === id),
          id,
        ),
      )
      .toBe(false);
    await expect(board.locator(".xterm-helper-textarea")).toBeHidden();
    // With no remaining sessions the compact rail has no row or visible wordmark.
    await board.evaluate(() => window.desktop.appMenu.execute("toggle-sidebar"));
    await expect(board.locator(".sidebar-shell")).toHaveAttribute("data-compact", "true");
    await escapeFocusedConfirmation(app);
    await expect(board.locator(".board-confirmation-scrim")).toHaveCount(0);
    try {
      await expect(board.getByRole("navigation", { name: "Terminal sidebar" })).toBeFocused();
    } catch (error) {
      console.error(
        "Closed-terminal focus diagnostics",
        JSON.stringify({
          document: await board.evaluate(() => ({
            focused: document.hasFocus(),
            tag: document.activeElement?.tagName,
            className: document.activeElement?.className,
            role: document.activeElement?.getAttribute("role"),
            trace: window.closedFocusTrace,
            sidebar: Array.from(document.querySelectorAll(".board-list"), (element) => ({
              connected: element.isConnected,
              inert: Boolean(element.closest("[inert]")),
              hidden: Boolean(element.closest("[hidden]")),
              display: getComputedStyle(element).display,
              visibility: getComputedStyle(element).visibility,
              width: element.getBoundingClientRect().width,
              height: element.getBoundingClientRect().height,
            })),
          })),
          windows: await app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().map((window) => ({
              url: window.webContents.getURL(),
              focused: window.isFocused(),
              contentsFocused: window.webContents.isFocused(),
              enabled: window.isEnabled(),
              visible: window.isVisible(),
            })),
          ),
        }),
      );
      throw error;
    }
  } finally {
    await board.evaluate(() => window.stopClosedFocusTrace?.());
    await app.evaluate(() => globalThis.focusRestoreDialog.dispose());
  }
});

test("inactive agent confirmation dismissal preserves the other application's native focus", async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const board = await boardPage(app);
  // Start both processes before raising consent: the existing reachability
  // guard must not compete with the second launch's native-readiness gate.
  const other = await launchApp(context, { fixture: "empty-board" });
  await app.evaluate(({ app, BrowserWindow }) => {
    if (process.platform === "darwin") app.focus({ steal: true });
    const board = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
    board.focus();
    board.webContents.focus();
  });
  await focusRestoreDialog(app);
  try {
    await requestFocusRestore(app);
    // Another isolated application process is the native first responder.
    await other.evaluate(({ app, BrowserWindow }) => {
      if (process.platform === "darwin") app.focus({ steal: true });
      const board = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "app://bundle/index.html",
      );
      board.focus();
      board.webContents.focus();
    });
    await expect
      .poll(() => app.evaluate(() => globalThis.focusRestoreDialog.window.isFocused()))
      .toBe(false);
    await app.evaluate(() => globalThis.focusRestoreAbort.abort());
    await expect.poll(() => app.evaluate(() => globalThis.focusRestoreAnswer)).toBe(false);
    await expect(board.locator(".board-confirmation-scrim")).toHaveCount(0);
    await board.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    assert.equal(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isFocused()),
      ),
      false,
    );
    assert.equal(
      await other.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isFocused()),
      ),
      true,
    );
  } finally {
    await app.evaluate(() => globalThis.focusRestoreDialog.dispose());
  }
});
