import { CustomThemeHint } from "../../../../src/renderer/preflight/custom-theme-hint";
import type { LaunchOptions } from "../../../../src/renderer/board/board-source.d";
import type { BoardCommand } from "../../../../src/shared/board-command";
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { WindowsApi, WindowView } from "../../../../src/shared/windows";
import { Board } from "../../../../src/renderer/board/board-view";
import { createSampleSource } from "../../../../src/renderer/board/sample-board-source";
import { boardRows as sampleRows } from "../../../fixtures/board";
import {
  TILE_STORAGE,
  restoreLayout,
  leaves,
  loadLayout,
  splitTile,
  initialLayout,
  saveLayout,
  placeSession,
} from "../../../../src/renderer/board/tiles";
afterEach(() => {
  cleanup();
  localStorage.clear();
});
function fixture(initialSession?: string) {
  const rows = sampleRows(0);
  let changed: ((views: WindowView[]) => void) | undefined;
  let removed: ((id: string) => void) | undefined;
  const offChanged = vi.fn(),
    offRemoved = vi.fn();
  const windows = {
    id: "test-window",
    number: 0,
    initialSession,
    sync: vi.fn((ids: string[]) => Promise.resolve(ids)),
    select: vi.fn(() => Promise.resolve(true)),
    snapshot: vi.fn(() => Promise.resolve([{ id: rows[0]?.id ?? "", window: 2 }])),
    popout: vi.fn(() => Promise.resolve()),
    onChanged: (callback: (views: WindowView[]) => void) => {
      changed = callback;
      return offChanged;
    },
    onRemoved: (callback: (id: string) => void) => {
      removed = callback;
      return offRemoved;
    },
  } satisfies WindowsApi;
  let command: ((command: BoardCommand) => void) | undefined;
  const source = {
    ...createSampleSource(rows),
    windows,
    subscribeCommands: (listener: (command: BoardCommand) => void) => {
      command = listener;
      return () => {};
    },
  };
  return {
    command: (value: BoardCommand) => {
      act(() => command?.(value));
    },
    rows,
    windows,
    source,
    offChanged,
    offRemoved,
    changed: (views: WindowView[]) => changed?.(views),
    removed: (id: string) => removed?.(id),
  };
}
test("audio focus failures leave terminal selection usable and later focus updates recover", async () => {
  const f = fixture();
  f.source.update("permission", { kind: "agent" });
  const focus = vi
    .fn<(id: string | null) => Promise<void>>()
    .mockRejectedValueOnce(new Error("Audio bridge unavailable"))
    .mockResolvedValue(undefined);
  const source = {
    ...f.source,
    windows: {
      ...f.windows,
      audio: {
        state: () => Promise.resolve({ enabled: false, focusedId: null }),
        focus,
        refuse: () => Promise.resolve(),
        onChanged: () => () => {},
        onRefuse: () => () => {},
      },
    },
  };
  const view = render(<Board source={source} />);
  await act(async () => {});
  expect(focus).toHaveBeenCalledWith(null);
  const row = view.container.querySelector<HTMLButtonElement>(".board-row");
  if (!row || !f.rows[0]) throw new Error("Missing row");
  await act(async () => {
    fireEvent.click(row);
    await Promise.resolve();
  });
  expect(view.container.querySelectorAll(".terminal-tile[data-empty=false]")).toHaveLength(1);
  expect(focus).toHaveBeenLastCalledWith(f.rows[0].id);
  view.rerender(<Board source={source} settingsView={<div>Settings</div>} />);
  await act(async () => {});
  expect(focus).toHaveBeenLastCalledWith(null);
});
test("foreign selection focuses its owner while local selection persists a per-window layout", async () => {
  const f = fixture();
  const view = render(<Board source={f.source} />);
  await waitFor(() => {
    expect(view.getByLabelText("Shown in another window")).toBeTruthy();
  });
  const row = view.container.querySelector<HTMLButtonElement>(".board-row");
  if (!row || !f.rows[0]) throw new Error("Missing row");
  f.windows.select.mockResolvedValueOnce(false);
  await act(async () => {
    fireEvent.click(row);
    await Promise.resolve();
  });
  expect(view.container.querySelectorAll(".terminal-tile[data-empty=false]")).toHaveLength(0);
  await act(async () => {
    fireEvent.click(row);
    await Promise.resolve();
  });
  expect(view.container.querySelectorAll(".terminal-tile[data-empty=false]")).toHaveLength(1);
  expect(localStorage.getItem(TILE_STORAGE)).toBeNull();
  expect(
    leaves(restoreLayout(localStorage.getItem(`${TILE_STORAGE}.test-window`)).tree)[0]?.content,
  ).toEqual({ kind: "terminal", session: f.rows[0].id });
  fireEvent.click(view.getByRole("button", { name: "Tile 1 menu" }));
  await act(async () => {
    fireEvent.click(view.getByRole("menuitem", { name: "Move to new window" }));
    await Promise.resolve();
  });
  expect(f.windows.popout).toHaveBeenCalledWith(f.rows[0].id);
  act(() => {
    f.removed(f.rows[0]?.id ?? "");
    f.changed([]);
  });
  expect(view.container.querySelectorAll(".terminal-tile[data-empty=false]")).toHaveLength(0);
  expect(view.queryByLabelText("Shown in another window")).toBeNull();
  view.unmount();
  expect(f.offChanged).toHaveBeenCalledOnce();
  expect(f.offRemoved).toHaveBeenCalledOnce();
});
test("opens the popout's initial session once inventory arrives and reports operation failures", async () => {
  const id = sampleRows(0)[0]?.id;
  const f = fixture(id);
  f.windows.snapshot.mockRejectedValueOnce(new Error("gone"));
  const view = render(<Board source={f.source} />);
  await waitFor(() => {
    expect(view.container.querySelectorAll(".terminal-tile[data-empty=false]")).toHaveLength(1);
  });
  expect(f.windows.select).toHaveBeenCalledOnce();
  f.windows.popout.mockRejectedValueOnce(new Error("load failed"));
  fireEvent.click(view.getByRole("button", { name: "Tile 1 menu" }));
  await act(async () => {
    fireEvent.click(view.getByRole("menuitem", { name: "Move to new window" }));
    await Promise.resolve();
  });
  expect(view.getByRole("alert").textContent).toContain("Unable to move");
  f.windows.select.mockRejectedValueOnce(new Error("closed"));
  const row = view.container.querySelector(".board-row");
  if (!row) throw new Error("Missing row");
  await act(async () => {
    fireEvent.click(row);
    await Promise.resolve();
  });
  expect(view.getByRole("alert").textContent).toContain("Unable to select");
  f.windows.sync.mockResolvedValueOnce([]);
  fireEvent.click(view.getByRole("button", { name: "Tile 1 menu" }));
  await act(async () => {
    fireEvent.click(view.getByRole("menuitem", { name: "Split terminal right" }));
    await Promise.resolve();
  });
  expect(view.container.querySelectorAll(".terminal-tile[data-empty=false]")).toHaveLength(0);
  f.windows.sync.mockRejectedValueOnce(new Error("closed"));
  await act(async () => {
    f.command("split-right");
    await Promise.resolve();
  });
  expect(view.getByText("Unable to reserve terminal views.").textContent).toContain(
    "Unable to reserve",
  );
});

