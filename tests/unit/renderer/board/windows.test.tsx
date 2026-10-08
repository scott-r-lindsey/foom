// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { WindowsApi, WindowView } from "../../../../src/shared/windows";
import { Board } from "../../../../src/renderer/board/board-view";
import { createSampleSource } from "../../../../src/renderer/board/sample-board-source";
import { sampleRows } from "../../../../src/renderer/board/sample-rows";
import { TILE_STORAGE, restoreLayout, leaves } from "../../../../src/renderer/board/tiles";
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
  const source = { ...createSampleSource(rows), windows };
  return {
    rows,
    windows,
    source,
    offChanged,
    offRemoved,
    changed: (views: WindowView[]) => changed?.(views),
    removed: (id: string) => removed?.(id),
  };
}
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
    leaves(restoreLayout(localStorage.getItem(`${TILE_STORAGE}.test-window`)).tree)[0]?.session,
  ).toBe(f.rows[0].id);
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Move to new window" }));
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
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Move to new window" }));
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
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Split right" }));
    await Promise.resolve();
  });
  expect(view.container.querySelectorAll(".terminal-tile[data-empty=false]")).toHaveLength(0);
  f.windows.sync.mockRejectedValueOnce(new Error("closed"));
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "One" }));
    await Promise.resolve();
  });
  expect(view.getByRole("alert").textContent).toContain("Unable to reserve");
});
