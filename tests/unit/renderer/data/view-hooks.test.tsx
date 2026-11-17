// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  useSettingsView,
  useHostsView,
  useAgentsView,
  useRepositoriesView,
  useSessionsView,
  useWorktreesView,
  useEnvironmentView,
  useConfigView,
  useFontsView,
  useSoundsView,
  useReadinessView,
  useMachineAgentsView,
  useViewState,
} from "../../../../src/renderer/data/view-hooks";
import type { DataView, DataViewApi, DataViews } from "../../../../src/shared/data-views";
import { DEFAULT_SETTINGS } from "../../../../src/main/setup/settings";
afterEach(cleanup);
function fixture() {
  const data: DataViews = {
    settings: { worktreeRoot: "/root", settings: DEFAULT_SETTINGS },
    hosts: { hosts: [], locations: [] },
    agents: { warning: null, agents: [] },
    repositories: [],
    worktrees: [],
    sessions: [],
    environment: {
      lists: { all: [], claude: [], codex: [], agy: [] },
      windows: false,
      secrets: false,
    },
    config: { folder: "/config", available: true, pending: null, rejected: [] },
    fonts: [],
    sounds: [],
    readiness: { git: "ready", platform: "linux", forges: [] },
  };
  const emit = new Map<DataView, () => void>();
  const pages = new Map<number, () => void>();
  let nextOffset: number | undefined;
  let viewRevision: number | undefined;
  let revision = 1;
  let generation = 1;
  let error = false;
  const off = vi.fn();
  const subscribe = vi.fn();
  const api: DataViewApi = {
    subscribeView(view, params, receive) {
      subscribe(view, params);
      const deliver = () => {
        const base = {
          id: "test",
          view,
          params,
          revision,
          generation,
          ...(viewRevision === undefined ? {} : { viewRevision }),
          ...(nextOffset === undefined ? {} : { nextOffset }),
        };
        receive(error ? { ...base, error: "unavailable" } : { ...base, data: data[view] });
      };
      emit.set(view, deliver);
      pages.set(params.offset ?? 0, deliver);
      return off;
    },
  };
  return {
    source: { views: api },
    emit,
    data,
    off,
    subscribe,
    revision: (value: number) => {
      revision = value;
    },
    generation: (value: number) => {
      generation = value;
    },
    page: (
      offset: number,
      rows: DataViews["repositories"],
      next: number | undefined,
      changeRevision: number,
      publication: number,
    ) => {
      data.repositories = rows;
      nextOffset = next;
      viewRevision = changeRevision;
      revision = publication;
      pages.get(offset)?.();
    },
    fail: (value: boolean) => {
      error = value;
    },
  };
}
test("shares subscriptions, drops stale pushes and preserves unchanged data identity", async () => {
  const f = fixture();
  const read = vi.fn(() => Promise.resolve(f.data.settings));
  const first = renderHook(() => useSettingsView(f.source, read));
  const second = renderHook(() => useSettingsView(f.source, read));
  expect(first.result.current.isPending).toBe(true);
  expect(f.subscribe).toHaveBeenCalledTimes(1);
  act(() => f.emit.get("settings")?.());
  await waitFor(() => {
    expect(first.result.current.isSuccess).toBe(true);
  });
  const initial = first.result.current.data;
  const settings = initial?.settings;
  f.revision(2);
  f.data.settings = { ...f.data.settings };
  act(() => f.emit.get("settings")?.());
  expect(first.result.current.data).toBe(initial);
  expect(first.result.current.data?.settings).toBe(settings);
  f.data.settings = { ...f.data.settings, worktreeRoot: "/new" };
  f.revision(1);
  act(() => f.emit.get("settings")?.());
  f.revision(3);
  f.generation(2);
  act(() => f.emit.get("settings")?.());
  expect(first.result.current.data).toBe(initial);
  f.generation(1);
  act(() => f.emit.get("settings")?.());
  await waitFor(() => {
    expect(first.result.current.data?.worktreeRoot).toBe("/new");
  });
  act(() => {
    first.result.current.setData({ ...f.data.settings, worktreeRoot: "/late-write-reply" });
  });
  expect(first.result.current.data?.worktreeRoot).toBe("/new");
  expect(read).not.toHaveBeenCalled();
  first.unmount();
  expect(f.off).not.toHaveBeenCalled();
  second.unmount();
  expect(f.off).toHaveBeenCalledOnce();
});
test("fixed errors reach query state and a later valid push recovers", async () => {
  const f = fixture();
  const hook = renderHook(() => useHostsView(f.source, () => Promise.resolve(f.data.hosts)));
  f.fail(true);
  act(() => f.emit.get("hosts")?.());
  await waitFor(() => {
    expect(hook.result.current.isError).toBe(true);
  });
  f.fail(false);
  f.revision(2);
  act(() => f.emit.get("hosts")?.());
  await waitFor(() => {
    expect(hook.result.current.isSuccess).toBe(true);
  });
});
test("every named hook uses only its own view and normalized parameters", async () => {
  const f = fixture();
  const otherRender = vi.fn();
  const other = renderHook(() => {
    otherRender();
    return useSettingsView(f.source, () => Promise.resolve(f.data.settings));
  });
  const views = renderHook(() => [
    useAgentsView(f.source, () => Promise.resolve(f.data.agents)),
    useRepositoriesView(f.source, () => Promise.resolve([])),
    useWorktreesView(f.source, "/registered", () => Promise.resolve([])),
    useSessionsView(f.source, () => Promise.resolve([])),
    useEnvironmentView(f.source, () => Promise.resolve(f.data.environment)),
    useConfigView(f.source, () => Promise.resolve(f.data.config)),
    useFontsView(f.source, () => Promise.resolve([])),
    useSoundsView(f.source, () => Promise.resolve([])),
    useReadinessView(f.source, () => Promise.resolve(f.data.readiness), false),
  ]);
  expect(f.subscribe).toHaveBeenCalledWith("agents", { machine: "local" });
  expect(f.subscribe).toHaveBeenCalledWith("worktrees", { repository: "/registered" });
  expect(f.emit.has("readiness")).toBe(false);
  act(() => {
    for (const emit of f.emit.values()) emit();
  });
  await waitFor(() => {
    expect(views.result.current[0]?.isSuccess).toBe(true);
  });
  const count = otherRender.mock.calls.length;
  f.revision(2);
  f.data.config = { ...f.data.config, available: false };
  act(() => f.emit.get("config")?.());
  await waitFor(() => {
    expect(views.result.current[5]?.data).toEqual(f.data.config);
  });
  expect(otherRender).toHaveBeenCalledTimes(count);
  other.unmount();
});
test("legacy fixture readers and editable draft adapters share query state", async () => {
  const source = {};
  const initial = { worktreeRoot: "/root", settings: DEFAULT_SETTINGS };
  const hook = renderHook(() =>
    useViewState(
      useSettingsView(source, () => Promise.resolve(initial)),
      initial,
    ),
  );
  await waitFor(() => {
    expect(hook.result.current[0]).toEqual(initial);
  });
  act(() => {
    hook.result.current[1]((old) => ({ ...old, worktreeRoot: "/changed" }));
  });
  await waitFor(() => {
    expect(hook.result.current[0].worktreeRoot).toBe("/changed");
  });
  act(() => {
    hook.result.current[1](initial);
  });
  await waitFor(() => {
    expect(hook.result.current[0].worktreeRoot).toBe("/root");
  });
});

