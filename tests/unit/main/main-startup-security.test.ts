import { mock, start } from "./main-fixture";
import { join } from "node:path";

import { expect, test, vi } from "vitest";

test("loads worktree state from userData before creating a window", async () => {
  let finish: (() => void) | undefined;
  mock.openWorktrees.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => {
          resolve({});
        };
      }),
  );
  await start(false);
  expect(mock.openWorktrees).toHaveBeenCalledWith(
    "/test/user-data",
    undefined,
    [join("/test/user-data", ".foom", "config")],
    expect.any(Function),
  );
  expect(mock.construct).not.toHaveBeenCalled();
  finish?.();
  await vi.waitFor(() => {
    expect(mock.construct).toHaveBeenCalledOnce();
  });
});

test("reports persistence startup failures", async () => {
  const error = new Error("Cannot write state");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  mock.openWorktrees.mockRejectedValueOnce(error);
  await start();
  await vi.waitFor(() => {
    expect(mock.quit).toHaveBeenCalledOnce();
  });
  expect(mock.construct).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith("Unable to start the application:", error);
});

test("creates a sandboxed window, loads our document, and only shows it when ready", async () => {
  let loaded: (() => void) | undefined;
  mock.window.loadURL.mockReturnValueOnce(
    new Promise((resolve) => {
      loaded = resolve;
    }),
  );
  await start();
  const options = mock.construct.mock.calls[0]?.[0];
  expect(options?.show).toBe(false);
  expect(options?.webPreferences).toMatchObject({
    backgroundThrottling: false,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webviewTag: false,
  });
  expect(mock.window.loadURL).toHaveBeenCalledWith("app://bundle/index.html");
  expect(mock.window.show).not.toHaveBeenCalled();
  expect(mock.window.webContents.setWindowOpenHandler.mock.calls[0]?.[0]()).toEqual({
    action: "deny",
  });
  mock.readyEvents.get("ready-to-show")?.();
  expect(mock.window.show).toHaveBeenCalledOnce();
  loaded?.();
  await Promise.resolve();
  expect(mock.window.show).toHaveBeenCalledOnce();
  for (const name of ["will-navigate", "will-attach-webview"]) {
    const event = { preventDefault: vi.fn() };
    mock.windowEvents.get(name)?.(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  }
});

test("serves allowlisted local assets and rejects other hosts, paths, and methods", async () => {
  await start();
  const handler = mock.protocolHandle.mock.calls[0]?.[1];
  if (!handler) throw new Error("Missing protocol handler");
  for (const asset of [
    "index.html",
    "styles.css",
    "renderer.js",
    "renderer.css",
    "tokens.css",
    "fonts/archivo-black.ttf",
    "fonts/courier-prime.ttf",
    "fonts/geist.ttf",
    "fonts/geist-mono.ttf",
    "fonts/HackNerdFontMono-Regular.woff2",
    "fonts/HackNerdFontMono-Bold.woff2",
  ]) {
    expect((await handler(new Request(`app://bundle/${asset}`))).status).toBe(200);
    expect(mock.fetch).toHaveBeenLastCalledWith(
      expect.stringMatching(new RegExp(`/renderer/${asset.replace(".", "\\.")}$$`)),
    );
  }
  for (const url of [
    "app://other/index.html",
    "app://bundle/main.js",
    "app://bundle/fonts/unknown.ttf",
    "app://bundle/fonts/geist-OFL.txt",
    "app://bundle/../preload.js",
  ]) {
    expect((await handler(new Request(url))).status).toBe(404);
  }
  expect((await handler(new Request("app://bundle/index.html", { method: "POST" }))).status).toBe(
    404,
  );
  expect(mock.fetch).toHaveBeenCalledTimes(11);
});

test("denies requested and checked permissions", async () => {
  await start();
  const callback = vi.fn();
  mock.permissionRequest.mock.calls[0]?.[0](null, "media", callback);
  expect(callback).toHaveBeenCalledWith(false);
  expect(mock.permissionCheck.mock.calls[0]?.[0]()).toBe(false);
});

test("registers activation to reopen a window", async () => {
  await start();
  expect(mock.appEvents.has("activate")).toBe(true);
});

test.each(["darwin", "linux", "win32"] as const)(
  "last-window policy follows %s",
  async (platform) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    await start();
    mock.appEvents.get("window-all-closed")?.({ preventDefault: vi.fn() });
    expect(mock.quit).toHaveBeenCalledTimes(platform === "darwin" ? 0 : 1);
  },
);

