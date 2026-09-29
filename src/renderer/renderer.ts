import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const container = document.querySelector<HTMLElement>("#terminal");
const status = document.querySelector<HTMLElement>("#status");
const restart = document.querySelector<HTMLButtonElement>("#restart");
if (!container || !status || !restart) throw new Error("Missing terminal elements");
const terminal = new Terminal({
  cursorBlink: true,
  fontSize: 14,
  fontFamily: '"DejaVu Sans Mono", Consolas, monospace',
  scrollback: 10000,
  theme: { background: "#0c0d12", foreground: "#e1e3ee", cursor: "#a99aff" },
});
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open(container);
const offData = window.desktop.onData((data) => {
  terminal.write(data, () => {
    window.desktop.acknowledge(data.length);
  });
});
const offExit = window.desktop.onExit((code) => {
  status.textContent = `Shell exited (${String(code)})`;
  restart.disabled = false;
});
terminal.onData((data) => {
  window.desktop.input(data);
});
const resize = () => {
  fit.fit();
  window.desktop.resize(terminal.cols, terminal.rows);
};
const observer = new ResizeObserver(resize);
observer.observe(container);
const start = async () => {
  restart.disabled = true;
  terminal.reset();
  fit.fit();
  status.textContent = "Starting shell…";
  try {
    status.textContent = await window.desktop.start(terminal.cols, terminal.rows);
    terminal.focus();
  } catch (error: unknown) {
    status.textContent = `Unable to start shell: ${error instanceof Error ? error.message : String(error)}`;
    restart.disabled = false;
  }
};
restart.addEventListener("click", () => {
  void start();
});
window.addEventListener("beforeunload", () => {
  observer.disconnect();
  offData();
  offExit();
  terminal.dispose();
});
void start();
