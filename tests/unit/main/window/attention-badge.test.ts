import { afterEach, expect, test, vi } from "vitest";
import type { BrowserWindow, MenuItemConstructorOptions } from "electron";
import { createCommands } from "../../../../src/main/window/commands";
import type { WorkspaceTerminal } from "../../../../src/shared/workspace";
const mock = vi.hoisted(() => ({
  badge: vi.fn(),
  count: vi.fn(),
  menu: vi.fn(),
  bitmap: vi.fn((pixels: Buffer) => pixels),
}));
vi.mock("electron", () => ({
  app: { dock: { setBadge: mock.badge, setMenu: mock.menu }, setBadgeCount: mock.count },
  Menu: { buildFromTemplate: (items: MenuItemConstructorOptions[]) => items },
  nativeImage: { createFromBitmap: mock.bitmap },
}));
import { badgePixels, updateAttention } from "../../../../src/main/window/attention-badge";
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
const terminal = (id: string, state: "needs_input" | "working"): WorkspaceTerminal => ({
  id,
  agent: "shell",
  kind: "shell",
  branch: "main",
  repository: "/repo",
  worktree: "/repo",
  attention: "evaluator",
  state: { id, state, verdictId: null, reason: "", signal: "", confidence: 1, timestamp: 0 },
});
test.each(["linux", "win32", "darwin"] as const)(
  "%s counts only needs-you sessions, updates down and clears zero",
  (platform) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const window = {
      setOverlayIcon: vi.fn(),
      isMinimized: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      webContents: { send: vi.fn() },
    };
    const command = createCommands(platform, false, {
      board: vi.fn(),
      zoom: vi.fn(),
      native: vi.fn(),
    }).find((item) => item.id === "new-window");
    if (!command) throw new Error("Missing command");
    const update = (terminals: WorkspaceTerminal[]) => {
      updateAttention(window as unknown as BrowserWindow, { repositories: [], terminals }, command);
    };
    const second = { ...terminal("b", "needs_input"), branch: null };
    update([terminal("a", "needs_input"), second, terminal("c", "working")]);
    if (platform === "darwin") {
      expect(mock.badge).toHaveBeenLastCalledWith("2");
      const menu: unknown = mock.menu.mock.calls.at(-1)?.[0];
      if (!Array.isArray(menu)) throw new Error("Missing Dock menu");
      // Invoke through Electron's typed menu surface, as native clicks do.
      for (const item of menu as MenuItemConstructorOptions[])
        if (item.click && item.id !== "new-window")
          item.click({} as Electron.MenuItem, undefined, {});
      expect(window.webContents.send).toHaveBeenCalledWith("app-menu:session", "b");
      window.isMinimized.mockReturnValue(false);
      const item = (menu as MenuItemConstructorOptions[])[1];
      item?.click?.({} as Electron.MenuItem, undefined, {});
    } else if (platform === "win32")
      expect(window.setOverlayIcon).toHaveBeenLastCalledWith(
        expect.any(Buffer),
        "2 sessions need you",
      );
    else expect(mock.count).toHaveBeenLastCalledWith(2);
    update([terminal("a", "needs_input")]);
    update([{ ...terminal("a", "working"), state: null }]);
    if (platform === "darwin") expect(mock.badge).toHaveBeenLastCalledWith("");
    else if (platform === "win32") expect(window.setOverlayIcon).toHaveBeenLastCalledWith(null, "");
    else expect(mock.count).toHaveBeenLastCalledWith(0);
  },
);
test("overlay raster contains transparent corners and different one- and two-digit counts", () => {
  const one = badgePixels(1);
  expect(one.length).toBe(4096);
  expect(one[3]).toBe(0);
  expect(one).not.toEqual(badgePixels(12));
  expect(badgePixels(100)).toEqual(badgePixels(99));
});
