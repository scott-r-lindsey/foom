import { act, fireEvent, render } from "@testing-library/react";
import { Board } from "../../../../src/renderer/board/board-view";
import { agent, mock, settle, verdict } from "./app-board-fixture";
// @vitest-environment jsdom
import { expect, test, vi } from "vitest";
import { createAppSource } from "../../../../src/renderer/board/live-board-source";
import {
  initialLayout,
  restoreLayout,
  saveLayout,
  TILE_STORAGE,
} from "../../../../src/renderer/board/tiles";
import type { PreviewApi } from "../../../../src/shared/previews";
import type { SidebarInventory, WorkspaceSnapshot } from "../../../../src/shared/workspace";
test("source connects independently of views, reconciles events, preserves ordering, and keeps activity outside snapshots", async () => {
  const source = createAppSource();
  expect(source.previews?.getSnapshot()).toEqual([]);
  await expect(source.previews?.close("unknown")).resolves.toBeUndefined();
  await expect(source.previews?.pick("unknown")).resolves.toBeNull();
  await source.previews?.bounds("unknown", { x: 0, y: 0, width: 0, height: 0, visible: false });
  await expect(source.previews?.network?.("unknown", true)).rejects.toThrow(
    "Preview host unavailable",
  );
  await expect(source.previews?.popout?.("unknown")).rejects.toThrow("Preview host unavailable");
  await expect(source.previews?.reload?.("unknown")).rejects.toThrow("Preview host unavailable");
  await expect(source.previews?.copyPath?.("unknown")).rejects.toThrow("Copy unavailable");
  const copyPath = vi.fn(async () => {});
  const popout = vi.fn(() => Promise.resolve());
  const reload = vi.fn(() => Promise.resolve());
  const network = vi.fn(() => Promise.resolve());
  window.desktop.previews = {
    copyPath,
    reload,
    network,
    popout,
    pick: vi.fn(),
    close: vi.fn(),
    bounds: vi.fn(),
    painted: vi.fn(async () => {}),
    cover: vi.fn(),
    onSnapshots: vi.fn(),
  };
  await source.previews?.copyPath?.("id");
  expect(copyPath).toHaveBeenCalledWith("id");
  await source.previews?.reload?.("id");
  expect(reload).toHaveBeenCalledWith("id");
  await source.previews?.network?.("id", true);
  expect(network).toHaveBeenCalledWith("id", true);
  await source.previews?.popout?.("id");
  expect(popout).toHaveBeenCalledWith("id");
  delete window.desktop.previews;
  expect(source.isReady?.()).toBe(false);
  const disconnect = source.connect?.();
  await settle();
  expect(source.isReady?.()).toBe(true);
  await source.shell?.restart();
  expect(source.getSnapshot()[0]?.id).toBe("real-id");
  const listener = vi.fn(),
    off = source.subscribe(listener),
    activity = vi.fn(),
    offActivity = source.subscribeActivity(activity);
  const before = source.getSnapshot();
  mock.activity?.([{ id: "real-id", rate: 2000 }]);
  expect(source.getSnapshot()).toBe(before);
  expect(listener).not.toHaveBeenCalled();
  expect(activity).toHaveBeenCalledOnce();
  mock.state?.(verdict("a"));
  mock.workspace.mockResolvedValue({
    repositories: [{ path: "/code/app", name: "app" }],
    terminals: [agent("a")],
  });
  mock.changed?.();
  await settle();
  expect(source.getSnapshot()[1]).toMatchObject({
    id: "a",
    repository: "app",
    waitingSince: 100,
    state: "needs_input",
  });
  source.markSeen("a");
  mock.state?.(verdict("a", 200));
  expect(source.getSnapshot()[1]?.waitingSince).toBe(100);
  await source.resolve("a", "Not attention");
  expect(mock.feedback).toHaveBeenCalledWith("a", "v-200", "dismissed");
  mock.state?.({ ...verdict("a", 300), state: "quiet_ok", verdictId: null });
  expect(source.getSnapshot()[1]?.waitingSince).toBe(0);
  await source.resolve("a", "ignored");
  await source.resolve("foreign", "ignored");
  expect(mock.feedback).toHaveBeenCalledOnce();
  mock.state?.({ ...verdict("a", 400), verdictId: null });
  await source.resolve("a", "Not attention");
  expect(mock.feedback).toHaveBeenLastCalledWith("a", null, "dismissed");
  mock.exit?.("a", 1);
  mock.state?.(verdict("a", 500));
  expect(source.getSnapshot()[1]?.state).toBe("failed");
  mock.state?.({ ...verdict("a", 600), state: "failed" });
  source.markSeen("a");
  mock.workspace.mockResolvedValue({
    repositories: [],
    terminals: [agent("b", { ...verdict("b"), state: "done" }), agent("a")],
  });
  mock.changed?.();
  await settle();
  expect(source.getSnapshot().map((row) => row.id)).toEqual(["real-id", "a", "b"]);
  expect(source.getSnapshot()[1]?.seen).toBe(true);
  mock.exit?.("real-id", 0);
  expect(source.getSnapshot()[0]?.state).toBe("done");
  mock.workspace.mockResolvedValue({ repositories: [], terminals: [] });
  mock.changed?.();
  await settle();
  expect(source.getSnapshot()).toHaveLength(1);
  expect(source.getRepositories?.()).toEqual([]);
  expect(source.getSidebar?.()).toEqual([]);
  expect(source.shellName?.()).toBe("bash");
  off();
  offActivity();
  disconnect?.();
  expect(mock.off).toHaveBeenCalledTimes(6);
});
test("late snapshots and disconnected refreshes cannot undo newer inventory or verdicts", async () => {
  const source = createAppSource();
  let finish: ((value: WorkspaceSnapshot) => void) | undefined;
  mock.workspace.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const off = source.connect?.();
  mock.workspace.mockResolvedValue({
    repositories: [],
    terminals: [agent("new", verdict("new", 200))],
  });
  mock.changed?.();
  await settle();
  finish?.({ repositories: [], terminals: [agent("old")] });
  await settle();
  expect(source.getSnapshot()[0]?.id).toBe("new");
  mock.state?.(verdict("new", 300));
  mock.changed?.();
  await settle();
  expect(source.getSnapshot()[0]?.verdictId).toBe("v-300");

  mock.workspace.mockRejectedValueOnce(new Error("offline"));
  mock.changed?.();
  await settle();
  expect(source.getSnapshot()[0]?.id).toBe("new");
  mock.workspace.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  mock.changed?.();
  off?.();
  finish?.({ repositories: [], terminals: [] });
  await settle();
  expect(source.getSnapshot()).toHaveLength(1);
});
test("explicit shell launch serializes duplicate requests and keeps failures retryable", async () => {
  const source = createAppSource();
  mock.create.mockRejectedValueOnce(new Error("no PTY"));
  await source.shell?.restart();
  expect(source.getSnapshot()[0]).toMatchObject({
    id: "local-shell",
    state: "failed",
    exited: true,
  });
  await source.sidebarCommand?.({ kind: "restart", id: "local-shell" });
  expect(source.getSnapshot()[0]?.id).toBe("real-id");
  await Promise.all([source.shell?.restart(), source.shell?.restart()]);
  expect(mock.kill).toHaveBeenCalledWith("real-id");
  expect(mock.create).toHaveBeenCalledTimes(3);
  mock.create.mockRejectedValueOnce("offline");
  await source.shell?.restart();
  expect(source.getSnapshot()[0]?.reason).toBe("Unable to start shell.");
  const kills = mock.kill.mock.calls.length;
  await source.shell?.restart();
  expect(source.getSnapshot()[0]?.id).toBe("real-id");
  expect(mock.kill).toHaveBeenCalledTimes(kills);
});
test("launch, close and worktree actions refresh their inventories", async () => {
  const source = createAppSource();
  const off = source.worktrees?.subscribe?.(vi.fn());
  off?.();
  await source.config?.decide?.("keep", "held");
  expect(mock.configStatus).toHaveBeenCalledWith("keep", "held");
  expect(await source.worktrees?.load()).toMatchObject({ hooks: true });
  expect(await source.worktrees?.addRepository()).toBeNull();
  await expect(source.worktrees?.branches("/r")).resolves.toMatchObject({ head: "main" });
  expect(mock.branches).toHaveBeenCalledWith("/r");
  const inventories = mock.sidebarInventory.mock.calls.length;
  await expect(source.worktrees?.create("/r", "feature")).resolves.toEqual({
    path: "/r/feature",
    outcome: "new",
  });
  // Main picks the location; the sidebar lists the worktree before the field hears back.
  expect(mock.createWorktree).toHaveBeenCalledWith("/r", "feature");
  expect(mock.sidebarInventory.mock.calls.length).toBe(inventories + 1);
  mock.removeWorktree.mockResolvedValueOnce(false);
  expect(await source.worktrees?.remove("a")).toBe(false);
  expect(await source.worktrees?.remove("a")).toBe(true);
  mock.workspace.mockResolvedValue({ repositories: [], terminals: [agent("a")] });
  await source.sidebarCommand?.({ kind: "launch", repository: "/r", worktree: "/r", run: "shell" });
  expect(source.getSnapshot()).toHaveLength(1);
  mock.workspace.mockResolvedValue({ repositories: [], terminals: [] });
  await source.sidebarCommand?.({ kind: "close", id: "a" });
  expect(source.getSnapshot()).toHaveLength(0);
});
test("fresh foreground names replace cached row metadata and clear at the prompt", async () => {
  const source = createAppSource();
  const disconnect = source.connect?.();
  await settle();
  for (const name of ["sleep", "vim", ""]) {
    mock.workspace.mockResolvedValue({
      repositories: [],
      terminals: [{ ...agent("shell"), kind: "shell", agent: "shell", foregroundProgram: name }],
    });
    mock.changed?.();
    await settle();
    expect(source.getSnapshot().find((row) => row.id === "shell")?.foregroundProgram).toBe(name);
  }
  disconnect?.();
});

