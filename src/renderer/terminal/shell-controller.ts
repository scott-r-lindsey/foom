import { TerminalColors } from "../../shared/terminal-colors";
import { Terminal } from "@xterm/xterm";
import { suppressTerminalReplies } from "./terminal-replies";
import { FitAddon } from "@xterm/addon-fit";
import type { ShellView } from "./shell.d";

/** Imperative terminal lifecycle; output never enters React state. */
export function createShell(
  container: HTMLElement,
  update: (view: ShellView) => void,
  initiallyOpen = true,
  onEscape?: () => void,
  onCreated?: (id: string, title: string) => void,
  autoStart = true,
) {
  const view: ShellView = {
    status: "Starting shell…",
    state: "quiet_ok",
    toggleLabel: "Open terminal",
    visible: false,
    toggleDisabled: true,
    restartDisabled: true,
  };
  const publish = () => {
    if (!isDisposed()) update({ ...view });
  };
  const colors = matchMedia("(prefers-color-scheme: dark)");
  const theme = () => {
    const style = getComputedStyle(document.documentElement);
    const token = (name: string) => style.getPropertyValue(`--${name}`).trim();
    return {
      background: token("bg"),
      foreground: token("ink"),
      cursor: token("accent"),
      cursorAccent: token("bg"),
      selectionBackground: token("line"),
    };
  };
  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: '"Geist Mono", monospace',
    scrollback: 10000,
    theme: theme(),
  });
  suppressTerminalReplies(terminal);
  const terminalColors = new TerminalColors(
    terminal.parser,
    colors.matches,
    () => {},
    () => {
      terminal.options.theme = { ...theme(), ...terminalColors.theme() };
    },
  );
  const updateTheme = () => {
    terminalColors.reset(colors.matches);
    terminal.options.theme = { ...theme(), ...terminalColors.theme() };
  };
  colors.addEventListener("change", updateTheme);
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(container);
  let disposed = false;
  const isDisposed = () => disposed;
  let activeId: string | undefined;
  let shellId: string | undefined;
  const exits = new Map<string, number>();
  let selection = Promise.resolve();
  let request = 0;
  let attached = false;
  let visibleRequested = initiallyOpen;
  const wantsVisible = () => visibleRequested;
  let busy = false;
  let exited = false;
  let hostFailed = false;
  let terminalStatus = "Starting shell…";
  const showOperationError = (prefix: string, error: unknown) => {
    // Host exit can arrive before a pending IPC operation rejects.
    view.status = hostFailed
      ? terminalStatus
      : `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
    publish();
  };
  const visibility = (visible: boolean) => {
    attached = visible;
    container.hidden = !visible;
    view.toggleLabel = visible ? "Hide terminal" : "Open terminal";
    view.visible = visible;
    publish();
  };
  const controls = () => {
    view.toggleDisabled = busy || !activeId;
    view.restartDisabled = busy || !exited || (activeId !== undefined && activeId !== shellId);
    publish();
  };
  const offData = window.desktop.onData((id, token, data) => {
    if (id !== activeId || !attached) return;
    terminal.write(data, () => {
      window.desktop.acknowledge(id, token, data.length);
    });
  });
  const offExit = window.desktop.onExit((id, code) => {
    exits.set(id, code);
    if (id !== activeId) return;
    hostFailed = code === -1;
    terminalStatus = hostFailed
      ? "Terminal host failed. Restart the shell to continue."
      : `Shell exited (${String(code)})`;
    view.status = terminalStatus;
    view.state = code === 0 ? "done" : "failed";
    exited = true;
    controls();
  });
  terminal.onData((data) => {
    if (activeId && attached && !busy) window.desktop.input(activeId, data);
  });
  const resize = () => {
    if (!attached || busy) return;
    fit.fit();
    if (activeId) window.desktop.resize(activeId, terminal.cols, terminal.rows);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  const openView = async (id: string) => {
    // Drain writes from the old attachment before resetting, including delayed ACKs.
    await new Promise<void>((resolve) => {
      terminal.write("", resolve);
    });
    if (isDisposed() || !wantsVisible()) return;
    terminal.reset();
    updateTheme();
    visibility(true);
    fit.fit();
    window.desktop.resize(id, terminal.cols, terminal.rows);
    await window.desktop.attach(id);
    if (!wantsVisible()) {
      visibility(false);
      await window.desktop.detach(id);
    } else if (!isDisposed()) terminal.focus();
  };
  const toggleView = async () => {
    if (busy || !activeId) return;
    visibleRequested = !attached;
    busy = true;
    controls();
    try {
      if (attached) {
        visibility(false);
        await window.desktop.detach(activeId);
      } else {
        await openView(activeId);
      }
      view.status = terminalStatus;
    } catch (error: unknown) {
      visibility(false);
      showOperationError("Unable to change terminal view", error);
    } finally {
      busy = false;
      controls();
    }
  };
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.key !== "Escape") return true;
    if (event.type === "keydown") {
      if (onEscape) onEscape();
      else void toggleView();
    }
    return false;
  });
  const start = async () => {
    if (isDisposed() || busy) return;
    busy = true;
    hostFailed = false;
    view.state = "quiet_ok";
    view.status = "Starting shell…";
    controls();
    visibility(false);
    try {
      if (activeId) {
        const previous = activeId;
        activeId = undefined;
        if (previous === shellId) await window.desktop.kill(previous);
        else await window.desktop.detach(previous);
        if (isDisposed()) return;
      }
      // The view must be visible to measure the initial grid.
      container.hidden = false;
      fit.fit();
      const created = await window.desktop.create(terminal.cols, terminal.rows);
      if (isDisposed()) {
        await window.desktop.kill(created.id);
        return;
      }
      activeId = created.id;
      shellId = created.id;
      onCreated?.(created.id, created.title);
      exited = false;
      terminalStatus = created.title;
      view.status = terminalStatus;
      if (wantsVisible()) await openView(created.id);
      else visibility(false);
    } catch (error: unknown) {
      visibility(false);
      view.state = "failed";
      showOperationError("Unable to start shell", error);
      exited = true;
    } finally {
      busy = false;
      controls();
    }
  };
  const dispose = () => {
    disposed = true;
    visibleRequested = false;
    colors.removeEventListener("change", updateTheme);
    observer.disconnect();
    offData();
    offExit();
    if (activeId) void window.desktop.detach(activeId).catch(() => {});
    terminal.dispose();
  };
  // Measure the first grid only after the bundled terminal face is available.
  let ready = autoStart
    ? document.fonts.load('14px "Geist Mono"').then(start, start)
    : Promise.resolve();
  const select = (id: string) => {
    const current = ++request;
    visibleRequested = false;
    selection = selection.then(async () => {
      await ready;
      if (isDisposed() || current !== request) return;
      visibleRequested = true;
      busy = true;
      controls();
      try {
        if (attached && activeId === id) {
          terminal.focus();
          return;
        }
        const previous = activeId;
        visibility(false);
        if (previous) await window.desktop.detach(previous);
        if (isDisposed() || current !== request) return;
        activeId = id;
        const code = exits.get(id);
        exited = code !== undefined;
        hostFailed = code === -1;
        terminalStatus = code === undefined ? "Terminal" : `Terminal exited (${String(code)})`;
        view.state = code === undefined ? "quiet_ok" : code === 0 ? "done" : "failed";
        view.status = terminalStatus;
        await openView(id);
      } catch (error: unknown) {
        visibility(false);
        await window.desktop.detach(id).catch(() => {});
        showOperationError("Unable to open terminal", error);
      } finally {
        busy = false;
        controls();
      }
    });
    return selection;
  };

  return {
    terminal,
    open: async (id?: string) => {
      if (id) return select(id);
      visibleRequested = true;
      if (!attached) await toggleView();
    },
    hide: async () => {
      const current = ++request;
      visibleRequested = false;
      selection = selection.then(async () => {
        if (isDisposed() || current !== request) return;
        if (busy) visibility(false);
        else if (attached) await toggleView();
      });
      await selection;
    },
    toggle: toggleView,
    restart: () => {
      visibleRequested = true;
      // The board follows the new ID before its attachment has finished.
      ready = start();
      return ready;
    },
    dispose,
    tail: () => (activeId ? window.desktop.tail(activeId, 40) : Promise.resolve([])),
    owns: (id: string) => id === activeId,
  };
}
