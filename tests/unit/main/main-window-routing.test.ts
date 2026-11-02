import { previewMock, mock, start, quitting, invokeWindow, newWindow } from "./main-fixture";
import type { Settings } from "../../../src/shared/setup";

import { setupState } from "../../fixtures/setup";

import { expect, test, vi } from "vitest";
import type { ShortcutInput } from "./main-fixture";

test.each(["c", "C", "v", "V"])("handles Ctrl+Shift+%s without a menu", async (key) => {
  await start();
  const event = { preventDefault: vi.fn() };
  mock.windowEvents.get("before-input-event")?.(event, {
    type: "keyDown",
    key,
    code: `Key${key.toUpperCase()}`,
    control: true,
    shift: true,
    alt: false,
    meta: false,
  });
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(mock.window.webContents.copy).toHaveBeenCalledTimes(key.toLowerCase() === "c" ? 1 : 0);
  expect(mock.window.webContents.paste).toHaveBeenCalledTimes(key.toLowerCase() === "v" ? 1 : 0);
});

test.each<Partial<ShortcutInput>>([
  { type: "keyUp" },
  { control: false },
  { shift: false },
  { alt: true },
  { meta: true },
  { key: "w", code: "KeyW" },
])("leaves other keys to the terminal (%j)", async (overrides) => {
  await start();
  const event = { preventDefault: vi.fn() };
  mock.windowEvents.get("before-input-event")?.(event, {
    type: "keyDown",
    key: "c",
    code: "KeyC",
    control: true,
    shift: true,
    alt: false,
    meta: false,
    ...overrides,
  });
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(mock.window.webContents.copy).not.toHaveBeenCalled();
  expect(mock.window.webContents.paste).not.toHaveBeenCalled();
});

test.each([true, false])("uses the native theme at window creation (dark: %s)", async (dark) => {
  mock.theme.shouldUseDarkColors = dark;
  await start();
  expect(mock.construct.mock.calls[0]?.[0].backgroundColor).toBe(dark ? "#05040a" : "#f3f0fa");
});

test("keeps the native background in sync with theme updates and removes its listener on close", async () => {
  await start();
  const update = mock.theme.on.mock.calls[0]?.[1];
  for (const dark of [true, false]) {
    mock.theme.shouldUseDarkColors = dark;
    update?.();
    expect(mock.window.setBackgroundColor).toHaveBeenLastCalledWith(dark ? "#05040a" : "#f3f0fa");
  }
  mock.readyEvents.get("closed")?.();
  expect(mock.theme.removeListener).toHaveBeenCalledWith("updated", update);
});

test("zoom shortcuts change the interface size instead of reaching the terminal", async () => {
  await start();
  const input = mock.windowEvents.get("before-input-event");
  const key = (overrides: Partial<ShortcutInput>) => {
    const event = { preventDefault: vi.fn() };
    const shortcut: ShortcutInput = {
      type: "keyDown",
      key: "+",
      code: "Equal",
      control: process.platform !== "darwin",
      meta: process.platform === "darwin",
      shift: true,
      alt: false,
      ...overrides,
    };
    input?.(event, shortcut);
    return event.preventDefault;
  };
  expect(key({})).toHaveBeenCalledOnce();
  expect(mock.setupIpc.zoom).toHaveBeenCalledWith("in");
  // Plain Ctrl+- stays with the terminal (readline undo) on Linux and Windows.
  if (process.platform !== "darwin") {
    expect(key({ code: "Minus", key: "-", shift: false })).not.toHaveBeenCalled();
  }
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  mock.setupIpc.zoom.mockRejectedValueOnce(new Error("disk full"));
  key({ code: "Digit0", key: "0", shift: process.platform !== "darwin" });
  await vi.waitFor(() => {
    expect(log).toHaveBeenCalledWith("Unable to change interface size:", expect.any(Error));
  });
});

