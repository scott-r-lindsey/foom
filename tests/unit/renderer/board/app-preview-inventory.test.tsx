// @vitest-environment jsdom
import { render } from "@testing-library/react";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { expect, test, vi } from "vitest";
import { Board } from "../../../../src/renderer/board/board-view";
import { mock, settle } from "./app-board-fixture";
import { createAppSource } from "../../../../src/renderer/board/live-board-source";
import { attachWorkspace } from "../../../../src/main/workspace/workspace-ipc";
import { Workspace } from "../../../../src/main/workspace/workspace";
import type { WindowIpc } from "../../../../src/main/window/window-ipc";
import type { PreviewRecord } from "../../../../src/shared/previews";
import type { SidebarInventory } from "../../../../src/shared/workspace";
import { deps, repo, tree } from "../../main/workspace/workspace-fixture";

vi.mock("electron", () => ({ ipcMain: {}, shell: {}, dialog: {} }));
vi.mock("../../../../src/main/workspace/home-shell", () => ({
  homeDirectory: "/fixture/home",
  shellPath: () => "/fixture/bash",
  homeShellFacts: () =>
    Promise.resolve({ directory: "/fixture/home", path: "/fixture/bash", version: null }),
}));

test("open preview tiles survive failed repository reads through main IPC and recover in place", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  const workspace = new Workspace(deps);
  const frame = { url: "app://bundle/index.html" };
  const contents = { mainFrame: frame, on: vi.fn(), removeListener: vi.fn() };
  const windowMock = { webContents: contents } as unknown as BrowserWindow;
  const trusted = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  const handlers = new Map<string, Parameters<WindowIpc["handle"]>[1]>();
  const ipc: WindowIpc = {
    handle: (channel, handler) => {
      handlers.set(channel, handler);
    },
    removeHandler: (channel) => {
      handlers.delete(channel);
    },
  };
  const preview: PreviewRecord = {
    id: "a".repeat(32),
    worktree: tree.path,
    relativePath: "saved.md",
    network: false,
  };
  const attached = attachWorkspace(
    windowMock,
    workspace,
    () => false,
    () => Promise.resolve(false),
    ipc,
    () => [preview],
  );
  const handler = handlers.get("workspace:sidebar");
  if (!handler) throw new Error("Missing sidebar IPC");
  mock.sidebarInventory.mockImplementation(() => handler(trusted) as Promise<SidebarInventory>);
  mock.workspace.mockImplementation(() => Promise.resolve(workspace.snapshot()));
  const key = "foom.tiles.v1";
  localStorage.setItem(
    key,
    JSON.stringify({
      version: 2,
      focused: "saved",
      tree: { kind: "tile", id: "saved", content: { kind: "preview", preview: preview.id } },
    }),
  );
  const source = createAppSource();
  const view = render(<Board source={source} />);
  try {
    await settle();
    expect(view.getByRole("region", { name: "Tile 1: saved.md" })).toBeTruthy();
    const saved = localStorage.getItem(key);
    expect(saved).toContain(preview.id);
    vi.mocked(deps.worktrees.listWorktrees).mockRejectedValue(new Error("Repository unavailable"));
    mock.changed?.();
    await settle();
    expect(source.getSidebar?.()).toEqual([
      expect.objectContaining({ path: repo.path, unavailable: true }),
    ]);
    expect(localStorage.getItem(key)).toBe(saved);
    expect(view.getByRole("region", { name: "Tile 1: saved.md" })).toBeTruthy();
    expect(source.previews?.getSnapshot()).toEqual([
      expect.objectContaining({ id: preview.id, repository: repo.path }),
    ]);
    vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([tree]);
    mock.changed?.();
    await settle();
    expect(view.getByRole("region", { name: "Tile 1: saved.md" })).toBeTruthy();
    expect(localStorage.getItem(key)).toBe(saved);
    expect(source.getSidebar?.()[0]?.unavailable).toBeUndefined();
  } finally {
    view.unmount();
    attached.dispose();
    await workspace.dispose();
    vi.unstubAllGlobals();
  }
});
