import { isTerminalSelection } from "../../shared/terminal-selection";
import type { Terminal } from "@xterm/xterm";
import type { DesktopApi } from "../../shared/desktop";

/** xterm emits mouse selection changes on completion, not intermediate drag paints.
 * Debounce keyboard/programmatic changes so only the settled selection is copied.
 */
export function copyOnSelect(
  container: HTMLElement,
  terminal: Pick<Terminal, "onSelectionChange" | "getSelection" | "modes">,
  target: () => string | undefined,
  desktop: Pick<DesktopApi, "copyTerminalSelection"> = window.desktop,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dragging = false;
  const changed = () => {
    clearTimeout(timer);
    if (dragging) return;
    const id = target();
    if (!id) return;
    const text = terminal.getSelection();
    if (!isTerminalSelection(text)) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (target() !== id) return;
      void desktop.copyTerminalSelection(id, text).catch(() => {});
    }, 100);
  };
  const selection = terminal.onSelectionChange(changed);
  const down = (event: MouseEvent) => {
    if (event.button !== 0) return;
    clearTimeout(timer);
    dragging = terminal.modes.mouseTrackingMode === "none" || event.shiftKey || event.altKey;
  };
  const up = (event: MouseEvent) => {
    if (!dragging || event.button !== 0) return;
    dragging = false;
    clearTimeout(timer);
    // xterm can omit its change event when a selection repeats the same bounds.
    // Read after its document mouseup handler, including releases outside the tile.
    timer = setTimeout(changed, 0);
  };
  container.addEventListener("mousedown", down, true);
  container.ownerDocument.addEventListener("mouseup", up);
  return () => {
    clearTimeout(timer);
    selection.dispose();
    container.removeEventListener("mousedown", down, true);
    container.ownerDocument.removeEventListener("mouseup", up);
  };
}