test("activity subscribers receive the final cached zero when views remount", async () => {
  const source = createAppSource();
  const disconnect = source.connect?.();
  await settle();
  mock.activity?.([{ id: "a", rate: 4000 }]);
  mock.activity?.([{ id: "a", rate: 0 }]);
  const listener = vi.fn();
  const off = source.subscribeActivity(listener);
  expect(listener).toHaveBeenCalledWith([{ id: "a", rate: 0 }]);
  off();
  disconnect?.();
});

test("repository outages retain locations and sessions and clear only their inventory mark on recovery", async () => {
  const repository = { path: "/code/app", name: "app" };
  const tree = {
    path: "/code/a",
    branch: "a",
    head: "abc",
    bare: false,
    locked: false,
    prunable: false,
    managed: false,
  };
  mock.workspace.mockResolvedValue({ repositories: [repository], terminals: [agent("a")] });
  mock.sidebarInventory.mockResolvedValue({
    repositories: [{ ...repository, worktrees: [tree] }],
    shell: "bash",
  });
  const errors = { report: vi.fn(), clear: vi.fn() };
  const source = createAppSource();
  const off = source.connect?.(errors);
  await settle();
  mock.sidebarInventory.mockResolvedValue({
    repositories: [{ ...repository, unavailable: true, worktrees: [] }],
    shell: "bash",
  });
  mock.workspace.mockResolvedValue({
    repositories: [repository],
    terminals: [agent("a"), agent("b")],
  });
  mock.changed?.();
  await settle();
  expect(source.getSnapshot().map((row) => row.id)).toEqual(["a", "b"]);
  expect(source.getSnapshot()[0]?.worktreeRemoved).toBe(false);
  expect(source.getSidebar?.()[0]).toMatchObject({ unavailable: true, worktrees: [tree] });
  expect(errors.report).toHaveBeenCalledWith(
    "sidebar-inventory:/code/app",
    "Repository unavailable.",
    "repository:/code/app",
  );
  const reports = errors.report.mock.calls.length;
  mock.changed?.();
  await settle();
  expect(errors.report).toHaveBeenCalledTimes(reports);
  mock.sidebarInventory.mockResolvedValue({
    repositories: [{ ...repository, worktrees: [tree] }],
    shell: "bash",
  });
  mock.changed?.();
  await settle();
  expect(source.getSidebar?.()[0]?.unavailable).toBeUndefined();
  expect(errors.clear).toHaveBeenCalledWith("sidebar-inventory:/code/app");
  off?.();
});

