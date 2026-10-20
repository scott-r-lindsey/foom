import { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal, IDisposable } from "@xterm/xterm";

// Leave room beneath Chromium's commonly observed 16-context limit. A lower
// platform limit or external context loss still degrades the affected view to DOM.
const CONTEXT_BUDGET = 12;
let activeContexts = 0;

/** Optional acceleration belongs to a mounted view, never to the PTY lifecycle. */
export function createWebglRenderer(terminal: Pick<Terminal, "loadAddon">, fallback: () => void) {
  let addon: WebglAddon | undefined;
  let loss: IDisposable | undefined;
  let failed = false;
  let disposed = false;
  const release = () => {
    loss?.dispose();
    loss = undefined;
    const previous = addon;
    addon = undefined;
    if (previous) {
      activeContexts--;
      previous.dispose();
    }
  };
  return {
    visible: (visible: boolean) => {
      if (!visible) {
        release();
        return;
      }
      if (disposed || failed || addon || activeContexts >= CONTEXT_BUDGET) return;
      try {
        addon = new WebglAddon();
        activeContexts++;
        loss = addon.onContextLoss(() => {
          // A lost or unavailable context stays on DOM for this controller's life.
          // Disposing the addon reinstates xterm's DOM renderer without a reset.
          failed = true;
          release();
          fallback();
        });
        terminal.loadAddon(addon);
      } catch {
        failed = true;
        release();
        fallback();
      }
    },
    dispose: () => {
      disposed = true;
      release();
    },
  };
}
