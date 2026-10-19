// Research bundle only. Never imported by the shipped renderer.
import { WebglAddon } from "@xterm/addon-webgl";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

type Shell = {
  terminal: Terminal;
  fit: FitAddon;
  container: HTMLElement;
  addon?: WebglAddon;
  state: string;
  events: string[];
  disposed: boolean;
  losses: number;
  terminalDisposals: number;
  disposals: number;
  id: () => string | undefined;
};
declare const FOOM_EVALUATE_WEBGL: boolean;
const store: { shells: Shell[]; limit: number; active: number } = {
  shells: [],
  limit: 12,
  active: 0,
};
Object.assign(globalThis, { __xtermEval: store });

export function track(
  terminal: Terminal,
  container: HTMLElement,
  id: Shell["id"],
  fit: FitAddon,
): Shell {
  const shell: Shell = {
    terminal,
    fit,
    container,
    id,
    state: "dom",
    events: [],
    disposed: false,
    losses: 0,
    disposals: 0,
    terminalDisposals: 0,
  };
  store.shells.push(shell);
  const terminalDispose = terminal.dispose.bind(terminal);
  terminal.dispose = () => {
    shell.terminalDisposals++;
    terminalDispose();
  };
  const reset = terminal.reset.bind(terminal);
  terminal.reset = () => {
    shell.events.push("reset");
    reset();
  };
  return shell;
}
function release(shell: Shell, state: string) {
  const addon = shell.addon;
  if (addon) {
    shell.addon = undefined;
    store.active--;
    shell.disposals++;
    addon.dispose();
  }
  shell.state = state;
  shell.container.dataset.webgl = state;
}
export function visibility(shell: Shell, visible: boolean) {
  if (!visible) {
    release(shell, shell.state === "lost" ? "lost" : "dom-hidden");
    return;
  }
  if (!FOOM_EVALUATE_WEBGL || shell.addon || shell.state === "lost" || shell.state === "failed")
    return;
  if (store.active >= store.limit) {
    shell.state = "dom-budget";
    shell.container.dataset.webgl = shell.state;
    return;
  }
  const addon = new WebglAddon();
  shell.addon = addon;
  store.active++;
  addon.onContextLoss(() => {
    shell.losses++;
    shell.events.push("context-loss");
    release(shell, "lost");
  });
  try {
    shell.terminal.loadAddon(addon);
    shell.state = "active";
    shell.container.dataset.webgl = "active";
  } catch (error) {
    shell.events.push(String(error));
    release(shell, "failed");
  }
}
export function dispose(shell: Shell) {
  release(shell, "disposed");
  shell.disposed = true;
  shell.events.push("dispose");
}
export function event(shell: Shell, name: string) {
  if (shell.events.length < 512) shell.events.push(name);
}