test("workspace and sidebar reads publish independently even when the other read fails or hangs", async () => {
  const errors = { report: vi.fn(), clear: vi.fn() };
  mock.sidebarInventory.mockRejectedValueOnce(new Error("private IPC failure"));
  mock.workspace.mockResolvedValue({ repositories: [], terminals: [agent("a")] });
  const source = createAppSource();
  const off = source.connect?.(errors);
  await settle();
  expect(source.isReady?.()).toBe(true);
  expect(source.getSnapshot().map((row) => row.id)).toEqual(["a"]);
  expect(errors.report).toHaveBeenCalledWith(
    "sidebar-refresh",
    "Unable to load sidebar inventory.",
  );
  mock.workspace.mockRejectedValueOnce(new Error("workspace failure"));
  mock.sidebarInventory.mockResolvedValueOnce({
    repositories: [{ path: "/healthy", name: "Healthy", worktrees: [] }],
    shell: "zsh",
  });
  mock.changed?.();
  await settle();
  expect(source.shellName?.()).toBe("zsh");
  expect(source.getSidebar?.()[0]?.path).toBe("/healthy");
  expect(source.getSnapshot().map((row) => row.id)).toEqual(["a"]);
  expect(errors.report).toHaveBeenCalledWith("workspace-refresh", "Unable to load terminals.");
  mock.workspace.mockResolvedValue({ repositories: [], terminals: [agent("b")] });
  const pending =
    Promise.withResolvers<Awaited<ReturnType<typeof window.desktop.sidebarInventory>>>();
  mock.sidebarInventory.mockReturnValueOnce(pending.promise);
  mock.changed?.();
  await settle();
  expect(source.getSnapshot().map((row) => row.id)).toEqual(["b"]);
  expect(errors.clear).toHaveBeenCalledWith("workspace-refresh");
  off?.();
  pending.reject(new Error("late failure"));
  const reports = errors.report.mock.calls.length;
  await settle();
  expect(errors.report).toHaveBeenCalledTimes(reports);
});