test("main intercepts board chords before terminal input", async () => {
  await start();
  const event = { preventDefault: vi.fn() };
  mock.windowEvents.get("before-input-event")?.(event, {
    type: "keyDown",
    key: "B",
    code: "KeyB",
    shift: process.platform !== "darwin",
    alt: false,
    control: process.platform !== "darwin",
    meta: process.platform === "darwin",
  });
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(mock.window.webContents.send).toHaveBeenCalledWith("board:command", "toggle-sidebar");
});

test("restores saved dimensions on startup", async () => {
  mock.loadWindowSize.mockResolvedValueOnce({ width: 1400, height: 900 });
  await start();
  expect(mock.construct.mock.calls[0]?.[0]).toMatchObject({ width: 1400, height: 900 });
});

test("saves normal dimensions before quitting", async () => {
  await start();
  quitting();
  await vi.waitFor(() => {
    expect(mock.quit).toHaveBeenCalledOnce();
  });
  expect(mock.saveWindowSize).toHaveBeenCalledWith("/test/user-data", {
    x: 0,
    y: 0,
    width: 1100,
    height: 800,
  });
});

test("a window size write failure does not prevent quitting", async () => {
  const error = new Error("disk full");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  mock.saveWindowSize.mockRejectedValueOnce(error);
  await start();
  quitting();
  await vi.waitFor(() => {
    expect(mock.quit).toHaveBeenCalledOnce();
  });
  expect(log).toHaveBeenCalledWith("Unable to save the window size:", error);
});

test("fixed interface themes set the native base and exact background, even between two dark themes", async () => {
  let settings = setupState({ interfaceTheme: "deep-field" }).settings;
  vi.spyOn(mock.settingsStore, "get").mockImplementation(() => settings);
  await start();
  expect(mock.theme.themeSource).toBe("dark");
  expect(mock.construct.mock.calls[0]?.[0].backgroundColor).toBe("#080f1e");
  settings = { ...settings, interfaceTheme: "high-contrast" };
  mock.setup.deps?.apply(settings);
  expect(mock.window.setBackgroundColor).toHaveBeenLastCalledWith("#000000");
  settings = { ...settings, interfaceTheme: "moonlight" };
  mock.setup.deps?.apply(settings);
  expect(mock.theme.themeSource).toBe("light");
  expect(mock.window.setBackgroundColor).toHaveBeenLastCalledWith("#f5f7fc");
});

test("session, host and preview copies share main's clipboard capability", async () => {
  await start();
  const { clipboard } = await import("electron");
  await mock.workspace.deps?.copyText?.("saved-session-id");
  await mock.setup.deps?.copyText?.("registered-host");
  await previewMock.copyText?.("/opened/preview.md");
  expect(vi.mocked(clipboard).writeText.mock.calls).toEqual([
    ["saved-session-id"],
    ["registered-host"],
    ["/opened/preview.md"],
  ]);
});

test("window focus refreshes external workspace inventory", async () => {
  await import("../../../src/main/main");
  await start();
  mock.windowEvents.get("focus")?.({ preventDefault: vi.fn() });
  expect(mock.workspace.refresh).toHaveBeenCalledOnce();
  mock.window.webContents.isCrashed.mockReturnValue(true);
  mock.windowEvents.get("focus")?.({ preventDefault: vi.fn() });
  expect(mock.workspace.refresh).toHaveBeenCalledOnce();
});

