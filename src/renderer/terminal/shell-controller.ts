import { isUserThemeId } from "../../shared/theme-validation";
import type { SetupState } from "../../shared/setup";
import { resolveTerminalTheme } from "../../shared/terminal-themes";
import type { TerminalThemeChoice } from "../../shared/terminal-theme";
import { alternateScroll } from "./alternate-scroll";
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
  onCreated?: (id: string, title: string) => void,
  autoStart = true,
  focusOnOpen = true,
  available: (id: string) => boolean = () => true,
  hasExited: (id: string) => boolean = () => false,
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
  let themeChoice: TerminalThemeChoice = "follow";
  const theme = () => resolveTerminalTheme(themeChoice, colors.matches);
  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: '"Hack Nerd Font Mono", "Geist Mono", monospace',
    scrollback: 10000,
    theme: theme(),
  });
  suppressTerminalReplies(terminal);
  const terminalColors = new TerminalColors(
    terminal.parser,
    theme(),
    () => {},
    () => {
      terminal.options.theme = { ...theme(), ...terminalColors.theme() };
    },
  );
  const updateTheme = () => {
    terminalColors.reset(theme());
    terminal.options.theme = { ...theme(), ...terminalColors.theme() };
    document.documentElement.style.setProperty("--terminal-background", theme().background);
    document.documentElement.style.setProperty("--terminal-foreground", theme().foreground);
  };
  const interfaceChanged = () => {
    if (themeChoice === "follow") updateTheme();
  };
  colors.addEventListener("change", interfaceChanged);
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  let disposed = false;
  const isDisposed = () => disposed;
  let activeId: string | undefined;
  let shellId: string | undefined;
  const exits = new Map<string, number>();
  const removed = new Set<string>();
  const isAvailable = (id: string) => available(id) && !removed.has(id);
  let selection = Promise.resolve();
  let request = 0;
  let attached = false;
  let visibleRequested = initiallyOpen;
  const wantsVisible = () => visibleRequested;
  let busy = false;
  let fontResizePending = false;
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
    terminal.options.disableStdin = exited;
    terminal.options.cursorBlink = !exited;
    if (fontResizePending) resize();
    view.toggleDisabled = busy || !activeId;
    view.restartDisabled = busy || !exited || (activeId !== undefined && activeId !== shellId);
    publish();
  };
  const release = (id: string) => {
    if (activeId !== id) return;
    ++request;
    activeId = undefined;
    visibleRequested = false;
    visibility(false);
    controls();
  };
  let suspended: { id: string; request: number } | undefined;
  const offRemoved = window.desktop.onTerminalAvailability((id, available, reset) => {
    if (reset) exits.delete(id);
    if (available) {
      removed.delete(id);
      if (suspended?.id === id) {
        if (suspended.request === request) void select(id);
        suspended = undefined;
      }
    } else {
      const selected = activeId === id;
      removed.add(id);
      release(id);
      if (selected) suspended = { id, request };
    }
  });
  const offData = window.desktop.onData((id, token, data) => {
    if (id !== activeId || !attached) return;
    // A restored snapshot may show the cursor again; keep exited screens read-only.
    terminal.write(exited ? `${data}\x1b[?25l` : data, () => {
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
    terminal.write("\x1b[?25l");
    if (hostFailed) {
      activeId = undefined;
      visibility(false);
    }
    controls();
  });
  terminal.onData((data) => {
    if (activeId && attached && !busy && !exited) window.desktop.input(activeId, data);
  });
  const wheel = alternateScroll(terminal, (data) => {
    if (activeId && attached && !busy && !exited) window.desktop.input(activeId, data, "wheel");
  });
  terminal.attachCustomWheelEventHandler((event) => wheel.handle(event));
  const resize = () => {
    if (!attached || busy) return;
    fit.fit();
    view.cols = terminal.cols;
    view.rows = terminal.rows;
    publish();
    fontResizePending = false;
    if (activeId) window.desktop.resize(activeId, terminal.cols, terminal.rows);
  };
  // Subscribe before loading so a late initial response cannot undo a live change.
  let settingsChanged = false;
  const applyFont = (size: number) => {
    if (isDisposed() || terminal.options.fontSize === size) return;
    terminal.options.fontSize = size;
    fontResizePending = true;
    resize();
  };
  const applyTheme = (choice: TerminalThemeChoice) => {
    if (isDisposed() || JSON.stringify(choice) === JSON.stringify(themeChoice)) return;
    themeChoice = choice;
    updateTheme();
  };
  const selectedTheme = (state: SetupState): TerminalThemeChoice =>
    isUserThemeId(state.settings.terminalTheme)
      ? (state.themes?.terminal.find((entry) => entry.id === state.settings.terminalTheme)?.theme ??
        "follow")
      : state.settings.terminalTheme;
  const offSetup = window.desktop.onSetupChange((state) => {
    settingsChanged = true;
    applyFont(state.settings.terminalFontSize);
    applyTheme(selectedTheme(state));
  });
  const initialSettings = window.desktop.setupState().then(
    (state) => {
      if (!settingsChanged) {
        applyFont(state.settings.terminalFontSize);
        applyTheme(selectedTheme(state));
      }
    },
    () => undefined,
  );
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  const openView = async (id: string) => {
    // Drain writes from the old attachment before resetting, including delayed ACKs.
    await new Promise<void>((resolve) => {
      terminal.write("", resolve);
    });
    if (isDisposed() || !wantsVisible() || !isAvailable(id)) return;
    wheel.reset();
    terminal.reset();
    if (exited) terminal.write("\x1b[?25l");
    controls();
    updateTheme();
    visibility(true);
    fit.fit();
    view.cols = terminal.cols;
    view.rows = terminal.rows;
    publish();
    fontResizePending = false;
    window.desktop.resize(id, terminal.cols, terminal.rows);
    await window.desktop.attach(id);
    if (!wantsVisible()) {
      visibility(false);
      if (isAvailable(id)) await window.desktop.detach(id);
    } else if (!isDisposed() && focusOnOpen) terminal.focus();
  };
  const toggleView = async () => {
    if (busy || !activeId) return;
    visibleRequested = !attached;
    busy = true;
    controls();
    try {
      if (attached) {
        visibility(false);
        if (isAvailable(activeId)) await window.desktop.detach(activeId);
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
      view.cols = terminal.cols;
      view.rows = terminal.rows;
      publish();
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
    colors.removeEventListener("change", interfaceChanged);
    observer.disconnect();
    offData();
    offExit();
    offRemoved();
    offSetup();
    if (activeId && attached && isAvailable(activeId))
      void window.desktop.detach(activeId).catch(() => {});
    terminal.dispose();
  };
  // Measure the first grid only after the bundled terminal face is available.
  const initialReady = Promise.allSettled([
    initialSettings,
    document.fonts.load('14px "Hack Nerd Font Mono"'),
    document.fonts.load('bold 14px "Hack Nerd Font Mono"'),
  ]).then(() => {
    // xterm caches character metrics during open(), before FitAddon runs.
    if (!isDisposed()) terminal.open(container);
  });
  let ready = autoStart ? initialReady.then(start) : initialReady;
  const select = (id: string) => {
    const current = ++request;
    visibleRequested = false;
    selection = selection.then(async () => {
      await ready;
      if (isDisposed() || current !== request || !isAvailable(id)) return;
      visibleRequested = true;
      busy = true;
      controls();
      try {
        if (attached && activeId === id) {
          if (focusOnOpen) terminal.focus();
          return;
        }
        const previous = attached ? activeId : undefined;
        visibility(false);
        activeId = undefined;
        // Removal can revoke the old capability before selection catches up.
        // Its failed detach must not prevent attaching the next owned terminal.
        if (previous && isAvailable(previous))
          await window.desktop.detach(previous).catch(() => {});
        if (isDisposed() || current !== request || !isAvailable(id)) return;
        activeId = id;
        const code = exits.get(id);
        exited = code !== undefined || hasExited(id);
        hostFailed = code === -1;
        terminalStatus = code === undefined ? "Terminal" : `Terminal exited (${String(code)})`;
        view.state = code === undefined ? "quiet_ok" : code === 0 ? "done" : "failed";
        view.status = terminalStatus;
        await openView(id);
      } catch (error: unknown) {
        visibility(false);
        if (isAvailable(id)) await window.desktop.detach(id).catch(() => {});
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
    release,
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
      ready = initialReady.then(start);
      return ready;
    },
    dispose,
    tail: () => (activeId ? window.desktop.tail(activeId, 40) : Promise.resolve([])),
    owns: (id: string) => id === activeId,
  };
}
