import type { Terminal } from "@xterm/xterm";

/** Alternate screens have no scrollback. Preserve native scrolling and mouse reporting. */
export function alternateScroll(
  terminal: Pick<Terminal, "buffer" | "modes" | "rows" | "options">,
  send: (data: string) => void,
) {
  let remainder = 0;
  const reset = () => {
    remainder = 0;
  };
  return {
    reset,
    handle(event: WheelEvent): boolean {
      if (
        terminal.buffer.active.type !== "alternate" ||
        terminal.modes.mouseTrackingMode !== "none" ||
        event.ctrlKey
      ) {
        reset();
        return true;
      }
      event.preventDefault();
      const lineHeight = (terminal.options.fontSize ?? 14) * (terminal.options.lineHeight ?? 1);
      const delta =
        event.deltaY *
        (event.deltaMode === 1 ? 1 : event.deltaMode === 2 ? terminal.rows : 1 / lineHeight);
      if (!Number.isFinite(delta)) {
        reset();
        return false;
      }
      if (Math.sign(delta) !== Math.sign(remainder)) reset();
      remainder += delta;
      const lines = Math.max(-100, Math.min(100, Math.trunc(remainder)));
      remainder -= Math.trunc(remainder);
      if (lines)
        send(
          (terminal.modes.applicationCursorKeysMode ? "\x1bO" : "\x1b[")
            .concat(lines < 0 ? "A" : "B")
            .repeat(Math.abs(lines)),
        );
      return false;
    },
  };
}
