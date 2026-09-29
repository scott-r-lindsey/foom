// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createRef, Profiler } from "react";
import { Board } from "../src/renderer/board-view";
import { createSampleSource } from "../src/renderer/board-source";
import type { BoardRow } from "../src/renderer/board.d";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { light, nextWaiting, sampleRows, waitTime } from "../src/renderer/board";

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
  const dialogRef = createRef<HTMLDialogElement>();
  const source = createSampleSource(rows);
  const view = render(<Board source={source} dialogRef={dialogRef} />);
  return {
    source,
    dispose: view.unmount,
    show: () => {
      act(() => {
        dialogRef.current?.showModal();
        dialogRef.current?.querySelector<HTMLButtonElement>(".board-row")?.focus();
      });
    },
  };
}
function setup() {
  const rows = sampleRows(Date.now());
  const board = mountBoard(document.body, rows);
  board.show();
  const dialog = document.querySelector("dialog");
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
  const cancel = () => fireEvent(dialog, new Event("cancel", { cancelable: true }));
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
  ]);
  for (const row of rows) {
    row.seen = true;
    expect(light(row).opacity).toBe(
      row.state === "quiet_ok" || row.state === "done" || row.state === "failed"
        ? 0.4
        : row.state === "working"
          ? 0.7075
          : 1,
    );
  }
  const row = rows[1];
  if (!row) throw new Error("Missing working row");
  row.rate = -1;
  expect(light(row).opacity).toBe(0.35);
  row.rate = 99999;
  expect(light(row).opacity).toBe(1);
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
  expect(document.activeElement).toBe(buttons[6]);
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
  expect(buttons[3]?.style.getPropertyValue("--light-opacity")).toBe("0.4");
  expect(dialog.querySelector<HTMLButtonElement>("[data-reply]")?.disabled).toBe(true);
  key("Escape");
  expect(document.activeElement).toBe(buttons[3]);
  act(() => {
    buttons[3]?.click();
  });
  click("[data-hide]");
  expect(document.activeElement).toBe(buttons[3]);
  expect(cancel()).toBe(true);
  click("[data-close]");
  expect(dialog.open).toBe(false);
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  board.dispose();
  expect(document.querySelector("dialog")).toBeNull();
});
test("hover peeks without focus and never covers an open terminal; terminal text stays data", () => {
  const { board, buttons, dialog, rows } = setup();
  const row = rows[1];
  if (!row) throw new Error("Missing row");
  row.tail = ["<img src=x onerror=alert(1)>"];
  fireEvent.mouseOver(buttons[1] ?? document.body);
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
  const { board, buttons, key, click, dialog } = setup();
  const original = buttons.map((button) => button.querySelector(".board-branch")?.textContent);
  const bulb = buttons[0]?.querySelector(".board-light");
  act(() => {
    vi.advanceTimersByTime(60000);
  });
  expect(buttons[0]?.querySelector(".board-light")).toBe(bulb);
  expect(buttons[0]?.textContent).toContain("4m");
  key("N");
  click("[data-reply]");
  expect(buttons[0]?.textContent).toContain("Sample reply sent");
  key("n");
  expect(dialog.querySelector(".board-terminal h2")?.textContent).toContain("feat/export");
  click("[data-dismiss]");
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
  document.querySelector("dialog")?.dispatchEvent(new KeyboardEvent("keydown", { key: "p" }));
  expect(document.querySelector(".board-summary")?.textContent).toBe("Nothing needs you. Yet.");
  board.dispose();
});

test("activity updates brightness without replacing rows or rerendering React", () => {
  const rows = sampleRows(Date.now());
  const source = createSampleSource(rows);
  const renders = vi.fn();
  const dialogRef = createRef<HTMLDialogElement>();
  const view = render(
    <Profiler id="board" onRender={renders}>
      <Board source={source} dialogRef={dialogRef} />
    </Profiler>,
  );
  act(() => {
    dialogRef.current?.showModal();
  });
  const button = document.querySelector<HTMLButtonElement>('[data-state="working"]');
  const bulb = button?.querySelector(".board-light");
  renders.mockClear();
  source.setActivity("build", 4000);
  expect(button?.style.getPropertyValue("--light-opacity")).toBe("1");
  source.setActivity("unknown", 0);
  expect(renders).not.toHaveBeenCalled();
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(button?.style.getPropertyValue("--light-opacity")).toBe("1");
  expect(button?.querySelector(".board-light")).toBe(bulb);
  view.unmount();
  source.setActivity("build", 0);
  expect(button?.style.getPropertyValue("--light-opacity")).toBe("1");
  source.resolve("build", "Ignored");
  source.resolve("unknown", "Ignored");
  expect(source.getSnapshot().find((row) => row.id === "build")?.reason).toBe(
    "Building terminal navigation",
  );
});

test("next waiting refocuses an already open terminal from its controls", () => {
  const { board, dialog, key } = setup();
  key("n");
  act(() => {
    dialog.querySelector<HTMLButtonElement>("[data-reply]")?.focus();
  });
  key("n");
  expect(document.activeElement).toBe(dialog.querySelector(".board-terminal"));
  board.dispose();
});