test("a board retains healthy and unavailable sessions without moving focus and recovers the row mark", async () => {
  const checkout = (path: string) => ({
    path,
    branch: "main",
    head: "abc",
    bare: false,
    locked: false,
    prunable: false,
    managed: false,
  });
  const broken = { path: "/missing", name: "Missing", unavailable: true, worktrees: [] };
  const recovered = { ...broken, unavailable: false, worktrees: [checkout("/missing/tree")] };
  const healthy = { path: "/code/app", name: "app", worktrees: [checkout("/code/healthy")] };
  mock.workspace.mockResolvedValue({
    repositories: [broken, healthy],
    terminals: [
      { ...agent("lost"), repository: broken.path, worktree: "/missing/tree" },
      agent("healthy"),
    ],
  });
  mock.sidebarInventory.mockResolvedValue({ repositories: [recovered, healthy], shell: "bash" });
  const source = createAppSource();
  const view = render(<Board source={source} />);
  await settle();
  const input = document.createElement("input");
  document.body.append(input);
  input.focus();
  mock.sidebarInventory.mockResolvedValue({ repositories: [broken, healthy], shell: "bash" });
  act(() => {
    mock.changed?.();
  });
  await settle();
  expect(source.getSnapshot().map((row) => row.id)).toEqual(["lost", "healthy"]);
  expect(view.getAllByText("Unavailable")).toHaveLength(2);
  expect(view.getByRole("button", { name: "Show failure" })).toBeTruthy();
  expect(view.queryByRole("dialog", { name: "Action failed" })).toBeNull();
  expect(document.activeElement).toBe(input);
  expect(view.queryByText("Worktree removed")).toBeNull();
  mock.sidebarInventory.mockResolvedValue({ repositories: [recovered, healthy], shell: "bash" });
  act(() => {
    mock.changed?.();
  });
  await settle();
  expect(view.queryByRole("button", { name: "Show failure" })).toBeNull();
  expect(view.queryByText("Unavailable")).toBeNull();
  expect(document.activeElement).toBe(input);
  view.unmount();
  input.remove();
});

test("a fresh unavailable inventory publishes before a pending workspace and keeps membership unknown", async () => {
  const repository = { path: "/missing", name: "Missing", unavailable: true, worktrees: [] };
  const pending = Promise.withResolvers<WorkspaceSnapshot>();
  mock.workspace.mockReturnValueOnce(pending.promise);
  mock.sidebarInventory.mockResolvedValue({ repositories: [repository], shell: "bash" });
  const source = createAppSource();
  const listener = vi.fn();
  source.subscribe(listener);
  const errors = { report: vi.fn(), clear: vi.fn() };
  const off = source.connect?.(errors);
  await settle();
  expect(source.getSidebar?.()).toEqual([repository]);
  expect(source.isReady?.()).toBe(false);
  expect(listener).toHaveBeenCalled();
  pending.resolve({
    repositories: [repository],
    terminals: [{ ...agent("a"), repository: repository.path }],
  });
  await settle();
  expect(source.getSnapshot()[0]).toMatchObject({ id: "a", worktreeRemoved: false });
  off?.();
  expect(errors.clear).toHaveBeenCalledWith("sidebar-inventory:/missing");
});

test.each([true, false])(
  "a workspace snapshot waits for preview inventory before pruning (exists: %s)",
  async (exists) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
    const key = "foom.tiles.v1";
    localStorage.setItem(
      key,
      JSON.stringify({
        version: 2,
        focused: "saved",
        tree: {
          kind: "split",
          id: "split",
          direction: "horizontal",
          ratio: 0.5,
          first: { kind: "tile", id: "gone", content: { kind: "terminal", session: "gone" } },
          second: {
            kind: "tile",
            id: "saved",
            content: { kind: "preview", preview: "saved-preview" },
          },
        },
      }),
    );
    const pending =
      Promise.withResolvers<Awaited<ReturnType<typeof window.desktop.sidebarInventory>>>();
    mock.sidebarInventory.mockReturnValueOnce(pending.promise);
    const source = createAppSource();
    const view = render(<Board source={source} />);
    await settle();
    expect(source.isReady?.()).toBe(true);
    expect(source.previews?.isReady?.()).toBe(false);
    expect(localStorage.getItem(key)).toContain("saved-preview");
    pending.resolve({
      repositories: [],
      shell: "bash",
      previews: exists
        ? [
            {
              id: "saved-preview",
              repository: "/r",
              worktree: "/r",
              relativePath: "saved.md",
              kind: "markdown",
              network: false,
            },
          ]
        : [],
    });
    await settle();
    expect(source.previews?.isReady?.()).toBe(true);
    expect(localStorage.getItem(key)?.includes("saved-preview")).toBe(exists);
    expect(Boolean(view.queryByRole("region", { name: "Tile 1: saved.md" }))).toBe(exists);
    view.unmount();
    vi.unstubAllGlobals();
  },
);