test("existing profiles migrate their split layout once, without copying it into later windows", () => {
  const original = splitTile(initialLayout(), "vertical");
  saveLayout(localStorage, original);
  expect(loadLayout(localStorage, `${TILE_STORAGE}.first`)).toEqual(original);
  expect(localStorage.getItem(TILE_STORAGE)).toBeNull();
  expect(loadLayout(localStorage, `${TILE_STORAGE}.first`)).toEqual(original);
  expect(leaves(loadLayout(localStorage, `${TILE_STORAGE}.second`).tree)).toHaveLength(1);
  expect(leaves(loadLayout(localStorage).tree)).toHaveLength(1);
});

test("foreign-window navigation focuses an existing tile without replacing either session", async () => {
  const f = fixture();
  const a = f.rows[0],
    b = f.rows[1];
  if (!a || !b) throw new Error("Missing sessions");
  const first = placeSession(initialLayout(), a.id);
  if (!first) throw new Error("Missing first tile");
  const layout = placeSession(splitTile(first, "horizontal"), b.id);
  if (!layout) throw new Error("Missing second tile");
  saveLayout(localStorage, layout, `${TILE_STORAGE}.test-window`);
  let navigate: ((id: string) => void) | undefined;
  const source = {
    ...f.source,
    appMenu: {
      platform: "darwin" as const,
      legal: vi.fn(),
      onLegal: vi.fn(),
      version: vi.fn(),
      setView: vi.fn(() => Promise.resolve()),
      commands: vi.fn(() => Promise.resolve([])),
      shortcuts: vi.fn(() => Promise.resolve([])),
      onShortcuts: () => () => {},
      execute: vi.fn(() => Promise.resolve()),
      onOpen: () => () => {},
      onSession: (callback: (id: string) => void) => {
        navigate = callback;
        return () => {};
      },
    },
  };
  const view = render(<Board source={source} />);
  await act(async () => {
    navigate?.(a.id);
    await Promise.resolve();
  });
  const saved = loadLayout(localStorage, `${TILE_STORAGE}.test-window`);
  expect(saved.tree).toEqual(layout.tree);
  expect(saved.focused).toBe(leaves(layout.tree)[0]?.id);
  expect(view.container.querySelectorAll(".terminal-tile[data-empty=false]")).toHaveLength(2);
});

