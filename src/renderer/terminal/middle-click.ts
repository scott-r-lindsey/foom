import type { SetupSource } from "../preflight/setup-source.d";
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

/** Bounded, window-local memory only. Disabling drops even the last selection. */
export class TerminalSelectionBuffer {
  private enabled = false;
  private text = "";

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) this.text = "";
  }

  select(text: string) {
    // Reject oversized selections whole rather than pasting a surprising prefix.
    if (this.enabled && text.length > 0 && text.length <= 65_536) this.text = text;
  }

  read() {
    return this.text;
  }
}

// One instance per board renderer; never crosses IPC, storage or clipboard APIs.
export const terminalSelectionBuffer = new TerminalSelectionBuffer();

/** Window lifetime, including periods without mounted terminals. */
export function attachTerminalSelectionBuffer(
  source: Pick<SetupSource, "state" | "subscribe">,
  buffer = terminalSelectionBuffer,
  platform = navigator.platform,
) {
  let changed = false;
  let disposed = false;
  const apply = (state: Awaited<ReturnType<SetupSource["state"]>>) => {
    buffer.setEnabled(platform.startsWith("Mac") && state.settings.middleClickPaste);
  };
  const off = source.subscribe((state) => {
    changed = true;
    if (!disposed) apply(state);
  });
  void source.state().then(
    (state) => {
      if (!changed && !disposed) apply(state);
    },
    () => {},
  );
  return () => {
    disposed = true;
    off();
    buffer.setEnabled(false);
  };
}

export function emulateMiddleClickPaste(
  container: HTMLElement,
  terminal: Pick<Terminal, "modes" | "getSelection" | "onSelectionChange" | "paste" | "focus">,
  buffer = terminalSelectionBuffer,
  platform = navigator.platform,
  acceptsInput: () => boolean = () => true,
) {
  if (!platform.startsWith("Mac")) return () => {};
  const selection = terminal.onSelectionChange(() => {
    buffer.select(terminal.getSelection());
  });
  const click = (event: MouseEvent) => {
    if (
      event.button !== 1 ||
      (!event.shiftKey && terminal.modes.mouseTrackingMode !== "none") ||
      !acceptsInput()
    )
      return;
    const text = buffer.read();
    if (!text) return;
    event.preventDefault();
    terminal.focus();
    terminal.paste(text);
  };
  container.addEventListener("auxclick", click, true);
  return () => {
    selection.dispose();
    container.removeEventListener("auxclick", click, true);
  };
}