test("file picking publishes inventory before returning an ID for placement", async () => {
  const preview = {
    id: "picked-preview",
    repository: "/r",
    worktree: "/r",
    relativePath: "picked.md",
    kind: "markdown" as const,
    network: false,
  };
  window.desktop.previews = {
    pick: vi.fn(() => Promise.resolve(preview.id)),
    reload: vi.fn(() => Promise.resolve()),
    network: vi.fn(() => Promise.resolve()),
    popout: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    bounds: vi.fn(() => Promise.resolve()),
    painted: vi.fn(() => Promise.resolve()),
    cover: vi.fn(),
    onSnapshots: vi.fn(),
  };
  const inventory =
    Promise.withResolvers<Awaited<ReturnType<typeof window.desktop.sidebarInventory>>>();
  mock.sidebarInventory.mockReturnValueOnce(inventory.promise);
  const source = createAppSource();
  let returned = false;
  const picked = source.previews?.pick("/r").then((id) => {
    returned = true;
    return id;
  });
  await settle();
  expect(returned).toBe(false);
  inventory.resolve({ repositories: [], shell: "bash", previews: [preview] });
  await expect(picked).resolves.toBe(preview.id);
  expect(source.previews?.getSnapshot()).toEqual([preview]);
  delete window.desktop.previews;
});

test("home-shell source refreshes rows and preserves its request-specific result", async () => {
  const source = createAppSource();
  mock.sidebarCommand.mockResolvedValueOnce({ terminalId: "home-created" });
  mock.workspace.mockResolvedValue({
    repositories: [],
    terminals: [{ ...agent("home-created"), kind: "shell", home: true }],
  });
  await expect(source.sidebarCommand?.({ kind: "home-shell" })).resolves.toEqual({
    terminalId: "home-created",
  });
  expect(source.getSnapshot().some((row) => row.id === "home-created")).toBe(true);
});

test.each([false, true])(
  "saved expansion waits for successful sidebar inventory after workspace loads (initial failure: %s)",
  async (fails) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
    const expanded = {
      "repository:/repo": false,
      "worktree:/repo/topic": false,
      "repository:/removed": false,
      "worktree:/removed/topic": true,
    };
    saveLayout(localStorage, { ...initialLayout(), sidebarExpanded: expanded });
    const saved = () => restoreLayout(localStorage.getItem(TILE_STORAGE)).sidebarExpanded;
    mock.workspace.mockResolvedValue({
      repositories: [{ path: "/repo", name: "Repo" }],
      terminals: [],
    });
    const initial =
      Promise.withResolvers<Awaited<ReturnType<typeof window.desktop.sidebarInventory>>>();
    mock.sidebarInventory.mockReturnValueOnce(initial.promise);
    const source = createAppSource();
    const view = render(<Board source={source} />);
    try {
      await settle();
      expect(source.isReady?.()).toBe(true);
      expect(source.isSidebarReady?.()).toBe(false);
      expect(saved()).toEqual(expanded);
      let inventory = initial;
      if (fails) {
        initial.reject(new Error("fixture inventory unavailable"));
        await settle();
        expect(source.isSidebarReady?.()).toBe(false);
        expect(saved()).toEqual(expanded);
        inventory =
          Promise.withResolvers<Awaited<ReturnType<typeof window.desktop.sidebarInventory>>>();
        mock.sidebarInventory.mockReturnValueOnce(inventory.promise);
        mock.changed?.();
        await settle();
        expect(saved()).toEqual(expanded);
      }
      const checkout = (path: string, branch: string) => ({
        path,
        branch,
        head: "abc",
        bare: false,
        locked: false,
        prunable: false,
        managed: false,
      });
      const main = checkout("/repo", "main");
      inventory.resolve({
        repositories: [
          { path: "/repo", name: "Repo", worktrees: [main, checkout("/repo/topic", "topic")] },
        ],
        shell: "bash",
      });
      await settle();
      expect(source.isSidebarReady?.()).toBe(true);
      expect(saved()).toEqual({
        "repository:/repo": false,
        "worktree:/repo/topic": false,
      });
      fireEvent.click(view.getByRole("button", { name: "Expand Repo" }));
      expect(view.getByRole("button", { name: "Expand topic" })).toBeTruthy();
      mock.sidebarInventory.mockResolvedValue({
        repositories: [{ path: "/repo", name: "Repo", worktrees: [main] }],
        shell: "bash",
      });
      mock.changed?.();
      await settle();
      expect(saved()).toEqual({ "repository:/repo": true });
    } finally {
      view.unmount();
      mock.sidebarInventory.mockResolvedValue({ repositories: [], shell: "bash" });
      vi.unstubAllGlobals();
    }
  },
);

