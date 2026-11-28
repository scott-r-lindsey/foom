// @vitest-environment jsdom
import { act, fireEvent } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { BoardSource } from "../../../../src/renderer/board/board-source.d";
import type { PreviewApi } from "../../../../src/shared/previews";
import type { WindowsApi, MoveContent, MovePlacement } from "../../../../src/shared/windows";
import { boardRows } from "../../../fixtures/board";
import { registerTileAreaFixture, setup } from "./tile-area-fixture";
registerTileAreaFixture();

function fixture(withPreview = false, overrides: Partial<BoardSource> = {}) {
  let place: Parameters<NonNullable<PreviewApi["onPlace"]>>[0] | undefined;
  let drag: ((token: string | null) => void) | undefined;
  let prepare: ((request: string, at: MovePlacement) => void) | undefined;
  let finish: ((request: string, content: MoveContent | null) => void) | undefined;
  const moves = {
    list: vi.fn(() =>
      Promise.resolve([
        { id: 2, label: "Lovelace", repositories: ["<foom>", "example"] },
        { id: 3, label: "Shannon", repositories: [] },
      ]),
    ),
    reportRepositories: vi.fn(async () => {}),
    beginDrag: vi.fn(() => Promise.resolve("token")),
    endDrag: vi.fn(async () => {}),
    drop: vi.fn(async () => {}),
    move: vi.fn(async () => {}),
    ready: vi.fn(async () => {}),
    onDrag: (callback: typeof drag) => {
      drag = callback;
      return () => {
        drag = undefined;
      };
    },
    onPrepare: (callback: typeof prepare) => {
      prepare = callback;
      return () => {
        prepare = undefined;
      };
    },
    onFinish: (callback: typeof finish) => {
      finish = callback;
      return () => {
        finish = undefined;
      };
    },
  };
  const windows: WindowsApi = {
    moves,
    id: "test",
    number: 1,
    initialSession: undefined,
    sync: (ids) => Promise.resolve(ids),
    select: () => Promise.resolve(true),
    popout: async () => {},
    snapshot: () => Promise.resolve([]),
    onChanged: () => () => {},
    onRemoved: () => () => {},
  };
  const preview = {
    id: "p",
    repository: "foom",
    worktree: "foom/fix/session-restore",
    relativePath: "docs/plan.md",
    kind: "markdown" as const,
    network: false,
  };
  const previewRows = [preview];
  const f = setup(
    {},
    {
      windows,
      ...(withPreview
        ? {
            previews: {
              getSnapshot: () => previewRows,
              onPlace: (callback) => {
                place = callback;
                return () => {
                  place = undefined;
                };
              },
              pick: () => Promise.resolve(null),
              close: () => Promise.resolve(),
              bounds: () => Promise.resolve(),
            },
          }
        : {}),
      ...overrides,
    },
  );
  const tile = () => {
    const tile = f.screen.container.querySelector<HTMLElement>(".terminal-tile");
    if (!tile) throw new Error("tile");
    vi.spyOn(tile, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      x: 0,
      y: 0,
      right: 100,
      bottom: 100,
      toJSON: () => ({}),
    });
    return tile;
  };
  vi.stubGlobal("DragEvent", MouseEvent);
  return {
    ...f,
    place: (id: string) => place?.(id, Number.MAX_SAFE_INTEGER) ?? Promise.resolve("sidebar"),
    moves,
    tile,
    drag: (token: string | null) => {
      act(() => {
        drag?.(token);
      });
    },
    prepare: (request: string, at: MovePlacement) => {
      act(() => {
        prepare?.(request, at);
      });
    },
    finish: (request: string, content: MoveContent | null) => {
      act(() => {
        finish?.(request, content);
      });
    },
  };
}
const transfer = () => ({
  setData: vi.fn(),
  getData: () => {
    throw new Error("external payload read");
  },
  effectAllowed: "",
  dropEffect: "",
});

