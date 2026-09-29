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
let activeId: string | undefined;
const offData = window.desktop.onData((id, token, data) => {
  if (id !== activeId) return;
  terminal.write(data, () => {
    window.desktop.acknowledge(id, token, data.length);
  });
});
const offExit = window.desktop.onExit((id, code) => {
  if (id !== activeId) return;
  status.textContent = `Shell exited (${String(code)})`;
  restart.disabled = false;
});
terminal.onData((data) => {
  if (activeId) window.desktop.input(activeId, data);
});
const resize = () => {
  fit.fit();
  if (activeId) window.desktop.resize(activeId, terminal.cols, terminal.rows);
};
const observer = new ResizeObserver(resize);
observer.observe(container);
const start = async () => {
  restart.disabled = true;
  terminal.reset();
  fit.fit();
  status.textContent = "Starting shell…";
  try {
    if (activeId) {
      const previous = activeId;
      activeId = undefined;
      await window.desktop.kill(previous);
    }
    const created = await window.desktop.create(terminal.cols, terminal.rows);
    activeId = created.id;
    status.textContent = created.title;
    await window.desktop.attach(created.id);
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
