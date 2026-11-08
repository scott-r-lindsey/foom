// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createSampleSource } from "../../../../src/renderer/board/sample-board-source";
import { useBoardTiles } from "../../../../src/renderer/board/use-board-tiles";
import {
  initialLayout,
  leaves,
  placeSession,
  restoreLayout,
  saveLayout,
  sessionId,
  splitTile,
} from "../../../../src/renderer/board/tiles";

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

function board() {
  const key = "startup-persistence";
  saveLayout(localStorage, { ...initialLayout(), sidebarWidth: 300 }, key);
  const source = { ...createSampleSource([]), isReady: () => false };
  const view = renderHook(() =>
    useBoardTiles({
      source,
      soundSetup: undefined,
      rows: [],
      previews: [],
      storageKey: key,
      setArrivals: vi.fn(),
      setRemoveError: vi.fn(),
    }),
  );
  const pending = placeSession(view.result.current.layout, "launch_test", false, { columns: 220 });
  if (!pending) throw new Error("Missing placement");
  act(() => {
    view.result.current.changeLayout(pending);
  });
  const saved = () => restoreLayout(localStorage.getItem(key));
  return { ...view, pending, saved, key };
}

test.each([false, true])(
  "Close removes reservation-only geometry from later saves (failed=%s)",
  (failed) => {
    const view = board();
    if (failed)
      act(() => {
        view.result.current.failStartup("launch_test");
      });
    expect(leaves(view.saved().tree)).toHaveLength(1);
    const reserved = leaves(view.pending.tree).find((tile) => sessionId(tile) === "launch_test");
    if (!reserved) throw new Error("Missing reserved tile");
    act(() => {
      view.result.current.tileAction(reserved.id, "hide");
    });
    expect(leaves(view.saved().tree)).toHaveLength(1);
    expect(leaves(view.result.current.layout.tree)).toHaveLength(1);
    act(() => {
      view.result.current.changeLayout({ ...view.result.current.layout, sidebarWidth: 410 });
    });
    expect(leaves(view.saved().tree)).toHaveLength(1);
    expect(view.saved().sidebarWidth).toBe(410);
    expect(localStorage.getItem(view.key)).not.toContain("launch_");
  },
);

test.each(["vertical", "left"] as const)(
  "a pending launch saves a %s split and sidebar changes before it settles",
  (direction) => {
    const view = board();
    const edited = {
      ...splitTile(view.result.current.layout, direction),
      sidebarWidth: 410,
      sidebarCollapsed: true,
    };
    expect(leaves(edited.tree)).toHaveLength(3);
    act(() => {
      view.result.current.changeLayout(edited);
    });
    expect(leaves(view.saved().tree)).toHaveLength(3);
    expect(view.saved().sidebarWidth).toBe(410);
    expect(view.saved().sidebarCollapsed).toBe(true);
    expect(localStorage.getItem(view.key)).not.toContain("launch_");
  },
);

test("sidebar-only changes save during startup without adopting its temporary column", () => {
  const view = board();
  act(() => {
    view.result.current.changeLayout({
      ...view.result.current.layout,
      sidebarWidth: 410,
      sidebarCollapsed: true,
    });
  });
  expect(leaves(view.saved().tree)).toHaveLength(1);
  expect(view.saved()).toMatchObject({ sidebarWidth: 410, sidebarCollapsed: true });
});

test("a real terminal can complete beside a pending launch and survives its cancellation", () => {
  const view = board();
  const empty = leaves(view.result.current.layout.tree).find((tile) => !tile.content);
  if (!empty) throw new Error("Missing empty tile");
  const next = placeSession(
    { ...view.result.current.layout, focused: empty.id },
    "launch_second",
    true,
  );
  if (!next) throw new Error("Missing second placement");
  act(() => {
    view.result.current.changeLayout(next);
  });
  act(() => {
    view.result.current.completeStartup("launch_second", "real-terminal");
  });
  expect(leaves(view.saved().tree).map(sessionId)).toEqual(["real-terminal"]);
  const first = leaves(view.result.current.layout.tree).find(
    (tile) => sessionId(tile) === "launch_test",
  );
  if (!first) throw new Error("Missing first startup");
  act(() => {
    view.result.current.tileAction(first.id, "hide");
  });
  expect(leaves(view.saved().tree).map(sessionId)).toEqual(["real-terminal"]);
});

test("adopted geometry survives another launch completing, failure and Close", () => {
  const view = board();
  const edited = splitTile(view.result.current.layout, "vertical");
  act(() => {
    view.result.current.changeLayout(edited);
  });
  if (!edited.landing) throw new Error("Missing split space");
  const second = placeSession({ ...edited, focused: edited.landing }, "launch_second", true);
  if (!second) throw new Error("Missing second placement");
  act(() => {
    view.result.current.changeLayout(second);
  });
  act(() => {
    view.result.current.completeStartup("launch_second", "real-terminal");
  });
  act(() => {
    view.result.current.failStartup("launch_test");
  });
  expect(leaves(view.saved().tree)).toHaveLength(3);
  const first = leaves(view.result.current.layout.tree).find(
    (tile) => sessionId(tile) === "launch_test",
  );
  if (!first) throw new Error("Missing first startup");
  act(() => {
    view.result.current.tileAction(first.id, "hide");
  });
  expect(leaves(view.saved().tree)).toHaveLength(3);
  expect(leaves(view.saved().tree).map(sessionId)).toContain("real-terminal");
  expect(localStorage.getItem(view.key)).not.toContain("launch_");
});
