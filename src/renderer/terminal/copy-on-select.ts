import { isTerminalSelection } from "../../shared/terminal-selection";
import type { Terminal } from "@xterm/xterm";
import type { DesktopApi } from "../../shared/desktop";

/** xterm emits mouse selection changes on completion, not intermediate drag paints.
 * Debounce keyboard/programmatic changes so only the settled selection is copied.
 */
export function copyOnSelect(
  terminal: Pick<Terminal, "onSelectionChange" | "getSelection">,
  target: () => string | undefined,
  desktop: Pick<DesktopApi, "copyTerminalSelection"> = window.desktop,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const selection = terminal.onSelectionChange(() => {
    clearTimeout(timer);
    const id = target();
    if (!id) return;
    const text = terminal.getSelection();
    if (!isTerminalSelection(text)) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (target() !== id) return;
      void desktop.copyTerminalSelection(id, text).catch(() => {});
    }, 100);
  });
  return () => {
    clearTimeout(timer);
    selection.dispose();
  };
}