test("terminal state updates do not reconcile an unchanged view layout", async () => {
  const id = sampleRows(0)[0]?.id;
  if (!id) throw new Error("Missing session");
  const f = fixture(id);
  render(<Board source={f.source} />);
  await waitFor(() => {
    expect(f.windows.sync).toHaveBeenCalledWith([id]);
  });
  f.windows.sync.mockClear();
  await act(async () => {
    f.source.update(id, { state: "working", reason: "New output" });
    await Promise.resolve();
  });
  expect(f.windows.sync).not.toHaveBeenCalled();
});

test("a cancelled config menu launch preserves the full layout and focus", async () => {
  const f = fixture();
  const a = f.rows[0],
    b = f.rows[1];
  if (!a || !b) throw new Error("Missing sessions");
  f.source.update(a.id, { config: true });
  const first = placeSession(initialLayout(), a.id);
  if (!first) throw new Error("Missing first tile");
  const layout = placeSession(splitTile(first, "horizontal"), b.id);
  if (!layout) throw new Error("Missing second tile");
  saveLayout(localStorage, layout, `${TILE_STORAGE}.test-window`);
  let command: ((command: BoardCommand) => void) | undefined;
  const source = {
    ...f.source,
    sidebarCommand: vi.fn(() => Promise.resolve()),
    subscribeCommands: (listener: (command: BoardCommand) => void) => {
      command = listener;
      return () => {
        command = undefined;
      };
    },
  };
  render(<Board source={source} />);
  await act(async () => {
    command?.("via-claude");
    await Promise.resolve();
  });
  expect(source.sidebarCommand).toHaveBeenCalledWith({
    kind: "config-launch",
    run: "claude",
  });
  const saved = loadLayout(localStorage, `${TILE_STORAGE}.test-window`);
  expect(saved.tree).toEqual(layout.tree);
  expect(saved.focused).toBe(layout.focused);
});

