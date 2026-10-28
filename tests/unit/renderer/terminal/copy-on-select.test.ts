// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { Terminal } from "@xterm/headless";
import { copyOnSelect } from "../../../../src/renderer/terminal/copy-on-select";

afterEach(() => vi.useRealTimers());

test("copies only completed, settled, bounded terminal selections through preload", async () => {
  vi.useFakeTimers();
  let selected = "";
  let changed = () => {};
  let id: string | undefined;
  const off = vi.fn();
  const container = document.createElement("div");
  const terminal = {
    modes: { ...new Terminal().modes },
    getSelection: () => selected,
    onSelectionChange: (callback: () => void) => {
      changed = callback;
      return { dispose: off };
    },
  };
  const desktop = { copyTerminalSelection: vi.fn(() => Promise.resolve()) };
  const dispose = copyOnSelect(container, terminal, () => id, desktop);
  selected = "disabled";
  changed();
  await vi.advanceTimersByTimeAsync(100);
  expect(desktop.copyTerminalSelection).not.toHaveBeenCalled();
  id = "terminal";
  // Intermediate xterm drag paints do not emit onSelectionChange.
  selected = "intermediate";
  await vi.advanceTimersByTimeAsync(100);
  expect(desktop.copyTerminalSelection).not.toHaveBeenCalled();
  selected = "complete";
  changed();
  await vi.advanceTimersByTimeAsync(99);
  expect(desktop.copyTerminalSelection).not.toHaveBeenCalled();
  selected = "keyboard settled";
  changed();
  selected = "new drag before the prior selection settles";
  await vi.advanceTimersByTimeAsync(100);
  expect(desktop.copyTerminalSelection).toHaveBeenCalledExactlyOnceWith(
    "terminal",
    "keyboard settled",
  );
  for (const text of ["", "x".repeat(65_537)]) {
    selected = text;
    changed();
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(desktop.copyTerminalSelection).toHaveBeenCalledTimes(1);
  selected = "😀".repeat(32_768);
  changed();
  await vi.advanceTimersByTimeAsync(100);
  expect(desktop.copyTerminalSelection).toHaveBeenLastCalledWith("terminal", selected);
  changed();
  id = undefined;
  await vi.advanceTimersByTimeAsync(100);
  id = "terminal";
  changed();
  id = "other";
  await vi.advanceTimersByTimeAsync(100);
  expect(desktop.copyTerminalSelection).toHaveBeenCalledTimes(2);
  const down = (button = 0, shiftKey = false) =>
    container.dispatchEvent(new MouseEvent("mousedown", { button, shiftKey }));
  const up = (button = 0) => document.dispatchEvent(new MouseEvent("mouseup", { button }));
  selected = "repeated";
  down(1);
  up();
  down();
  selected = "dragging";
  changed();
  await vi.advanceTimersByTimeAsync(200);
  expect(desktop.copyTerminalSelection).toHaveBeenCalledTimes(2);
  up(1);
  selected = "repeated";
  up();
  await vi.advanceTimersByTimeAsync(100);
  expect(desktop.copyTerminalSelection).toHaveBeenLastCalledWith("other", "repeated");
  terminal.modes.mouseTrackingMode = "vt200";
  down();
  up();
  await vi.advanceTimersByTimeAsync(100);
  expect(desktop.copyTerminalSelection).toHaveBeenCalledTimes(3);
  down(0, true);
  up();
  await vi.advanceTimersByTimeAsync(100);
  expect(desktop.copyTerminalSelection).toHaveBeenCalledTimes(4);
  desktop.copyTerminalSelection.mockRejectedValueOnce(new Error("detached"));
  changed();
  await vi.advanceTimersByTimeAsync(100);
  changed();
  dispose();
  await vi.advanceTimersByTimeAsync(100);
  expect(off).toHaveBeenCalledOnce();
  expect(desktop.copyTerminalSelection).toHaveBeenCalledTimes(5);
  down();
  up();
  await vi.advanceTimersByTimeAsync(100);
  expect(desktop.copyTerminalSelection).toHaveBeenCalledTimes(5);
});