test("remote host failures make sessions dormant without calling their worktrees removed and recover on a fresh inventory", async () => {
  const remote = {
    ...agent("remote", verdict("remote")),
    branch: "topic · worker",
    placement: { kind: "remote" as const, host: "worker" },
  };
  const loose = {
    ...agent("loose"),
    repository: "/home/fixture",
    worktree: "/home/fixture",
    branch: null,
    home: true,
    machine: true,
  };
  mock.workspace.mockResolvedValue({
    repositories: [{ path: "/code/app", name: "app" }],
    terminals: [remote, loose],
  });
  mock.sidebarInventory.mockResolvedValue({
    repositories: [{ path: "/code/app", name: "app", worktrees: [] }],
    shell: "bash",
    machines: [{ host: "worker", name: "worker", available: false, agents: [] }],
  });
  const source = createAppSource();
  const disconnect = source.connect?.();
  await settle();
  expect(source.getMachines?.()).toEqual([
    { host: "worker", name: "worker", available: false, agents: [] },
  ]);
  expect(source.getSnapshot().find((row) => row.id === "remote")).toMatchObject({
    branch: "topic",
    dormant: true,
    unavailable: true,
    state: "needs_input",
    worktreeRemoved: false,
  });
  expect(source.getSnapshot().find((row) => row.id === "loose")).toMatchObject({
    home: true,
    machine: true,
    branch: "~",
  });
  mock.state?.(verdict("remote", 200));
  expect(source.getSnapshot().find((row) => row.id === "remote")?.reason).toBe("Unavailable");
  mock.sidebarInventory.mockResolvedValue({
    repositories: [
      {
        path: "/code/app",
        name: "app",
        worktrees: [
          {
            host: "worker",
            path: remote.worktree,
            branch: "topic",
            head: null,
            bare: false,
            locked: false,
            prunable: false,
            managed: false,
          },
        ],
      },
    ],
    shell: "bash",
    machines: [{ host: "worker", name: "worker", available: true, agents: [] }],
  });
  mock.changed?.();
  await settle();
  expect(source.getSnapshot().find((row) => row.id === "remote")).toMatchObject({
    branch: "topic",
    dormant: false,
    unavailable: false,
    state: "needs_input",
    worktreeRemoved: false,
  });
  disconnect?.();
});

