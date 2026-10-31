import type { Terminal } from "@xterm/xterm";
import type { TerminalContextMenu } from "./terminal-view-source.d";
import type { DesktopApi } from "../../shared/desktop";

/** Capture before xterm clears selection or reports a menu-owned mouse press. */
export function terminalContextMenu(
  container: HTMLElement,
  terminal: Pick<Terminal, "textarea" | "getSelection" | "selectAll" | "clear" | "focus"> & {
    modes: Pick<Terminal["modes"], "mouseTrackingMode">;
  },
  target: () => string | undefined,
  open: (menu: TerminalContextMenu) => void,
  desktop: {
    appMenu: Pick<DesktopApi["appMenu"], "execute">;
    paste?: () => Promise<void>;
  } = window.desktop,
  platform = navigator.platform,
) {
  const owns = (event: MouseEvent) =>
    (event.button === 2 || (platform.startsWith("Mac") && event.button === 0 && event.ctrlKey)) &&
    (event.shiftKey || terminal.modes.mouseTrackingMode === "none");
  const down = (event: MouseEvent) => {
    if (!owns(event) || !target()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const context = (event: MouseEvent) => {
    // Suppress Chromium's menu even when the application owns this gesture.
    event.preventDefault();
    if (!owns(event)) return;
    const id = target();
    if (!id) return;
    event.stopImmediatePropagation();
    const text = terminal.getSelection();
    const run =
      <T extends void | Promise<void>>(action: () => T) =>
      () => {
        if (target() !== id) return;
        return action();
      };
    open({
      id,
      anchor: terminal.textarea ?? container,
      point: { x: event.clientX, y: event.clientY },
      copy: text
        ? run(() => {
            terminal.focus();
            return desktop.appMenu.execute("copy");
          })
        : undefined,
      paste: run(() => {
        terminal.focus();
        return desktop.paste ? desktop.paste() : desktop.appMenu.execute("paste");
      }),
      selectAll: run(() => {
        terminal.selectAll();
      }),
      clear: run(() => {
        terminal.clear();
      }),
    });
  };
  container.addEventListener("mousedown", down, true);
  container.addEventListener("contextmenu", context, true);
  return () => {
    container.removeEventListener("mousedown", down, true);
    container.removeEventListener("contextmenu", context, true);
  };
}