test("quits with a diagnostic if the document cannot load", async () => {
  const error = new Error("Load failed");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  mock.window.loadURL.mockRejectedValue(error);
  await start();
  await vi.waitFor(() => {
    expect(log).toHaveBeenCalledWith("Unable to load the application:", error);
    expect(mock.quit).toHaveBeenCalledOnce();
  });
});

test("quits with a diagnostic if startup fails", async () => {
  const error = new Error("Startup failed");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  mock.ready.mockRejectedValue(error);
  await start();
  expect(log).toHaveBeenCalledWith("Unable to start the application:", error);
  expect(mock.quit).toHaveBeenCalledOnce();
});

test("reveals a loaded board even without a hidden-window paint and does not show it twice", async () => {
  await start();
  await vi.waitFor(() => {
    expect(mock.window.show).toHaveBeenCalledOnce();
  });
  mock.readyEvents.get("ready-to-show")?.();
  expect(mock.window.show).toHaveBeenCalledOnce();
});

test("selects dev userData before locking and before readiness", async () => {
  await start();
  expect(mock.setPath).toHaveBeenCalledWith("userData", join("/test/user-data", "Foom Dev"));
  expect(mock.setPath.mock.invocationCallOrder[0]).toBeLessThan(
    mock.lock.mock.invocationCallOrder[0] ?? 0,
  );
  expect(mock.lock.mock.invocationCallOrder[0]).toBeLessThan(
    mock.ready.mock.invocationCallOrder[0] ?? 0,
  );
  expect(mock.construct.mock.calls[0]?.[0]).toMatchObject({
    title: "Foom Dev",
    webPreferences: {
      additionalArguments: ["--foom-development", expect.stringMatching(/^--foom-window-id=/)],
    },
  });
  const event = { preventDefault: vi.fn() };
  mock.windowEvents.get("page-title-updated")?.(event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
});

test("duplicate launches exit without opening profile stores or shutdown writers", async () => {
  mock.lock.mockReturnValue(false);
  await start();
  expect(mock.quit).toHaveBeenCalledOnce();
  expect(mock.ready).not.toHaveBeenCalled();
  expect(mock.openWorktrees).not.toHaveBeenCalled();
  expect(mock.openSettings).not.toHaveBeenCalled();
  expect(mock.saveWindowSize).not.toHaveBeenCalled();
  expect(mock.appEvents.size).toBe(0);
});

test.each([false, true])(
  "second launch reveals and focuses existing window (minimized: %s)",
  async (minimized) => {
    await start();
    mock.window.show.mockClear();
    mock.window.isMinimized.mockReturnValue(minimized);
    mock.appEvents.get("second-instance")?.({ preventDefault: vi.fn() });
    expect(mock.window.restore).toHaveBeenCalledTimes(minimized ? 1 : 0);
    expect(mock.window.show).toHaveBeenCalledOnce();
    expect(mock.window.focus).toHaveBeenCalledOnce();
    mock.state.windows = [];
    mock.appEvents.get("second-instance")?.({ preventDefault: vi.fn() });
    expect(mock.window.focus).toHaveBeenCalledOnce();
  },
);

test("packaged builds keep their default profile and identity", async () => {
  mock.packaged = true;
  await start();
  expect(mock.setPath).not.toHaveBeenCalled();
  expect(mock.construct.mock.calls[0]?.[0]?.title).toBe("Foom");
  expect(mock.construct.mock.calls[0]?.[0]?.webPreferences?.devTools).toBe(false);
  expect(mock.construct.mock.calls[0]?.[0]?.webPreferences?.additionalArguments).toEqual([
    expect.stringMatching(/^--foom-window-id=/),
  ]);
});

test("a discovery initialization failure leaves the main window usable", async () => {
  mock.workspace.initializeControl.mockRejectedValueOnce(new Error("private profile"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await start();
  await vi.waitFor(() => {
    expect(warn).toHaveBeenCalledWith("Foom CLI discovery is unavailable.");
  });
  expect(mock.attachWorkspace).toHaveBeenCalled();
});