test("machine inventory changes preserve the focused terminal DOM and never reopen or refocus its view", async () => {
  const input = document.createElement("textarea");
  input.className = "xterm-helper-textarea";
  mock.mount.mockImplementationOnce((element: HTMLElement) => {
    element.append(input);
  });
  mock.workspace.mockResolvedValue({ repositories: [], terminals: [agent("a")] });
  const source = createAppSource();
  const view = render(<Board source={source} />);
  await settle();
  const row = view.container.querySelector<HTMLElement>('[data-drag-session="a"]');
  if (!row) throw new Error("Missing session row");
  fireEvent.click(row);
  await settle();
  expect(input.isConnected).toBe(true);
  input.focus();
  const opened = mock.open.mock.calls.length;
  const mounted = mock.mount.mock.calls.length;
  const focused = mock.focus.mock.calls.length;
  const hidden = mock.hide.mock.calls.length;
  for (const agents of [[], [{ id: "claude", name: "Claude Code" }], []]) {
    mock.sidebarInventory.mockResolvedValue({
      repositories: [],
      shell: "bash",
      machines: [
        { host: null, name: "localhost", available: true, agents: [] },
        { host: "worker", name: "Builder", available: true, agents },
      ],
    });
    act(() => {
      mock.changed?.();
    });
    await settle();
    expect(view.getByRole("button", { name: "Actions for Builder" })).toBeTruthy();
    expect(view.container.querySelector(".xterm-helper-textarea")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(mock.open).toHaveBeenCalledTimes(opened);
    expect(mock.mount).toHaveBeenCalledTimes(mounted);
    expect(mock.focus).toHaveBeenCalledTimes(focused);
    expect(mock.hide).toHaveBeenCalledTimes(hidden);
  }
});

test("launch presentation follows only its operation and releases its listener after inventory refresh", async () => {
  const source = createAppSource();
  let notify: (id: string) => void = () => {};
  const off = vi.fn();
  window.desktop.onSidebarLaunchStarted = (listener) => {
    notify = listener;
    return off;
  };
  const cancel = vi.fn(() => Promise.resolve());
  window.desktop.cancelSidebarLaunch = cancel;
  const result = Promise.withResolvers<{ terminalId: string }>();
  mock.sidebarCommand.mockReturnValueOnce(result.promise);
  const started = vi.fn();
  const pending = source.sidebarCommand?.(
    { kind: "machine-launch", host: "worker", run: "shell" },
    { id: "launch_one", started },
  );
  notify("launch_other");
  expect(started).not.toHaveBeenCalled();
  notify("launch_one");
  expect(started).toHaveBeenCalledOnce();
  expect(off).not.toHaveBeenCalled();
  result.resolve({ terminalId: "created" });
  await expect(pending).resolves.toEqual({ terminalId: "created" });
  expect(off).toHaveBeenCalledOnce();
  await source.cancelSidebarLaunch?.("launch_one");
  expect(cancel).toHaveBeenCalledWith("launch_one");
  await source.discardStartup?.("created");
  expect(mock.kill).toHaveBeenCalledWith("created");
});
test("preview placement publishes owned display facts without waiting for sidebar inventory", async () => {
  const preview = {
    id: "a".repeat(32),
    repository: "",
    worktree: "/r",
    relativePath: "plan.md",
    kind: "markdown" as const,
    network: false,
  };
  const describe = vi.fn(() => Promise.resolve(preview));
  let place: Parameters<NonNullable<PreviewApi["onPlace"]>>[0] | undefined;
  window.desktop.previews = {
    describe,
    onPlace: (callback) => {
      place = callback;
      return () => {};
    },
    pick: vi.fn(),
    reload: vi.fn(),
    network: vi.fn(),
    popout: vi.fn(),
    close: vi.fn(),
    bounds: vi.fn(),
    painted: vi.fn(),
    cover: vi.fn(),
    onSnapshots: vi.fn(),
  };
  const source = createAppSource();
  const callback = vi.fn(() => {
    expect(source.previews?.getSnapshot()).toEqual([preview]);
    return Promise.resolve("empty" as const);
  });
  const off = source.previews?.onPlace?.(callback);
  const reads = mock.sidebarInventory.mock.calls.length;
  await expect(place?.(preview.id, 100)).resolves.toBe("empty");
  expect(describe).toHaveBeenCalledWith(preview.id);
  expect(callback).toHaveBeenCalledWith(preview.id, 100);
  expect(mock.sidebarInventory).toHaveBeenCalledTimes(reads);
  await expect(place?.(preview.id, 200)).resolves.toBe("empty");
  expect(source.previews?.getSnapshot()).toHaveLength(1);
  off?.();
  // Older/test bridges without the narrow capability retain their inventory path.
  delete window.desktop.previews.describe;
  mock.sidebarInventory.mockResolvedValueOnce({
    repositories: [],
    shell: "bash",
    previews: [preview],
  });
  const fallback = createAppSource();
  const fallbackCallback = vi.fn(() => Promise.resolve("empty" as const));
  fallback.previews?.onPlace?.(fallbackCallback);
  await expect(place?.(preview.id, 300)).resolves.toBe("empty");
  expect(fallback.previews?.getSnapshot()).toEqual([preview]);
  expect(fallbackCallback).toHaveBeenCalledWith(preview.id, 300);
  delete window.desktop.previews;
});

test.each([false, true])(
  "preview placement retains repository associations (cached: %s)",
  async (cached) => {
    const preview = {
      id: "b".repeat(32),
      repository: "/r",
      worktree: "/r",
      relativePath: "plan.md",
      kind: "markdown" as const,
      network: false,
    };
    mock.sidebarInventory.mockResolvedValue({
      shell: "bash",
      repositories: [
        {
          path: "/r",
          name: "Repo",
          worktrees: [
            {
              path: "/r",
              branch: "main",
              head: "abc",
              bare: false,
              locked: false,
              prunable: false,
              managed: false,
            },
          ],
        },
      ],
      previews: cached ? [preview] : [],
    });
    let place: Parameters<NonNullable<PreviewApi["onPlace"]>>[0] | undefined;
    window.desktop.previews = {
      describe: vi.fn(() => Promise.resolve({ ...preview, repository: "", network: true })),
      onPlace: (callback) => {
        place = callback;
        return () => {};
      },
      pick: vi.fn(),
      reload: vi.fn(),
      network: vi.fn(),
      popout: vi.fn(),
      close: vi.fn(),
      bounds: vi.fn(),
      painted: vi.fn(),
      cover: vi.fn(),
      onSnapshots: vi.fn(),
    };
    const source = createAppSource();
    const disconnect = source.connect?.();
    await settle();
    source.previews?.onPlace?.(() => Promise.resolve("empty"));
    await expect(place?.(preview.id, 100)).resolves.toBe("empty");
    expect(source.previews?.getSnapshot()).toEqual([{ ...preview, network: true }]);
    disconnect?.();
    delete window.desktop.previews;
  },
);

test.each(["sidebar command", "worktree create"])(
  "an older inventory from %s cannot prune a preview placed while a newer read is pending",
  async (caller) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
    const preview = {
      id: "c".repeat(32),
      repository: "/code/app",
      worktree: "/code/new",
      relativePath: "notes.md",
      kind: "markdown" as const,
      network: false,
    };
    const oldInventory: SidebarInventory = {
      shell: "bash",
      repositories: [{ path: "/code/app", name: "app", worktrees: [] }],
      previews: [],
    };
    mock.sidebarInventory.mockResolvedValue(oldInventory);
    let place: Parameters<NonNullable<PreviewApi["onPlace"]>>[0] | undefined;
    window.desktop.previews = {
      describe: vi.fn(() => Promise.resolve(preview)),
      onPlace: (callback) => {
        place = callback;
        return () => {};
      },
      pick: vi.fn(),
      reload: vi.fn(),
      network: vi.fn(),
      popout: vi.fn(),
      close: vi.fn(),
      bounds: vi.fn(async () => {}),
      painted: vi.fn(),
      cover: vi.fn(),
      onSnapshots: vi.fn(),
    };
    const source = createAppSource();
    const view = render(<Board source={source} />);
    try {
      await settle();
      const oldRead = Promise.withResolvers<SidebarInventory>();
      const newRead = Promise.withResolvers<SidebarInventory>();
      mock.sidebarInventory.mockReturnValueOnce(oldRead.promise);
      const operation =
        caller === "sidebar command"
          ? source.sidebarCommand?.({ kind: "copy-foom-session-id", id: "session" })
          : source.worktrees?.create("/code/app", "new");
      await settle();
      mock.sidebarInventory.mockReturnValueOnce(newRead.promise);
      act(() => {
        mock.changed?.();
      });
      await settle();
      const placement = place;
      if (!placement) throw new Error("Missing preview placement subscription");
      await act(async () => {
        expect(await placement(preview.id, Date.now() + 5000)).toBe("empty");
      });
      const tile = () => view.container.querySelector(`[data-preview-id="${preview.id}"]`);
      expect(tile()).not.toBeNull();
      await act(async () => {
        oldRead.resolve(oldInventory);
        await operation;
      });
      await settle();
      expect(source.previews?.getSnapshot().map((entry) => entry.id)).toEqual([preview.id]);
      expect(tile()).not.toBeNull();
      newRead.resolve({ ...oldInventory, previews: [preview] });
      await settle();
      expect(source.previews?.getSnapshot()).toEqual([preview]);
      expect(tile()).not.toBeNull();
    } finally {
      view.unmount();
      vi.unstubAllGlobals();
      delete window.desktop.previews;
    }
  },
);

