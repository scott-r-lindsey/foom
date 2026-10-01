// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Profiler } from "react";
import { Board } from "../src/renderer/board-view";
import { createSampleSource } from "../src/renderer/board-source";
import type { BoardRow } from "../src/renderer/board.d";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { groupRows, light, nextWaiting, sampleRows, waitTime } from "../src/renderer/board";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(200000);
  document.body.replaceChildren();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function mountBoard(_host: HTMLElement, rows: BoardRow[]) {
  const source = createSampleSource(rows);
  const view = render(<Board source={source} />);
  return {
    source,
    dispose: view.unmount,
    show: () => {},
  };
}
function setup() {
  const rows = sampleRows(Date.now());
  const board = mountBoard(document.body, rows);
  board.show();
  const dialog = document.querySelector(".board-home");
  if (!dialog) throw new Error("Missing dialog");
  const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>(".board-row"));
  const key = (key: string, ctrlKey = false) =>
    fireEvent(
      dialog,
      new KeyboardEvent("keydown", { key, ctrlKey, bubbles: true, cancelable: true }),
    );
  const click = (selector: string) => {
    act(() => {
      dialog.querySelector<HTMLButtonElement>(selector)?.click();
    });
  };
  const cancel = () =>
    fireEvent(
      dialog,
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  return { rows, board, dialog, buttons, key, click, cancel };
}
test("maps every state to a text label and activity brightness, dimming only acknowledged completion", () => {
  const rows = sampleRows(0);
  expect(rows.map(light).map((value) => value.label)).toEqual([
    "Needs you",
    "Working",
    "Checking",
    "Done",
    "Failed",
    "Quiet",
    "Needs you",
    "Working",
    "Working",
    "Working",
  ]);
  for (const row of rows) {
    row.seen = true;
    expect(light(row).opacity).toBeCloseTo(
      row.state === "quiet_ok" || row.state === "done" || row.state === "failed"
        ? 0.4
        : row.state === "working"
          ? row.rate === 2200
            ? 0.7075
            : 0.545
          : 1,
    );
  }
  const row = rows[1];
  if (!row) throw new Error("Missing working row");
  row.rate = -1;
  expect(light(row).opacity).toBeCloseTo(0.35);
  row.rate = 99999;
  expect(light(row).opacity).toBeCloseTo(1);
});
test("queue uses oldest wait, keeps ties stable and never reorders the board", () => {
  const rows = sampleRows(200000);
  const original = rows.map((row) => row.id);
  expect(nextWaiting(rows)?.id).toBe("review");
  const first = rows[0];
  const last = rows[6];
  if (!first || !last) throw new Error("Missing waiting rows");
  first.waitingSince = last.waitingSince;
  expect(nextWaiting(rows)?.id).toBe("review");
  first.state = "working";
  expect(nextWaiting(rows)?.id).toBe("approve");
  last.state = "working";
  expect(nextWaiting(rows)).toBeUndefined();
  expect(rows.map((row) => row.id)).toEqual(original);
  expect(nextWaiting([])).toBeUndefined();
  first.state = "needs_input";
  expect(waitTime(first, 0)).toBe("0s");
  expect(waitTime(first, 200000)).toBe("45s");
  expect(waitTime(first, 300000)).toBe("2m");
  first.state = "working";
  expect(waitTime(first, 300000)).toBe("—");
});
test("keyboard selection wraps; peek leaves focus in place; opening preserves attention", () => {
  const { board, buttons, key, dialog, cancel, click } = setup();
  expect(document.activeElement).toBe(buttons[0]);
  key("ArrowUp");
  expect(document.activeElement).toBe(buttons[9]);
  key("ArrowDown");
  expect(document.activeElement).toBe(buttons[0]);
  key("p");
  expect(document.activeElement).toBe(buttons[0]);
  expect(dialog.querySelector<HTMLElement>(".board-peek")?.hidden).toBe(false);
  key("p");
  expect(dialog.querySelector<HTMLElement>(".board-peek")?.hidden).toBe(true);
  key("p");
  expect(cancel()).toBe(false);
  expect(dialog.querySelector<HTMLElement>(".board-peek")?.hidden).toBe(true);
  key("n", true);
  expect(dialog.querySelector<HTMLElement>(".board-terminal")?.hidden).toBe(true);
  key("n");
  expect(document.activeElement).toBe(dialog.querySelector(".board-terminal"));
  expect(buttons[0]?.textContent).toContain("Needs you");
  key("ArrowDown");
  expect(document.activeElement).toBe(dialog.querySelector(".board-terminal"));
  expect(cancel()).toBe(false);
  expect(document.activeElement).toBe(buttons[0]);
  act(() => {
    buttons[3]?.click();
  });
  expect(
    buttons[3]
      ?.querySelector<HTMLElement>(".board-light")
      ?.style.getPropertyValue("--light-opacity"),
  ).toBe("0.4");
  expect(dialog.textContent).toContain("read-only");
  key("Escape");
  expect(document.activeElement).toBe(buttons[3]);
  act(() => {
    buttons[3]?.click();
  });
  click("[data-hide]");
  expect(document.activeElement).toBe(buttons[3]);
  expect(cancel()).toBe(true);

  act(() => {
    vi.advanceTimersByTime(1000);
  });
  board.dispose();
  expect(document.querySelector(".board-home")).toBeNull();
});
test("hover peeks without focus and never covers an open terminal; terminal text stays data", async () => {
  const { board, buttons, dialog, rows } = setup();
  const row = rows[1];
  if (!row) throw new Error("Missing row");
  row.tail = ["<img src=x onerror=alert(1)>"];
  fireEvent.mouseOver(buttons[1] ?? document.body);
  await act(async () => {
    await Promise.resolve();
  });
  expect(dialog.querySelector(".board-peek pre")?.textContent).toContain("<img");
  expect(dialog.querySelector("img")).toBeNull();
  expect(document.activeElement).toBe(buttons[0]);
  fireEvent.mouseOut(buttons[1] ?? document.body);
  expect(dialog.querySelector<HTMLElement>(".board-peek")?.hidden).toBe(true);
  act(() => {
    buttons[1]?.click();
  });
  fireEvent.mouseOver(buttons[0] ?? document.body);
  expect(dialog.querySelector<HTMLElement>(".board-peek")?.hidden).toBe(true);
  board.dispose();
});
test("replies and dismissals advance the queue without moving rows; elapsed waits update", () => {
  const { board, buttons, key, dialog } = setup();
  const original = buttons.map((button) => button.querySelector(".board-branch")?.textContent);
  const bulb = buttons[0]?.querySelector<HTMLElement>(".board-light");
  act(() => {
    vi.advanceTimersByTime(60000);
  });
  expect(buttons[0]?.querySelector<HTMLElement>(".board-light")).toBe(bulb);
  expect(buttons[0]?.textContent).toContain("4m");
  key("N");
  act(() => {
    void board.source.resolve("review", "Sample reply sent");
  });
  key("Escape");
  expect(buttons[0]?.textContent).toContain("Sample reply sent");
  key("n");
  expect(dialog.querySelector(".board-terminal h2")?.textContent).toContain("feat/export");
  act(() => {
    void board.source.resolve("approve", "Not attention · dismissed");
  });
  key("Escape");
  expect(buttons[6]?.textContent).toContain("Not attention");
  expect(dialog.querySelector(".board-summary")?.textContent).toBe("Nothing needs you. Yet.");
  key("n");
  key("a");
  expect(dialog.querySelector<HTMLElement>(".board-terminal")?.hidden).toBe(true);
  expect(buttons.map((button) => button.querySelector(".board-branch")?.textContent)).toEqual(
    original,
  );
  board.dispose();
});
test("empty boards remain usable", () => {
  const board = mountBoard(document.body, []);
  board.show();
  document.querySelector(".board-home")?.dispatchEvent(new KeyboardEvent("keydown", { key: "p" }));
  expect(document.querySelector(".board-summary")?.textContent).toBe("Nothing needs you. Yet.");
  board.dispose();
});

