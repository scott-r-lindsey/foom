import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const container = document.querySelector<HTMLElement>("#terminal");
const status = document.querySelector<HTMLElement>("#status");
const restart = document.querySelector<HTMLButtonElement>("#restart");
if (!container || !status || !restart) throw new Error("Missing terminal elements");
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
const updateTheme = () => {
  terminal.options.theme = theme();
};
colors.addEventListener("change", updateTheme);
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
  colors.removeEventListener("change", updateTheme);
  observer.disconnect();
  offData();
  offExit();
  terminal.dispose();
});
// Measure the first grid only after the bundled terminal face is available.
void document.fonts.load('14px "Geist Mono"').then(start, start);