test("repository pages join one view revision across unrelated publications and release removed pages", async () => {
  const f = fixture();
  const hook = renderHook(() => useRepositoriesView(f.source, () => Promise.resolve([])));
  const a = { path: "/a", name: "a" };
  const b = { path: "/b", name: "b" };
  act(() => {
    f.page(0, [a], 100, 1, 1);
  });
  expect(hook.result.current.data).toBeUndefined();
  expect(f.subscribe).toHaveBeenCalledWith("repositories", { offset: 100, limit: 100 });
  act(() => {
    f.page(100, [b], undefined, 1, 2);
  });
  await waitFor(() => {
    expect(hook.result.current.data).toEqual([a, b]);
  });
  act(() => {
    f.page(0, [b], 100, 3, 3);
  });
  expect(hook.result.current.data).toEqual([a, b]);
  act(() => {
    f.page(100, [a], undefined, 3, 3);
  });
  await waitFor(() => {
    expect(hook.result.current.data).toEqual([b, a]);
  });
  act(() => {
    f.page(0, [a], undefined, 4, 4);
  });
  await waitFor(() => {
    expect(hook.result.current.data).toEqual([a]);
  });
  expect(f.off).toHaveBeenCalledOnce();
  act(() => {
    f.page(100, [b], undefined, 5, 5);
  });
  expect(hook.result.current.data).toEqual([a]);
  f.fail(true);
  act(() => {
    f.page(0, [], undefined, 5, 5);
  });
  await waitFor(() => {
    expect(hook.result.current.isError).toBe(true);
  });
  f.fail(false);
  act(() => {
    f.page(0, [b], undefined, 6, 6);
  });
  await waitFor(() => {
    expect(hook.result.current.data).toEqual([b]);
  });
  act(() => {
    f.page(0, [a], undefined, 5, 5);
  });
  expect(hook.result.current.data).toEqual([b]);
  f.generation(2);
  act(() => {
    f.page(0, [a], undefined, 7, 7);
  });
  expect(hook.result.current.data).toEqual([b]);
  hook.unmount();
  act(() => {
    f.page(0, [a], undefined, 8, 8);
  });
});
test("remote agent views are keyed by registered machine, and active readiness subscribes", () => {
  const f = fixture();
  renderHook(() => [
    useMachineAgentsView(f.source, "host:worker", true),
    useReadinessView(f.source, () => Promise.resolve(f.data.readiness), true),
  ]);
  expect(f.subscribe).toHaveBeenCalledWith("agents", { machine: "host:worker" });
  expect(f.subscribe).toHaveBeenCalledWith("readiness", {});
});