test("new windows share one workspace and route reservations, focus and popout independently", async () => {
  await start();
  await newWindow();
  expect(mock.terminals.addWindow).toHaveBeenCalledOnce();
  expect(mock.openWorktrees).toHaveBeenCalledOnce();
  expect(await invokeWindow(0, "windows:sync", ["t1"])).toEqual(["t1"]);
  expect(await invokeWindow(1, "windows:sync", ["t1", "t2"])).toEqual(["t2"]);
  expect(await invokeWindow(0, "windows:views")).toEqual([
    { id: "t1", window: 0 },
    { id: "t2", window: 2 },
  ]);
  expect(await invokeWindow(1, "windows:select", "t1")).toBe(false);
  expect(mock.window.focus).toHaveBeenCalled();
  expect(mock.allowView({}, "t3")).toBe(false);
  expect(mock.allowView(mock.instances[1]?.webContents, "t1")).toBe(false);
  expect(mock.allowView(mock.instances[1]?.webContents, "t2")).toBe(true);
  await invokeWindow(0, "windows:popout", "t1");
  expect(mock.instances).toHaveLength(3);
  expect(mock.terminals.detachView).toHaveBeenCalledWith("t1", mock.instances[0]?.webContents);
  expect(mock.construct.mock.calls[2]?.[0].webPreferences?.additionalArguments).toContain(
    "--foom-initial-session=t1",
  );
  await invokeWindow(1, "windows:sync", []);
  expect(mock.terminals.detachView).toHaveBeenCalledWith("t2", mock.instances[1]?.webContents);
  expect(await invokeWindow(2, "windows:audio-state")).toMatchObject({ enabled: false });
  await invokeWindow(2, "windows:audio-focus", "t1");
  expect(mock.workspace.focusOrchestrator).toHaveBeenCalledWith("t1");
  mock.workspace.deps?.onChange?.();
  expect(mock.ipc.sendChanged).toHaveBeenCalledTimes(3);
});

test("restores window identities and maximization with one shared scale and persists geometry only", async () => {
  mock.loadPlacements.mockResolvedValue([
    {
      id: "first",
      display: 1,
      bounds: { x: 1850, y: 1000, width: 50, height: 50 },
      maximized: true,
      scale: 150,
    },
    {
      id: "second",
      display: 1,
      bounds: { x: 20, y: 30, width: 1200, height: 900 },
      maximized: false,
      scale: 90,
    },
  ]);
  await start();
  await vi.waitFor(() => {
    expect(mock.instances).toHaveLength(2);
  });
  expect(mock.instances[0]?.maximize).toHaveBeenCalledOnce();
  for (const call of mock.construct.mock.calls)
    expect(call[0].webPreferences?.additionalArguments).toContain("--foom-window-restored=true");
  expect(mock.construct.mock.calls[0]?.[0]).toMatchObject({
    x: 840,
    y: 312,
    width: 1080,
    height: 768,
  });
  expect(mock.construct.mock.calls[1]?.[0].webPreferences?.zoomFactor).toBe(1.2);
  const store = mock.setup.deps?.store;
  expect(store).toBe(mock.settingsStore);
  expect(store?.get().interfaceScale).toBe(120);
  mock.setup.deps?.apply({ ...mock.settingsStore.get(), interfaceScale: 140 } as Settings);
  for (const window of mock.instances)
    expect(window.webContents.setZoomFactor).toHaveBeenLastCalledWith(1.4);
  quitting();
  await vi.waitFor(() => {
    expect(mock.quit).toHaveBeenCalledOnce();
  });
  const persisted = mock.savePlacements.mock.calls[0]?.[1];
  expect(persisted?.map((placement) => placement.id)).toEqual(["first", "second"]);
  for (const placement of persisted ?? []) expect(placement).not.toHaveProperty("scale");
});

test("macOS closing the last window retains app services and activation opens another board", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  await start();
  const event = { preventDefault: vi.fn() };
  mock.windowEvents.get("close")?.(event);
  expect(event.preventDefault).not.toHaveBeenCalled();
  mock.readyEvents.get("closed")?.();
  expect(mock.terminals.shutdown).not.toHaveBeenCalled();
  expect(mock.workspace.dispose).not.toHaveBeenCalled();
  await vi.waitFor(() => {
    expect(mock.savePlacements).toHaveBeenCalledWith("/test/user-data", []);
  });
  mock.appEvents.get("activate")?.(event);
  await vi.waitFor(() => {
    expect(mock.instances).toHaveLength(2);
  });
  expect(mock.terminals.addWindow).toHaveBeenCalledOnce();
  mock.appEvents.get("activate")?.(event);
  await Promise.resolve();
  expect(mock.instances).toHaveLength(2);
});

