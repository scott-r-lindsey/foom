import { createShell } from "./shell-controller";
import type { TerminalViewSource } from "./terminal-view-source.d";
import type { ShellView } from "./shell.d";
// Focus choices span every tile sharing the renderer document.
let focusGeneration = 0;

/** A view never creates or stops a process. Workspace lifecycle remains in main. */
export function createTerminalView(
  schedule: (operation: () => Promise<void>) => Promise<void> = (operation) => operation(),
  owners = new Map<string, ReturnType<typeof createShell>>(),
  available: (id: string) => boolean = () => true,
  hasExited: (id: string) => boolean = () => false,
): TerminalViewSource {
  let controller: ReturnType<typeof createShell> | undefined;
  let cancelFocus: (() => void) | undefined;
  let snapshot: ShellView = {
    status: "Terminal",
    state: "quiet_ok",
    visible: false,
    attaching: true,
    toggleLabel: "Open terminal",
    toggleDisabled: true,
    restartDisabled: true,
  };
  const listeners = new Set<() => void>();
  const run = (operation: () => Promise<void>) =>
    schedule(operation).catch(() => {
      snapshot = {
        ...snapshot,
        status: "Unable to update terminal view.",
        attaching: false,
      };
      for (const listener of listeners) listener();
    });
  return {
    mount: (element) => {
      controller = createShell(
        element,
        (next) => {
          snapshot = next;
          for (const listener of listeners) listener();
        },
        false,
        undefined,
        false,
        false,
        available,
        hasExited,
      );
      return () => {
        cancelFocus?.();
        const previous = controller;
        controller = undefined;
        void run(async () => {
          try {
            await previous?.hide();
          } finally {
            previous?.dispose();
            for (const [session, owner] of owners) if (owner === previous) owners.delete(session);
          }
        });
      };
    },
    open: (id) =>
      run(async () => {
        const current = controller;
        if (!current || !available(id)) return;
        const previous = owners.get(id);
        if (previous && previous !== current) await previous.hide();
        for (const [session, owner] of owners) if (owner === current) owners.delete(session);
        await current.open(id);
        owners.set(id, current);
      }),
    hide: () => {
      // Reopening a modal revokes restoration immediately, before its hide
      // operation reaches the shared attachment queue.
      cancelFocus?.();
      return run(async () => {
        await controller?.hide();
      });
    },
    focus: ({ restore = false } = {}) => {
      cancelFocus?.();
      const current = controller;
      const generation = ++focusGeneration;
      const expected = document.activeElement;
      let cancelled = false;
      const cancel = () => {
        cancelled = true;
        document.removeEventListener("focusin", cancel, true);
        if (cancelFocus === cancel) cancelFocus = undefined;
      };
      cancelFocus = cancel;
      // A newer focus choice wins even if focus later returns to the opener.
      if (restore) document.addEventListener("focusin", cancel, true);
      void run(() => {
        if (
          !cancelled &&
          generation === focusGeneration &&
          (!restore || document.activeElement === expected)
        )
          current?.terminal.focus();
        return Promise.resolve();
      }).finally(cancel);
    },
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
