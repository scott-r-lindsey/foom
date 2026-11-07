// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { createSampleSource } from "../../../../src/renderer/board/sample-board-source";
import { leaves, restoreLayout, saveLayout } from "../../../../src/renderer/board/tiles";
import type { TileLayout } from "../../../../src/renderer/board/tiles.d";
import { useBoardTiles } from "../../../../src/renderer/board/use-board-tiles";
import type { SetupSource } from "../../../../src/renderer/preflight/setup-source.d";
import type { SetupState } from "../../../../src/shared/setup";
import { boardRows } from "../../../fixtures/board";
import { setupState } from "../../../fixtures/setup";
import { registerTileAreaFixture } from "./tile-area-fixture";

registerTileAreaFixture();
const storageKey = "saved-font-layout";
const source = createSampleSource(boardRows(100).slice(0, 1));
const repairs = new Set<() => void>();
type FontSetup = Pick<SetupSource, "state" | "subscribe">;

beforeEach(() => {
  repairs.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: () => void) {}
      observe() {
        repairs.add(this.callback);
      }
      disconnect() {
        repairs.delete(this.callback);
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return DOMRect.fromRect({
      width: this.classList.contains("tile-area")
        ? 850
        : this.tagName === "SPAN"
          ? Number.parseFloat(this.style.fontSize) * 0.6
          : 0,
      height: 900,
    });
  });
  const row = source.getSnapshot()[0];
  if (!row) throw new Error("Missing fixture row");
  const layout: TileLayout = {
    focused: "terminal",
    landing: "space",
    maximized: null,
    tree: {
      kind: "split",
      id: "pair",
      direction: "horizontal",
      ratio: 0.5,
      first: { kind: "tile", id: "terminal", content: { kind: "terminal", session: row.id } },
      second: { kind: "tile", id: "space", content: null },
    },
  };
  saveLayout(localStorage, layout, storageKey);
});

function fontSetup(initial?: SetupState) {
  const load = Promise.withResolvers<SetupState>();
  let receive = (_state: SetupState) => {};
  const off = vi.fn();
  const setup: FontSetup = {
    state: () => load.promise,
    subscribe: (callback) => {
      receive = callback;
      if (initial) callback(initial);
      return off;
    },
  };
  return {
    setup,
    load,
    emit: (state: SetupState) => {
      receive(state);
    },
    off,
  };
}
function Harness({ setup }: { setup?: FontSetup }) {
  const { boardRef, layout, changeLayout } = useBoardTiles({
    source,
    soundSetup: setup,
    rows: source.getSnapshot(),
    previews: [],
    storageKey,
    setArrivals: vi.fn(),
    setRemoveError: vi.fn(),
  });
  return (
    <div ref={boardRef}>
      <div className="tile-area" />
      <output data-testid="layout">{JSON.stringify({ version: 2, ...layout })}</output>
      <button
        type="button"
        onClick={() => {
          changeLayout(layout);
        }}
      >
        Save layout
      </button>
    </div>
  );
}
function expectSpaces(view: ReturnType<typeof render>, count: number) {
  const live = restoreLayout(view.getByTestId("layout").textContent);
  const saved = restoreLayout(localStorage.getItem(storageKey));
  for (const layout of [live, saved]) {
    expect(leaves(layout.tree)).toHaveLength(count);
    expect(layout.focused).toBe("terminal");
    expect(leaves(layout.tree).find((tile) => tile.id === "terminal")?.content?.kind).toBe(
      "terminal",
    );
  }
}

test("startup waits for the saved small font before repairing or saving measured spaces", async () => {
  const fonts = fontSetup();
  const view = render(<Harness setup={fonts.setup} />);
  // Each 425px column preserves the old usable saved geometry at 10px and 14px.
  expectSpaces(view, 2);
  act(() => {
    for (const repair of [...repairs]) repair();
  });
  fireEvent.click(view.getByRole("button", { name: "Save layout" }));
  expectSpaces(view, 2);
  await act(async () => {
    fonts.load.resolve(setupState({ terminalFontSize: 10 }));
    await fonts.load.promise;
  });
  expectSpaces(view, 2);
  act(() => {
    fonts.emit(setupState({ terminalFontSize: 14 }));
  });
  expectSpaces(view, 2);
});

test("a synchronous font subscription wins over a stale initial read", async () => {
  const fonts = fontSetup(setupState({ terminalFontSize: 10 }));
  const view = render(<Harness setup={fonts.setup} />);
  expectSpaces(view, 2);
  await act(async () => {
    fonts.load.resolve(setupState({ terminalFontSize: 14 }));
    await fonts.load.promise;
  });
  expectSpaces(view, 2);
});

test("a failed initial font read preserves geometry until a settings notification arrives", async () => {
  const fonts = fontSetup();
  const view = render(<Harness setup={fonts.setup} />);
  expectSpaces(view, 2);
  await act(async () => {
    fonts.load.reject(new Error("Settings unavailable"));
    await fonts.load.promise.catch(() => {});
  });
  expectSpaces(view, 2);
  act(() => {
    fonts.emit(setupState({ terminalFontSize: 10 }));
  });
  expectSpaces(view, 2);
  act(() => {
    fonts.emit(setupState({ terminalFontSize: 14 }));
  });
  expectSpaces(view, 2);
});

test("replaced and unmounted font sources cannot repair using stale settings", async () => {
  const old = fontSetup(setupState({ terminalFontSize: 10 }));
  const next = fontSetup();
  const view = render(<Harness setup={old.setup} />);
  expectSpaces(view, 2);
  view.rerender(<Harness setup={next.setup} />);
  act(() => {
    old.emit(setupState({ terminalFontSize: 14 }));
  });
  expectSpaces(view, 2);
  await act(async () => {
    next.load.resolve(setupState({ terminalFontSize: 10 }));
    await next.load.promise;
  });
  expectSpaces(view, 2);
  view.unmount();
  const saved = localStorage.getItem(storageKey);
  await act(async () => {
    old.load.resolve(setupState({ terminalFontSize: 14 }));
    await old.load.promise;
  });
  expect(localStorage.getItem(storageKey)).toBe(saved);
  expect(old.off).toHaveBeenCalledOnce();
  expect(next.off).toHaveBeenCalledOnce();
});

test("boards without a settings source use their known default font immediately", () => {
  expectSpaces(render(<Harness />), 2);
});

test("the 12-cell repair floor still waits for loaded settings and responds to font changes", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return DOMRect.fromRect({
      width: this.classList.contains("tile-area")
        ? 170
        : Number.parseFloat(this.style.fontSize) * 0.6,
      height: 900,
    });
  });
  const fonts = fontSetup();
  const view = render(<Harness setup={fonts.setup} />);
  expectSpaces(view, 2);
  await act(async () => {
    fonts.load.resolve(setupState({ terminalFontSize: 10 }));
    await fonts.load.promise;
  });
  expectSpaces(view, 2);
  act(() => {
    fonts.emit(setupState({ terminalFontSize: 14 }));
  });
  expectSpaces(view, 1);
});
