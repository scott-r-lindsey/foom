import { TerminalInputOrder } from "./input-order";
import { copyOnSelect } from "./copy-on-select";
import { terminalFontStack, TERMINAL_FONT_FALLBACK } from "../../shared/terminal-fonts";
import { isUserThemeId } from "../../shared/theme-validation";
import type { SetupState } from "../../shared/setup";
import { resolveTerminalTheme } from "../../shared/terminal-themes";
import type { TerminalThemeChoice } from "../../shared/terminal-theme";
import { alternateScroll } from "./alternate-scroll";
import { suppressTrackedMiddleClick, emulateMiddleClickPaste } from "./middle-click";
import { TerminalColors } from "../../shared/terminal-colors";
import { Terminal } from "@xterm/xterm";
import { suppressTerminalReplies } from "./terminal-replies";
import { FitAddon } from "@xterm/addon-fit";
import { createWebglRenderer } from "./webgl-renderer";
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
  // Restored sessions have no PTY to attach. Keep the initial xterm out of view
  // until openView makes an actual attachment visible.
  container.hidden = true;
  const view: ShellView = {
    status: "Starting shell…",
    state: "quiet_ok",
    toggleLabel: "Open terminal",
    visible: false,
    attaching: true,
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
    fontFamily: TERMINAL_FONT_FALLBACK,
    scrollback: 10000,
    theme: theme(),
  });
  const renderer = createWebglRenderer(terminal, () => {
    // DOM and WebGL round cell widths differently; refit without reattaching or
    // resetting either screen when acceleration becomes unavailable.
    fontResizePending = true;
    resize();
  });
  suppressTerminalReplies(terminal);
  const offMiddleClick = suppressTrackedMiddleClick(container, terminal);
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
  let lastLiveViewId: string | undefined;
  let shellId: string | undefined;
  let pendingId: string | undefined;
  const exits = new Map<string, number>();
  const removed = new Set<string>();
  const isAvailable = (id: string) => available(id) && !removed.has(id);
  let selection = Promise.resolve();
  let request = 0;
  const inputOrder = new TerminalInputOrder();
  let attached = false;
  let selectionCopyEnabled = false;
  const offSelectionCopy = copyOnSelect(container, terminal, () =>
    selectionCopyEnabled && attached && !busy ? activeId : undefined,
  );
  const offSelectionPaste = emulateMiddleClickPaste(
    container,
    terminal,
    undefined,
    navigator.platform,
    () => attached && !busy && !exited,
  );
  let visibleRequested = initiallyOpen;
  const wantsVisible = () => visibleRequested;
  let busy = false;
  let fontResizePending = false;
  let exited = false;
  let hostFailed = false;
  let terminalStatus = "Starting shell…";
  const showOperationError = (prefix: string, _error: unknown) => {
    // Host exit can arrive before a pending IPC operation rejects.
    view.status = hostFailed ? terminalStatus : prefix;
    publish();
  };
  const paste = async () => {
    if (!activeId || !attached || busy || exited) return;
    const id = activeId;
    const generation = request;
    const live = () =>
      !isDisposed() && activeId === id && generation === request && attached && !busy && !exited;
    try {
      await inputOrder.paste(
        window.desktop.pasteTerminal(id),
        (result) => {
          view.pasteResult =
            result.kind === "unsupported"
              ? "Image paste is not supported for this session."
              : result.kind === "failed" || result.kind === "cancelled"
                ? "Unable to paste clipboard contents."
                : undefined;
          if (result.kind === "text") terminal.paste(result.text);
          publish();
        },
        live,
      );
    } catch {
      if (live()) {
        view.pasteResult = "Unable to paste clipboard contents.";
        publish();
      }
    }
  };
  terminal.attachCustomKeyEventHandler((event) => {
    const shortcut =
      event.key.toLowerCase() === "v" &&
      !event.altKey &&
      (navigator.platform.startsWith("Mac")
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey);
    if (!shortcut) return true;
    event.preventDefault();
    event.stopPropagation();
    if (event.type === "keydown") void paste();
    return false;
  });
  let primarySelection = false;
  const pasteMouse = (event: MouseEvent) => {
    primarySelection = event.button === 1;
  };
  const pasteKey = () => {
    primarySelection = false;
  };
  const clipboardPaste = (event: ClipboardEvent) => {
    // Linux primary selection remains owned by xterm/middle-click.ts.
    if (primarySelection && navigator.platform.includes("Linux")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void paste();
  };
  container.addEventListener("mousedown", pasteMouse, true);
  container.addEventListener("keydown", pasteKey, true);
  container.addEventListener("paste", clipboardPaste, true);
  let parsedFrame = false;
  let frameGeneration = 0;
  const frame = terminal.onRender(() => {
    if (!attached || !parsedFrame || view.firstFrame) return;
    view.firstFrame = true;
    view.attaching = false;
    publish();
  });
  const visibility = (visible: boolean) => {
    if (!visible) {
      ++frameGeneration;
      parsedFrame = false;
      view.attaching = false;
    }
    if (!visible) {
      inputOrder.cancel();
      view.pasteResult = undefined;
    }
    attached = visible;
    container.hidden = !visible;
    renderer.visible(visible);
    view.toggleLabel = visible ? "Hide terminal" : "Open terminal";
    view.visible = visible;
    publish();
  };
  const controls = () => {
    // Match the input guard: focus/paint can precede the attachment RPC settling.
    terminal.options.disableStdin = exited || busy;
    if (exited) terminal.options.cursorBlink = false;
    if (fontResizePending) resize();
    view.toggleDisabled = busy || !activeId;
    view.restartDisabled = busy || !exited || (activeId !== undefined && activeId !== shellId);
    publish();
  };
  const releaseSelection = (id: string) => {
    if (activeId !== id) return;
    ++request;
    activeId = undefined;
    visibleRequested = false;
    visibility(false);
    controls();
  };
  let suspended: { id: string; request: number } | undefined;
  const release = (id: string) => {
    if (lastLiveViewId === id) lastLiveViewId = undefined;
    exits.delete(id);
    removed.delete(id);
    if (pendingId === id) {
      pendingId = undefined;
      ++request;
    }
    if (suspended?.id === id) suspended = undefined;
    releaseSelection(id);
  };
  const relevant = (id: string) => id === activeId || id === pendingId || id === suspended?.id;
  const pruneEvents = () => {
    for (const id of exits.keys()) if (!relevant(id)) exits.delete(id);
    for (const id of removed) if (!relevant(id)) removed.delete(id);
  };
  const offRemoved = window.desktop.onTerminalAvailability((id, available, reset) => {
    if (!relevant(id)) return;
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
      releaseSelection(id);
      if (selected) suspended = { id, request };
    }
  });
  const offData = window.desktop.onData((id, token, data) => {
    if (id !== activeId || !attached) return;
    // A restored snapshot may show the cursor again; keep exited screens read-only.
    const current = frameGeneration;
    terminal.write(exited ? `${data}\x1b[?25l` : data, () => {
      if (!isDisposed() && attached && current === frameGeneration) parsedFrame = true;
      window.desktop.acknowledge(id, token, data.length);
    });
  });
  const offExit = window.desktop.onExit((id, code) => {
    if (!relevant(id)) return;
    exits.set(id, code);
    if (id !== activeId) return;
    hostFailed = code === -1;
    terminalStatus = hostFailed
      ? "Terminal host failed. Restart the shell to continue."
      : `Shell exited (${String(code)})`;
    view.status = terminalStatus;
    view.state = code === 0 ? "done" : "failed";
    exited = true;
    lastLiveViewId = undefined;
    terminal.write("\x1b[?25l");
    if (hostFailed) {
      activeId = undefined;
      visibility(false);
    }
    controls();
  });
  const sendInput = (data: string, origin?: "wheel") => {
    const id = activeId;
    const generation = request;
    if (!id) return;
    inputOrder.input(
      data.length,
      () => {
        if (origin === undefined) window.desktop.input(id, data);
        else window.desktop.input(id, data, origin);
      },
      () =>
        !isDisposed() && id === activeId && generation === request && attached && !busy && !exited,
    );
  };
  terminal.onData((data) => {
    sendInput(data);
  });
  const wheel = alternateScroll(terminal, (data) => {
    sendInput(data, "wheel");
  });
  terminal.attachCustomWheelEventHandler((event) => wheel.handle(event));
  const board = container.closest(".board-home");
  let sidebarChanging = false;
  let sidebarFrame: number | undefined;
  let measuredWidth: number | undefined;
  let measuredHeight: number | undefined;
  const resize = () => {
    if (!attached || busy || sidebarChanging) return;
    const sidebar = board?.querySelector(".sidebar-shell");
    if (sidebar?.getAttribute("data-resizing") === "true") return;
    if (sidebar?.getAnimations().some((animation) => animation.playState === "running")) return;
    const bounds = container.getBoundingClientRect();
    if (!fontResizePending && bounds.width === measuredWidth && bounds.height === measuredHeight)
      return;
    measuredWidth = bounds.width;
    measuredHeight = bounds.height;
    const dimensions = fit.proposeDimensions();
    if (
      !fontResizePending &&
      dimensions &&
      dimensions.cols === view.cols &&
      dimensions.rows === view.rows
    )
      return;
    fit.fit();
    // Subpixel layout changes can leave the fitted cell grid unchanged.
    const resizeHost =
      fontResizePending || view.cols !== terminal.cols || view.rows !== terminal.rows;
    view.cols = terminal.cols;
    view.rows = terminal.rows;
    publish();
    fontResizePending = false;
    if (activeId && resizeHost) window.desktop.resize(activeId, terminal.cols, terminal.rows);
  };
  // Subscribe before loading so a late initial response cannot undo a live change.
  let settingsChanged = false;
  const applyFont = (size: number, family: unknown) => {
    const stack = terminalFontStack(family);
    if (
      isDisposed() ||
      (terminal.options.fontSize === size && terminal.options.fontFamily === stack)
    )
      return;
    terminal.options.fontSize = size;
    terminal.options.fontFamily = stack;
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
    selectionCopyEnabled = state.settings.copyOnSelect;
    applyFont(state.settings.terminalFontSize, state.settings.terminalFont);
    applyTheme(selectedTheme(state));
  });
  const initialSettings = window.desktop.setupState().then(
    (state) => {
      if (!settingsChanged) {
        selectionCopyEnabled = state.settings.copyOnSelect;
        applyFont(state.settings.terminalFontSize, state.settings.terminalFont);
        applyTheme(selectedTheme(state));
      }
    },
    () => undefined,
  );
  const sidebarTransition = (event: Event) => {
    if (!(event instanceof TransitionEvent) || event.propertyName !== "flex-basis") return;
    if (sidebarFrame !== undefined) cancelAnimationFrame(sidebarFrame);
    sidebarFrame = undefined;
    sidebarChanging = true;
    if (event.type !== "transitionrun") {
      sidebarFrame = requestAnimationFrame(() => {
        sidebarFrame = undefined;
        sidebarChanging = false;
        resize();
      });
    }
  };
  board?.addEventListener("sidebar-resize-end", resize);
  board?.addEventListener("transitionrun", sidebarTransition);
  board?.addEventListener("transitionend", sidebarTransition);
  board?.addEventListener("transitioncancel", sidebarTransition);
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  const openView = async (id: string) => {
    view.attaching = !view.firstFrame;
    publish();
    // Drain writes from the old attachment before resetting, including delayed ACKs.
    await new Promise<void>((resolve) => {
      terminal.write("", resolve);
    });
    if (isDisposed() || !wantsVisible() || !isAvailable(id)) return;
    wheel.reset();
    terminal.reset();
    terminal.options.cursorBlink = !exited;
    // xterm reset retains cursor hiding. Preserve it for the same live session
    // on older hosts without DECTCEM; a different session starts visible.
    // Explicit modes in newer snapshots remain authoritative in either case.
    if (exited) terminal.write("\x1b[?25l");
    else if (lastLiveViewId !== id) terminal.write("\x1b[?25h");
    lastLiveViewId = exited ? undefined : id;
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
    view.firstFrame = false;
    view.attaching = true;
    publish();
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
      pruneEvents();
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
    if (sidebarFrame !== undefined) cancelAnimationFrame(sidebarFrame);
    board?.removeEventListener("sidebar-resize-end", resize);
    board?.removeEventListener("transitionrun", sidebarTransition);
    board?.removeEventListener("transitionend", sidebarTransition);
    board?.removeEventListener("transitioncancel", sidebarTransition);
    frame.dispose();
    offData();
    offExit();
    offRemoved();
    offSetup();
    inputOrder.cancel();
    offMiddleClick();
    container.removeEventListener("mousedown", pasteMouse, true);
    container.removeEventListener("keydown", pasteKey, true);
    container.removeEventListener("paste", clipboardPaste, true);
    offSelectionPaste();
    offSelectionCopy();
    if (activeId && attached && isAvailable(activeId))
      void window.desktop.detach(activeId).catch(() => {});
    renderer.dispose();
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
    pendingId = id;
    suspended = undefined;
    pruneEvents();
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
        if (activeId !== id) view.firstFrame = false;
        activeId = undefined;
        // Removal can revoke the old capability before selection catches up.
        // Its failed detach must not prevent attaching the next owned terminal.
        if (previous && isAvailable(previous))
          await window.desktop.detach(previous).catch(() => {});
        if (isDisposed() || current !== request || !isAvailable(id)) return;
        activeId = id;
        pendingId = undefined;
        pruneEvents();
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
    paste,
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
