// @vitest-environment jsdom
import { boardRows as sampleRows } from "../../../fixtures/board";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Profiler } from "react";
import { Board } from "../../../../src/renderer/board/board-view";
import { createSampleSource } from "../../../../src/renderer/board/sample-board-source";
import type { BoardRow } from "../../../../src/renderer/board/board.d";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installation } from "../../../fixtures/setup";
import { groupRows, light, nextWaiting, waitTime } from "../../../../src/renderer/board/board";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(200000);
  document.body.replaceChildren();
  localStorage.clear();
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
let command: ((command: "sidebar" | "next-waiting") => void) | undefined;
function mountBoard(_host: HTMLElement, rows: BoardRow[]) {
  const source = createSampleSource(rows);
  const view = render(
    <Board
      source={{
        ...source,
        subscribeCommands: (listener) => {
          command = listener;
          return () => {
            command = undefined;
          };
        },
      }}
    />,
  );
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
  const key = (key: string, ctrlKey = false) => {
    if (key.toLowerCase() === "n" && !ctrlKey) {
      act(() => {
        command?.("next-waiting");
      });
      return;
    }
    fireEvent.keyDown(document.activeElement ?? dialog, { key, ctrlKey });
  };
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
    "Quiet",
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
  expect(nextWaiting(rows)?.id).toBe("permission");
  const first = rows[0];
  const last = rows[6];
  if (!first || !last) throw new Error("Missing waiting rows");
  first.waitingSince = last.waitingSince;
  expect(nextWaiting(rows)?.id).toBe("permission");
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
test("sidebar arrows wrap, focus stays in the sidebar, selection preserves attention and Escape stays in the pane", () => {
  const { board, buttons, key, dialog } = setup();
  expect(document.activeElement).toBe(buttons[0]);
  key("End");
  expect(document.activeElement).toBe(buttons[9]);
  act(() => {
    buttons[0]?.focus();
  });
  expect(dialog.querySelector(".board-peek")).toBeNull();
  act(() => {
    buttons[0]?.click();
  });
  key("Escape");
  expect(document.activeElement).toBe(dialog.querySelector('.terminal-tile[data-focused="true"]'));
  expect(buttons[0]?.textContent).toContain("Needs you");
  act(() => {
    command?.("sidebar");
  });
  expect(document.activeElement).toBe(buttons[0]);
  act(() => {
    dialog.querySelector<HTMLButtonElement>('[aria-label="Hide"]')?.click();
    dialog.querySelector<HTMLElement>('.board-row[data-state="done"]')?.click();
  });
  expect(
    dialog
      .querySelector('.board-row[data-state="done"]')
      ?.querySelector<HTMLElement>(".board-light")
      ?.style.getPropertyValue("--light-opacity"),
  ).toBe("0.4");
  board.dispose();
});
test("hover leaves the pane unchanged; selected terminal text stays data", async () => {
  const { board, buttons, dialog, rows } = setup();
  const row = rows[1];
  if (!row) throw new Error("Missing row");
  row.tail = ["<img src=x onerror=alert(1)>"];
  fireEvent.mouseOver(buttons[1] ?? document.body);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(dialog.querySelector(".board-peek")).toBeNull();
  expect(dialog.querySelector("img")).toBeNull();
  expect(document.activeElement).toBe(buttons[0]);
  fireEvent.mouseOut(buttons[1] ?? document.body);
  expect(dialog.querySelector(".board-peek")).toBeNull();
  act(() => {
    buttons[1]?.click();
  });
  expect(dialog.querySelector(".sample-terminal pre")?.textContent).toContain("<img");
  expect(dialog.querySelector("img")).toBeNull();
  fireEvent.mouseOver(buttons[0] ?? document.body);
  expect(dialog.querySelector(".board-peek")).toBeNull();
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
    void board.source.resolve("permission", "Sample reply sent");
  });
  key("Escape");
  expect(buttons[0]?.textContent).toContain("Sample reply sent");
  key("n");
  expect(dialog.querySelector(".board-terminal h2")?.textContent).toContain("feat/export");
  act(() => {
    void board.source.resolve("approve", "Not attention · dismissed");
  });
  key("Escape");
  expect(dialog.querySelector('.board-row[aria-label*="feat/export"]')?.textContent).toContain(
    "Not attention",
  );
  expect(dialog.querySelector(".board-summary")?.textContent).toMatch(/^0 need you/);
  key("n");
  key("a");
  expect(dialog.querySelector<HTMLElement>(".board-terminal")?.hidden).toBe(false);
  expect(buttons.map((button) => button.querySelector(".board-branch")?.textContent)).toEqual(
    original,
  );
  board.dispose();
});
test("empty boards remain usable", () => {
  const board = mountBoard(document.body, []);
  board.show();
  document.querySelector(".board-home")?.dispatchEvent(new KeyboardEvent("keydown", { key: "p" }));
  expect(document.querySelector(".board-summary")?.textContent).toMatch(/^0 need you/);
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
  expect(document.activeElement).toBe(dialog.querySelector('.terminal-tile[data-focused="true"]'));
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

test("hover and focus do not request terminal output", async () => {
  const source = createSampleSource();
  const tail = vi.fn(() => Promise.resolve([]));
  source.tail = tail;
  const view = render(<Board source={source} />);
  const rows = view.container.querySelectorAll(".board-row");
  fireEvent.mouseOver(rows[0] ?? document.body);
  fireEvent.focus(rows[1] ?? document.body);
  await act(async () => {});
  expect(tail).not.toHaveBeenCalled();
  expect(view.queryByRole("complementary", { name: "Terminal peek" })).toBeNull();
  await expect(createSampleSource().tail("missing")).resolves.toEqual([]);
});

test("opening the same waiting row again keeps its output visible", async () => {
  const { key, dialog } = setup();
  key("n");
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(dialog.querySelector(".sample-terminal pre")?.textContent).toContain("Run npm test?");
  key("n");
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(dialog.querySelector(".sample-terminal pre")?.textContent).toContain("Run npm test?");
});

test("focusing another row leaves the selected pane unchanged", async () => {
  const { buttons, key, dialog } = setup();
  act(() => {
    buttons[0]?.click();
  });
  act(() => {
    command?.("sidebar");
  });
  key("ArrowDown");
  key("ArrowDown");
  await act(async () => {
    await Promise.resolve();
  });
  expect(dialog.querySelector(".board-peek")).toBeNull();
  expect(dialog.querySelector(".board-terminal h2")?.textContent).toContain("fix/session-restore");
  expect(dialog.querySelector(".sample-terminal pre")?.textContent).toContain("Run npm test?");
});

test("board opens the launcher without routing typing to shortcuts and reports removal errors", async () => {
  const row = sampleRows(0)[0];
  if (!row) throw new Error("Missing sample");
  const base = createSampleSource([{ ...row, kind: "shell", managed: true }]);
  const remove = vi.fn(() => Promise.reject(new Error("Worktree changed")));
  const source = {
    ...base,
    sidebarCommand: remove,
    worktrees: {
      load: () =>
        Promise.resolve({
          repositories: [],
          agents: [installation("claude")],
          hooks: true,
          acknowledged: false,
          enabled: { claude: true, codex: true, agy: true },
        }),
      addRepository: () => Promise.resolve(null),
      start: () => Promise.resolve(),
      remove,
    },
  };
  const screen = render(<Board source={source} />);
  await act(async () => {
    await Promise.resolve();
    fireEvent.click(screen.getByRole("button", { name: `Actions for ${row.repository}` }));
  });
  fireEvent.click(screen.getByRole("menuitem", { name: "New worktree…" }));
  fireEvent.keyDown(screen.getByLabelText("Branch"), { key: "n" });
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  await act(async () => {
    await Promise.resolve();
    fireEvent.click(screen.getByRole("button", { name: "Actions for fix/session-restore" }));
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete worktree…" }));
    await Promise.resolve();
  });
  expect(screen.getByRole("alert").textContent).toBe("Worktree changed");
  remove.mockRejectedValueOnce("failure");
  await act(async () => {
    await Promise.resolve();
    fireEvent.click(screen.getByRole("button", { name: "Actions for fix/session-restore" }));
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete worktree…" }));
    await Promise.resolve();
  });
  expect(screen.getByRole("alert").textContent).toBe("Unable to update workspace.");
});