test("foreign drops use only main's token and clear highlights when the gesture ends", async () => {
  const f = fixture();
  const target = f.tile();
  const dataTransfer = transfer();
  fireEvent.dragOver(target, { dataTransfer, clientX: 50, clientY: 50 });
  expect(f.screen.container.querySelector(".tile-drop-preview")).toBeNull();
  f.drag("opaque");
  fireEvent.dragOver(target, { dataTransfer, clientX: 50, clientY: 50 });
  expect(f.screen.getByText("Place here")).toBeTruthy();
  fireEvent.drop(target, { dataTransfer, clientX: 50, clientY: 50 });
  expect(f.moves.drop).toHaveBeenCalledExactlyOnceWith("opaque", {
    tile: target.dataset["tile"],
    zone: "center",
  });
  f.drag(null);
  expect(f.screen.container.querySelector(".tile-drop-preview")).toBeNull();
  f.moves.drop.mockRejectedValueOnce(new Error("expired"));
  f.drag("expired");
  fireEvent.drop(target, { dataTransfer, clientX: 50, clientY: 50 });
  await act(async () => {});
});

test("local gestures register identity, cancel after a slow reply, and revoke on Escape or unmount", async () => {
  const f = fixture();
  f.click(0);
  await act(async () => {});
  const title = f.screen.container.querySelector(".tile-title");
  if (!title) throw new Error("title");
  const dataTransfer = transfer();
  fireEvent.dragStart(title, { dataTransfer });
  fireEvent.dragEnd(title);
  await act(async () => {});
  expect(f.moves.beginDrag).toHaveBeenCalledWith({ kind: "terminal", id: "permission" });
  expect(f.moves.endDrag).toHaveBeenCalledWith("token");
  fireEvent.dragStart(f.row(0), { dataTransfer });
  await act(async () => {});
  fireEvent.keyDown(title, { key: "Escape" });
  expect(f.moves.endDrag).toHaveBeenCalledTimes(2);
  fireEvent.dragStart(title, { dataTransfer });
  await act(async () => {});
  f.screen.unmount();
  expect(f.moves.endDrag).toHaveBeenCalledTimes(3);
});

test("prepared placement locks the tree until commit or refusal and ignores stale replies", async () => {
  const f = fixture();
  const id = f.tile().dataset["tile"] ?? "";
  f.prepare("request", { tile: id, zone: "center" });
  expect(f.moves.ready).toHaveBeenLastCalledWith("request", true);
  f.send("split-right");
  expect(f.screen.container.querySelectorAll(".terminal-tile")).toHaveLength(1);
  f.prepare("second", null);
  expect(f.moves.ready).toHaveBeenLastCalledWith("second", false);
  f.finish("stale", { kind: "terminal", id: "permission" });
  expect(f.screen.container.querySelector('[data-empty="false"]')).toBeNull();
  f.finish("request", { kind: "terminal", id: "permission" });
  expect(f.screen.container.querySelector('[data-empty="false"]')).toBeTruthy();
  f.prepare("refused", null);
  f.finish("refused", null);
  expect(f.screen.container.querySelectorAll('[data-empty="false"]')).toHaveLength(1);
  f.moves.ready.mockRejectedValueOnce(new Error("request gone"));
  f.prepare("gone", null);
  await act(async () => {});
  expect(f.screen.container.querySelector(".board-home")?.hasAttribute("inert")).toBe(false);
});

test("Move to window lists stable labels and dispatches the chosen terminal", async () => {
  const f = fixture();
  f.click(0);
  await act(async () => {});
  fireEvent.click(f.screen.getByRole("button", { name: "Tile 1 menu" }));
  await act(async () => {});
  fireEvent.click(f.screen.getByRole("menuitem", { name: "Move to window" }));
  await act(async () => {});
  expect(f.screen.getByRole("menuitem", { name: "Shannon" })).toBeTruthy();
  fireEvent.click(f.screen.getByRole("menuitem", { name: "Lovelace · <foom>, example" }));
  expect(f.moves.move).toHaveBeenCalledExactlyOnceWith({ kind: "terminal", id: "permission" }, 2);
  await act(async () => {});
});