test("failed placement saves do not stop quit, and a later save can recover", async () => {
  const error = new Error("Read only profile");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  mock.savePlacements.mockRejectedValueOnce(error);
  await start();
  mock.readyEvents.get("closed")?.();
  await vi.waitFor(() => {
    expect(log).toHaveBeenCalledWith("Unable to save windows:", error);
  });
  quitting();
  await vi.waitFor(() => {
    expect(mock.quit).toHaveBeenCalledOnce();
  });
  expect(mock.savePlacements).toHaveBeenCalledTimes(2);
});

test("reports failed New Window loads and lets a subsequent window open", async () => {
  await start();
  const error = new Error("Unable to load board");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  mock.window.loadURL.mockRejectedValueOnce(error);
  await newWindow();
  await vi.waitFor(() => {
    expect(log).toHaveBeenCalledWith("Unable to open window:", error);
  });
  await newWindow();
  expect(mock.terminals.addWindow).toHaveBeenCalledTimes(2);
});

test("app attention reveals the owning board, including minimized and windowless cases", async () => {
  const { updateAttention } = await import("../../../src/main/window/attention-badge");
  await start();
  await newWindow();
  await invokeWindow(1, "windows:sync", ["t1"]);
  const reveal = vi.mocked(updateAttention).mock.lastCall?.[3];
  if (!reveal) throw new Error("Missing attention action");
  mock.window.isMinimized.mockReturnValue(true);
  reveal("t1");
  await vi.waitFor(() => {
    expect(mock.window.webContents.send).toHaveBeenCalledWith("app-menu:session", "t1");
  });
  expect(mock.window.restore).toHaveBeenCalled();
  reveal("unshown");
  await vi.waitFor(() => {
    expect(mock.window.webContents.send).toHaveBeenCalledWith("app-menu:session", "unshown");
  });
  mock.readyEvents.get("closed")?.();
  const reopen = vi.mocked(updateAttention).mock.lastCall?.[3];
  reopen?.("t1");
  await vi.waitFor(() => {
    expect(mock.instances).toHaveLength(3);
  });
  expect(mock.construct.mock.calls[2]?.[0].webPreferences?.additionalArguments).toContain(
    "--foom-initial-session=t1",
  );
});

test("Windows attention refresh updates every live window so prior overlays clear", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const { updateAttention } = await import("../../../src/main/window/attention-badge");
  await start();
  await newWindow();
  vi.mocked(updateAttention).mockClear();
  mock.workspace.deps?.onChange?.();
  expect(vi.mocked(updateAttention).mock.calls.map((call) => call[0])).toEqual(mock.instances);
});

test("windowless About opens a board and dispatches the in-board dialog command", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  await start();
  mock.readyEvents.get("closed")?.();
  const { Menu } = await import("electron");
  const template = vi.mocked(Menu).buildFromTemplate.mock.lastCall?.[0];
  const about = template
    ?.flatMap((section) => (Array.isArray(section.submenu) ? section.submenu : []))
    .find((item) => item.id === "about");
  if (!about?.click) throw new Error("Missing windowless About");
  about.click({} as Electron.MenuItem, undefined, {});
  await vi.waitFor(() => {
    expect(mock.window.webContents.send).toHaveBeenCalledWith("board:command", "about");
  });
});

test("terminal clipboard permission reads the current copy-on-select preference", async () => {
  const settings = mock.settingsStore.get();
  let enabled = false;
  vi.spyOn(mock.settingsStore, "get").mockImplementation(() => ({
    ...settings,
    copyOnSelect: enabled,
  }));
  await start();
  expect(mock.copyOnSelect()).toBe(false);
  enabled = true;
  expect(mock.copyOnSelect()).toBe(true);
  enabled = false;
  expect(mock.copyOnSelect()).toBe(false);
});