test("sidebar collapse saves per window with tile changes and survives remount", async () => {
  const f = fixture();
  const first = render(<Board source={f.source} />);
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.click(first.getByRole("button", { name: "Collapse sidebar" }));
  expect(loadLayout(localStorage, `${TILE_STORAGE}.test-window`).sidebarCollapsed).toBe(true);
  const second = render(
    <Board source={{ ...f.source, windows: { ...f.windows, id: "second" } }} />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(second.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy();
  second.unmount();
  first.unmount();
  const restored = render(<Board source={f.source} />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(restored.getByRole("button", { name: "Expand sidebar" })).toBeTruthy();
  f.command("split-right");
  expect(loadLayout(localStorage, `${TILE_STORAGE}.test-window`).sidebarCollapsed).toBe(true);
});

test("launch menus follow catalog publications and discard stale loads", async () => {
  const f = fixture();
  const base: LaunchOptions = {
    repositories: [],
    agents: [],
    enabled: {},
    hooks: false,
  };
  let changed: (() => void) | undefined;
  const off = vi.fn();
  const load = vi.fn<() => Promise<LaunchOptions>>().mockResolvedValue({ ...base, agents: [] });
  const source = {
    ...f.source,
    worktrees: {
      addRepository: () => Promise.resolve(null),
      branches: () =>
        Promise.resolve({ head: "main", local: [], remote: null, remoteBranches: [] }),
      create: () => Promise.reject(new Error("Unused fixture creation")),
      remove: () => Promise.resolve(false),
      load,
      subscribe: (listener: () => void) => {
        changed = listener;
        return off;
      },
    },
  };
  const view = render(<Board source={source} />);
  await act(async () => {});
  fireEvent.click(view.container.querySelector(".config-gear") ?? document.body);
  expect(view.queryByRole("menuitem", { name: /^Via FixtureCode$/ })).toBeNull();
  let old: ((value: LaunchOptions) => void) | undefined;
  load.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        old = resolve;
      }),
  );
  act(() => changed?.());
  load.mockResolvedValue({
    ...base,
    agents: [
      {
        id: "fixturecode",
        name: "FixtureCode",
        path: "/fixture/fixturecode",
        version: "1",
        hooks: false,
        reason: "",
      },
    ],
  });
  await act(async () => {
    changed?.();
    await Promise.resolve();
  });
  expect(view.getByRole("menuitem", { name: /^Via FixtureCode$/ })).toBeTruthy();
  await act(async () => {
    old?.({ ...base, agents: [] });
    await Promise.resolve();
  });
  expect(view.getByRole("menuitem", { name: /^Via FixtureCode$/ })).toBeTruthy();
  view.unmount();
  expect(off).toHaveBeenCalledOnce();
});

test("a Settings custom-theme hint opens the same config panel as the gear", async () => {
  const { source } = fixture();
  const view = render(<Board source={source} settingsView={<CustomThemeHint />} />);
  await act(async () => {});
  const hint = view.getByRole("button", { name: "config agent" });
  fireEvent.click(hint);
  expect(view.getByRole("dialog", { name: "Foom config details and commands" })).toBeTruthy();
});

test("existing window layouts migrate shared expansion once and new windows use defaults", () => {
  const legacy = { "repository:/a": false, "worktree:/a": true };
  saveLayout(localStorage, initialLayout(), `${TILE_STORAGE}.existing`);
  const migrated = loadLayout(localStorage, `${TILE_STORAGE}.existing`, legacy);
  expect(migrated.sidebarExpanded).toEqual(legacy);
  expect(
    loadLayout(localStorage, `${TILE_STORAGE}.existing`, { "repository:/a": true }).sidebarExpanded,
  ).toEqual(legacy);
  expect(loadLayout(localStorage, `${TILE_STORAGE}.new`, legacy).sidebarExpanded).toEqual({});
  expect(loadLayout(localStorage, `${TILE_STORAGE}.new`, legacy).sidebarExpanded).toEqual({});
});

test("restored blank windows inherit legacy expansion even without saved tiles", () => {
  const legacy = { "repository:/a": false };
  expect(loadLayout(localStorage, `${TILE_STORAGE}.blank`, legacy, true).sidebarExpanded).toEqual(
    legacy,
  );
  expect(loadLayout(localStorage, `${TILE_STORAGE}.blank`, {}, true).sidebarExpanded).toEqual(
    legacy,
  );
  expect(loadLayout(localStorage, `${TILE_STORAGE}.new`, legacy, false).sidebarExpanded).toEqual(
    {},
  );
});