test("Forget and local-only workspace notifications refresh no host inventory", async () => {
  mock.workspace.mockResolvedValue({ repositories: [], terminals: [] });
  const source = createAppSource();
  const off = source.connect?.();
  await settle();
  const reads = mock.sidebarInventory.mock.calls.length;
  mock.changed?.(true);
  await settle();
  expect(mock.sidebarInventory).toHaveBeenCalledTimes(reads);
  await source.sidebarCommand?.({ kind: "forget", id: "offline" });
  expect(mock.sidebarInventory).toHaveBeenCalledTimes(reads);
  expect(mock.sidebarCommand).toHaveBeenCalledWith({ kind: "forget", id: "offline" });
  off?.();
});

test("retained dormant Close recovery rows on removed hosts can still be forgotten", async () => {
  mock.workspace.mockResolvedValue({
    repositories: [],
    terminals: [
      {
        ...agent("offline"),
        remote: true,
        placement: { kind: "remote", host: "removed-host" },
        dormant: true,
        exited: true,
        closeState: "failed",
      },
    ],
  });
  mock.sidebarInventory.mockResolvedValue({ repositories: [], shell: "bash", machines: [] });
  const source = createAppSource();
  const off = source.connect?.();
  await settle();
  expect(source.getSnapshot().find((row) => row.id === "offline")).toMatchObject({
    dormant: true,
    unavailable: true,
    closeFailed: true,
    worktreeRemoved: false,
  });
  off?.();
});