test("a committed replacement discards the previous occupant's window actions", async () => {
  const f = fixture();
  f.click(0);
  await act(async () => {});
  fireEvent.click(f.screen.getByRole("button", { name: "Tile 1 menu" }));
  const open = () => fireEvent.click(f.screen.getByRole("menuitem", { name: "Move to window" }));
  open();
  const destination = await f.screen.findByRole("menuitem", { name: "Shannon" });
  const tile = f.tile().dataset["tile"];
  if (!tile) throw new Error("Missing tile ID");
  f.prepare("replacement", { tile, zone: "center" });
  f.finish("replacement", { kind: "terminal", id: "check" });
  expect(f.screen.queryByRole("menuitem", { name: "Shannon" })).toBeNull();
  expect(destination.isConnected).toBe(false);
  open();
  fireEvent.click(await f.screen.findByRole("menuitem", { name: "Shannon" }));
  expect(f.moves.move).toHaveBeenCalledExactlyOnceWith({ kind: "terminal", id: "check" }, 3);
});

test("repository reports follow occupied terminal tiles and retry on a later layout change", async () => {
  const rows = boardRows(100)
    .slice(0, 2)
    .map((row) => ({ ...row, kind: "agent" as const, managed: true, repositoryPath: "/repo" }));
  const f = fixture(false, { getSnapshot: () => rows });
  expect(f.moves.reportRepositories).toHaveBeenLastCalledWith([]);
  f.moves.reportRepositories.mockRejectedValueOnce(new Error("report failed"));
  f.click(0);
  await act(async () => {});
  expect(f.moves.reportRepositories).toHaveBeenLastCalledWith(["/repo"]);
  fireEvent.click(f.screen.getByRole("button", { name: "Tile 1 menu" }));
  fireEvent.click(f.screen.getByRole("menuitem", { name: /^Maximize/ }));
  await act(async () => {});
  expect(f.moves.reportRepositories.mock.calls).toEqual([[[]], [["/repo"]], [["/repo"]]]);
});

test("preview sidebar and title gestures register only the preview identity", async () => {
  const f = fixture(true);
  const row = f.screen.container.querySelector('[data-drag-preview="p"]');
  if (!row) throw new Error("preview row");
  fireEvent.dragStart(row, { dataTransfer: transfer() });
  await act(async () => {});
  expect(f.moves.beginDrag).toHaveBeenLastCalledWith({ kind: "preview", id: "p" });
  fireEvent.dragEnd(row);
  fireEvent.click(row);
  await act(async () => {});
  expect(f.moves.reportRepositories).toHaveBeenLastCalledWith(["foom"]);
  const title = f.screen.container.querySelector(".tile-title");
  if (!title) throw new Error("preview title");
  fireEvent.dragStart(title, { dataTransfer: transfer() });
  await act(async () => {});
  expect(f.moves.beginDrag).toHaveBeenLastCalledWith({ kind: "preview", id: "p" });
  fireEvent.dragEnd(title);
  f.moves.beginDrag.mockRejectedValueOnce(new Error("stale"));
  fireEvent.dragStart(title, { dataTransfer: transfer() });
  await act(async () => {});
  fireEvent.dragEnd(title);
});

test("a menu move failure reports the operation through the tile's action error", async () => {
  const f = fixture();
  f.click(0);
  await act(async () => {});
  f.moves.move.mockRejectedValueOnce(new Error("closed"));
  fireEvent.click(f.screen.getByRole("button", { name: "Tile 1 menu" }));
  await act(async () => {});
  fireEvent.click(f.screen.getByRole("menuitem", { name: "Move to window" }));
  await act(async () => {});
  fireEvent.click(f.screen.getByRole("menuitem", { name: "Lovelace · <foom>, example" }));
  await act(async () => {});
  expect(f.screen.getByRole("alert").textContent).toBe("Unable to move tile to window.");
});