test("activity updates brightness without replacing rows or rerendering React", () => {
  const rows = sampleRows(Date.now());
  const source = createSampleSource(rows);
  const renders = vi.fn();
  const view = render(
    <Profiler id="board" onRender={renders}>
      <Board source={source} />
    </Profiler>,
  );
  const button = document.querySelector<HTMLButtonElement>('[data-state="working"]');
  const bulb = button?.querySelector<HTMLElement>(".board-light");
  renders.mockClear();
  source.setActivity("build", 4000);
  expect(bulb?.style.getPropertyValue("--light-opacity")).toBe("1");
  source.setActivity("unknown", 0);
  expect(renders).not.toHaveBeenCalled();
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(bulb?.style.getPropertyValue("--light-opacity")).toBe("1");
  expect(button?.querySelector<HTMLElement>(".board-light")).toBe(bulb);
  view.unmount();
  source.setActivity("build", 0);
  expect(bulb?.style.getPropertyValue("--light-opacity")).toBe("1");
  void source.resolve("build", "Ignored");
  void source.resolve("unknown", "Ignored");
  expect(source.getSnapshot().find((row) => row.id === "build")?.reason).toBe(
    "Building terminal navigation · sample: output",
  );
});

test("next waiting refocuses an already open terminal from its controls", () => {
  const { board, dialog, key } = setup();
  key("n");
  act(() => {
    dialog.querySelector<HTMLButtonElement>("[data-hide]")?.focus();
  });
  key("n");
  expect(document.activeElement).toBe(dialog.querySelector(".board-terminal"));
  board.dispose();
});