test("live refetch reconnects the shared stream and rejects callbacks from its previous lifetime", async () => {
  const f = fixture();
  const read = vi.fn(() => Promise.resolve(f.data.settings));
  const first = renderHook(() => useSettingsView(f.source, read));
  const second = renderHook(() => useSettingsView(f.source, read));
  const old = f.emit.get("settings");
  act(() => old?.());
  await waitFor(() => {
    expect(first.result.current.isSuccess).toBe(true);
  });
  await act(async () => {
    await first.result.current.refetch();
  });
  expect(f.off).toHaveBeenCalledOnce();
  expect(f.subscribe).toHaveBeenCalledTimes(2);
  f.data.settings = { ...f.data.settings, worktreeRoot: "/fresh" };
  f.generation(2);
  f.revision(2);
  act(() => old?.());
  expect(first.result.current.data?.worktreeRoot).toBe("/root");
  act(() => f.emit.get("settings")?.());
  await waitFor(() => {
    expect(second.result.current.data?.worktreeRoot).toBe("/fresh");
  });
  expect(read).not.toHaveBeenCalled();
  const refetch = first.result.current.refetch;
  first.unmount();
  await refetch();
  expect(f.subscribe).toHaveBeenCalledTimes(2);
  second.unmount();
  expect(f.off).toHaveBeenCalledTimes(2);
  f.data.settings = { ...f.data.settings, worktreeRoot: "/late" };
  act(() => f.emit.get("settings")?.());
});

test("unchanged publications keep Settings consumers from rendering again", async () => {
  const f = fixture();
  const clock = vi.spyOn(Date, "now").mockReturnValue(100);
  let renders = 0;
  try {
    const hook = renderHook(() => {
      renders++;
      return useSettingsView(f.source, () => Promise.resolve(f.data.settings));
    });
    act(() => f.emit.get("settings")?.());
    await waitFor(() => {
      expect(hook.result.current.isSuccess).toBe(true);
    });
    const previous = renders;
    clock.mockReturnValue(200);
    f.revision(2);
    f.data.settings = { ...f.data.settings };
    act(() => f.emit.get("settings")?.());
    expect(renders).toBe(previous);
    clock.mockReturnValue(300);
    f.revision(3);
    f.data.settings = { ...f.data.settings, worktreeRoot: "/changed" };
    act(() => f.emit.get("settings")?.());
    await waitFor(() => {
      expect(hook.result.current.data?.worktreeRoot).toBe("/changed");
    });
    expect(renders).toBeGreaterThan(previous);
  } finally {
    clock.mockRestore();
  }
});
