import { mountBoard, sampleRows } from "./board";
import { TerminalColors } from "../terminal-colors";
import { Terminal } from "@xterm/xterm";
import { suppressTerminalReplies } from "./terminal-replies";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const container = document.querySelector<HTMLElement>("#terminal");
const status = document.querySelector<HTMLElement>("#status");
const toggle = document.querySelector<HTMLButtonElement>("#toggle-terminal");
const restart = document.querySelector<HTMLButtonElement>("#restart");
if (!container || !status || !restart || !toggle) throw new Error("Missing terminal elements");
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
let activeId: string | undefined;
let attached = false;
let busy = false;
let exited = false;
let hostFailed = false;
let terminalStatus = "Starting shell…";
const showOperationError = (prefix: string, error: unknown) => {
  // Host exit can arrive before a pending IPC operation rejects.
  status.textContent = hostFailed
    ? terminalStatus
    : `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
};
const visibility = (visible: boolean) => {
  attached = visible;
  container.hidden = !visible;
  toggle.textContent = visible ? "Hide terminal" : "Open terminal";
  toggle.setAttribute("aria-expanded", String(visible));
};
const controls = () => {
  toggle.disabled = busy || !activeId;
  restart.disabled = busy || !exited;
};
const offData = window.desktop.onData((id, token, data) => {
  if (id !== activeId || !attached) return;
  terminal.write(data, () => {
    window.desktop.acknowledge(id, token, data.length);
  });
});
const offExit = window.desktop.onExit((id, code) => {
  if (id !== activeId) return;
  hostFailed = code === -1;
  terminalStatus = hostFailed
    ? "Terminal host failed. Restart the shell to continue."
    : `Shell exited (${String(code)})`;
  status.textContent = terminalStatus;
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
  terminal.reset();
  updateTheme();
  visibility(true);
  fit.fit();
  window.desktop.resize(id, terminal.cols, terminal.rows);
  await window.desktop.attach(id);
  terminal.focus();
};
const toggleView = async () => {
  if (busy || !activeId) return;
  busy = true;
  controls();
  try {
    if (attached) {
      visibility(false);
      await window.desktop.detach(activeId);
    } else {
      await openView(activeId);
    }
    status.textContent = terminalStatus;
  } catch (error: unknown) {
    visibility(false);
    showOperationError("Unable to change terminal view", error);
  } finally {
    busy = false;
    controls();
    if (!attached) toggle.focus();
  }
};
toggle.addEventListener("click", () => {
  void toggleView();
});
terminal.attachCustomKeyEventHandler((event) => {
  if (event.key !== "Escape") return true;
  if (event.type === "keydown") void toggleView();
  return false;
});
const start = async () => {
  if (busy) return;
  busy = true;
  controls();
  visibility(false);
  hostFailed = false;
  status.textContent = "Starting shell…";
  try {
    if (activeId) {
      const previous = activeId;
      activeId = undefined;
      await window.desktop.kill(previous);
    }
    // The view must be visible to measure the initial grid.
    container.hidden = false;
    fit.fit();
    const created = await window.desktop.create(terminal.cols, terminal.rows);
    activeId = created.id;
    exited = false;
    terminalStatus = created.title;
    status.textContent = terminalStatus;
    await openView(created.id);
  } catch (error: unknown) {
    visibility(false);
    showOperationError("Unable to start shell", error);
    exited = true;
  } finally {
    busy = false;
    controls();
  }
};
restart.addEventListener("click", () => {
  void start();
});
window.addEventListener("beforeunload", () => {
  colors.removeEventListener("change", updateTheme);
  observer.disconnect();
  offData();
  offExit();
  terminal.dispose();
});
// Measure the first grid only after the bundled terminal face is available.
void document.fonts.load('14px "Geist Mono"').then(start, start);

const board = mountBoard(document.body, sampleRows(Date.now()));
const boardButton = document.createElement("button");
boardButton.textContent = "Sample board";
boardButton.addEventListener("click", board.show);
toggle.after(boardButton);
window.addEventListener("beforeunload", board.dispose);
