import type { Terminal } from "@xterm/xterm";

/** Mouse reporting owns middle clicks; Shift retains native primary-selection paste. */
export function suppressTrackedMiddleClick(
  container: HTMLElement,
  terminal: Pick<Terminal, "modes">,
  platform = navigator.platform,
) {
  let suppressPaste = false;
  const reset = () => {
    suppressPaste = false;
  };
  const handle = (event: MouseEvent) => {
    // Match xterm's Linux-only primary-selection handling; other platforms
    // have no native paste to consume and must not arm suppression.
    suppressPaste =
      platform.includes("Linux") &&
      event.button === 1 &&
      !event.shiftKey &&
      terminal.modes.mouseTrackingMode !== "none";
    if (suppressPaste) event.preventDefault();
  };
  const paste = (event: ClipboardEvent) => {
    if (!suppressPaste) return;
    reset();
    // Chromium still dispatches paste after a canceled auxclick. xterm's paste
    // handler forwards it regardless of defaultPrevented, so stop it in capture.
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  container.addEventListener("auxclick", handle, true);
  container.addEventListener("paste", paste, true);
  container.addEventListener("mousedown", reset, true);
  container.addEventListener("keydown", reset, true);
  return () => {
    container.removeEventListener("auxclick", handle, true);
    container.removeEventListener("paste", paste, true);
    container.removeEventListener("mousedown", reset, true);
    container.removeEventListener("keydown", reset, true);
  };
}