test("the window picker ignores a closed request and shows when no other windows are open", async () => {
  const f = fixture();
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof f.moves.list>>>();
  f.moves.list.mockReturnValueOnce(pending.promise).mockResolvedValueOnce([]);
  f.click(0);
  await act(async () => {});
  fireEvent.click(f.screen.getByRole("button", { name: "Tile 1 menu" }));
  expect(f.moves.list).not.toHaveBeenCalled();
  const trigger = f.screen.getByRole("menuitem", { name: "Move to window" });
  fireEvent.pointerEnter(trigger);
  fireEvent.click(trigger);
  expect(f.moves.list).toHaveBeenCalledOnce();
  expect(f.screen.getByRole("menuitem", { name: "Loading…" })).toHaveProperty("disabled", true);
  fireEvent.keyDown(f.screen.getByRole("menu", { name: "Move to window" }), { key: "Escape" });
  fireEvent.click(trigger);
  await act(async () => {});
  expect(f.screen.getByRole("menuitem", { name: "No other windows" })).toHaveProperty(
    "disabled",
    true,
  );
  await act(async () => {
    pending.resolve([{ id: 2, label: "Lovelace", repositories: [] }]);
    await pending.promise;
  });
  expect(f.screen.queryByRole("menuitem", { name: "Lovelace" })).toBeNull();
  fireEvent.keyDown(f.screen.getByRole("menu", { name: "Move to window" }), { key: "Escape" });
  f.moves.list.mockRejectedValueOnce(new Error("request failed"));
  fireEvent.click(trigger);
  await act(async () => {});
  expect(f.screen.getByRole("menuitem", { name: "Unable to load options" })).toHaveProperty(
    "disabled",
    true,
  );
});

test("inventory closes remain reflected during a reservation and agent arrivals wait in the sidebar", async () => {
  const f = fixture(true);
  f.click(0);
  await act(async () => {});
  f.prepare("request", null);
  await expect(f.place("p")).resolves.toBe("sidebar");
  act(() => {
    f.data.update("permission", { dormant: true, exited: true });
  });
  expect(f.screen.container.querySelectorAll('[data-empty="false"]')).toHaveLength(0);
  f.finish("request", { kind: "terminal", id: "check" });
  const saved = localStorage.getItem("foom.tiles.v1.test") ?? "";
  expect(saved).not.toContain('"session":"permission"');
  expect(saved).toContain('"session":"check"');
});

test.each(["before", "after"] as const)(
  "preview transfer preserves a startup that becomes ready %s transfer completion",
  async (when) => {
    const response = Promise.withResolvers<{ terminalId: string }>();
    const f = fixture(true, { sidebarCommand: () => response.promise });
    const tile = f.tile();
    fireEvent.contextMenu(tile);
    fireEvent.click(f.screen.getByRole("menuitem", { name: "New shell here" }));
    expect(f.screen.getByText("Starting on Local…")).toBeTruthy();
    f.prepare("incoming", { tile: tile.dataset["tile"] ?? "", zone: "right" });
    expect(f.moves.ready).toHaveBeenCalledWith("incoming", true);
    const ready = async () => {
      await act(async () => {
        response.resolve({ terminalId: "permission" });
        await Promise.resolve();
      });
    };
    if (when === "before") await ready();
    f.finish("incoming", { kind: "preview", id: "p" });
    if (when === "after") await ready();
    expect(f.screen.container.querySelectorAll('.terminal-tile[data-empty="false"]')).toHaveLength(
      2,
    );
    expect(f.screen.container.querySelector('[data-preview-id="p"]')).toBeTruthy();
    expect(f.screen.queryByText("Starting on Local…")).toBeNull();
    expect(f.views.some((view) => view.open.mock.calls.some(([id]) => id === "permission"))).toBe(
      true,
    );
  },
);