test("groups by first repository appearance and preserves row order across verdict changes", () => {
  const rows = sampleRows(0);
  const first = rows[0];
  if (!first) throw new Error("Missing row");
  const reordered = [...rows.slice(3), ...rows.slice(0, 3)];
  expect([...groupRows(reordered).keys()]).toEqual(["observatory", "launchpad", "foom"]);
  const before = [...groupRows(reordered).values()].flat().map((row) => row.id);
  first.state = "done";
  expect([...groupRows(reordered).values()].flat().map((row) => row.id)).toEqual(before);
});

test("tail failures are visible and obsolete tail responses do not overwrite a new peek", async () => {
  const source = createSampleSource();
  let finish: ((lines: string[]) => void) | undefined;
  source.tail = vi
    .fn()
    .mockReturnValueOnce(
      new Promise<string[]>((resolve) => {
        finish = resolve;
      }),
    )
    .mockRejectedValue(new Error("offline"));
  const view = render(<Board source={source} />);
  const buttons = view.container.querySelectorAll(".board-row");
  fireEvent.mouseOver(buttons[0] ?? document.body);
  fireEvent.mouseOver(buttons[1] ?? document.body);
  await act(async () => {
    await Promise.resolve();
  });
  expect(view.container.querySelector(".board-peek pre")?.textContent).toContain("Unable to read");
  await act(async () => {
    finish?.(["stale"]);
    await Promise.resolve();
  });
  expect(view.container.querySelector(".board-peek pre")?.textContent).not.toContain("stale");
  await expect(createSampleSource().tail("missing")).resolves.toEqual([]);
});

test("opening the same waiting row again keeps its output visible", async () => {
  const { key, dialog } = setup();
  key("n");
  await act(async () => {
    await Promise.resolve();
  });
  expect(dialog.querySelector(".sample-terminal pre")?.textContent).toContain("Run npm test?");
  key("n");
  await act(async () => {
    await Promise.resolve();
  });
  expect(dialog.querySelector(".sample-terminal pre")?.textContent).toContain("Run npm test?");
});

test("keyboard peek replaces hover, stays pinned across mouse movement, and toggles off with P", async () => {
  const { buttons, key, dialog } = setup();
  fireEvent.mouseOver(buttons[1] ?? document.body);
  await act(async () => {
    await Promise.resolve();
  });
  expect(dialog.querySelector(".board-peek h2")?.textContent).toContain("feat/terminal-tabs");
  key("p");
  await act(async () => {
    await Promise.resolve();
  });
  expect(dialog.querySelector(".board-peek h2")?.textContent).toContain("fix/session-restore");
  expect(dialog.querySelector(".board-peek pre")?.textContent).toContain("Run npm test?");
  fireEvent.mouseOut(buttons[1] ?? document.body);
  fireEvent.mouseOver(buttons[2] ?? document.body);
  expect(dialog.querySelector(".board-peek h2")?.textContent).toContain("fix/session-restore");
  expect(document.activeElement).toBe(buttons[0]);
  key("ArrowDown");
  key("p");
  await act(async () => {
    await Promise.resolve();
  });
  expect(dialog.querySelector(".board-peek h2")?.textContent).toContain("feat/terminal-tabs");
  key("p");
  expect(dialog.querySelector<HTMLElement>(".board-peek")?.hidden).toBe(true);
});

test("pinning the currently hovered row retains its tail", async () => {
  const { buttons, key, dialog } = setup();
  fireEvent.mouseOver(buttons[0] ?? document.body);
  await act(async () => {
    await Promise.resolve();
  });
  key("p");
  await act(async () => {
    await Promise.resolve();
  });
  expect(dialog.querySelector(".board-peek pre")?.textContent).toContain("Run npm test?");
});
