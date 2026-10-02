// @vitest-environment jsdom
import { expect, test, vi } from "vitest";
import { Terminal } from "@xterm/headless";
import { alternateScroll } from "../../../../src/renderer/terminal/alternate-scroll";
const write = (terminal: Terminal, text: string) =>
  new Promise<void>((resolve) => {
    terminal.write(text, resolve);
  });
test("alternate wheel uses cursor modes, accumulates pixels, and leaves normal scrolling and mouse reports native", async () => {
  const terminal = new Terminal({ allowProposedApi: true, cols: 80, rows: 24 });
  const send = vi.fn();
  const wheel = alternateScroll(
    { buffer: terminal.buffer, modes: terminal.modes, rows: 24, options: {} },
    send,
  );
  // Read live modes after each parser change, as the renderer does.
  const live = alternateScroll(
    {
      get buffer() {
        return terminal.buffer;
      },
      get modes() {
        return terminal.modes;
      },
      rows: 24,
      options: { fontSize: 14, lineHeight: 1 },
    },
    send,
  );
  const event = (deltaY: number, deltaMode = 0, ctrlKey = false) =>
    new WheelEvent("wheel", { deltaY, deltaMode, ctrlKey, cancelable: true });
  expect(live.handle(event(100))).toBe(true);
  await write(terminal, "\x1b[?1049h");
  expect(live.handle(event(6))).toBe(false);
  expect(send).not.toHaveBeenCalled();
  live.handle(event(8));
  expect(send).toHaveBeenLastCalledWith("\x1b[B");
  live.handle(event(-28));
  expect(send).toHaveBeenLastCalledWith("\x1b[A\x1b[A");
  await write(terminal, "\x1b[?1h");
  live.handle(event(2, 1));
  expect(send).toHaveBeenLastCalledWith("\x1bOB\x1bOB");
  live.handle(event(-1, 2));
  expect(send).toHaveBeenLastCalledWith("\x1bOA".repeat(24));
  live.handle(event(8));
  live.handle(event(-8));
  send.mockClear();
  live.reset();
  live.handle(event(7));
  expect(send).not.toHaveBeenCalled();
  expect(live.handle(event(50, 0, true))).toBe(true);
  await write(terminal, "\x1b[?1000h");
  expect(live.handle(event(50))).toBe(true);
  expect(send).not.toHaveBeenCalled();
  await write(terminal, "\x1b[?1000l");
  const invalid = event(0);
  Object.defineProperty(invalid, "deltaY", { value: Number.NaN });
  live.handle(invalid);
  live.handle(event(99999, 1));
  expect(send).toHaveBeenLastCalledWith("\x1bOB".repeat(100));
  wheel.handle(event(14));
  terminal.dispose();
});
