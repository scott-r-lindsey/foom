import { createShell } from "./shell-controller";
import type { TerminalViewSource } from "./terminal-view-source.d";
import type { ShellView } from "./shell.d";
/** A view never creates or stops a process. Workspace lifecycle remains in main. */
export function createTerminalView(
  schedule: (operation: () => Promise<void>) => Promise<void> = (operation) => operation(),
  owners = new Map<string, ReturnType<typeof createShell>>(),
): TerminalViewSource {
  let controller: ReturnType<typeof createShell> | undefined;
  let snapshot: ShellView = {
    status: "Terminal",
    state: "quiet_ok",
    visible: false,
    toggleLabel: "Open terminal",
    toggleDisabled: true,
    restartDisabled: true,
  };
  const listeners = new Set<() => void>();
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
      );
      return () => {
        const previous = controller;
        controller = undefined;
        void schedule(async () => {
          await previous?.hide();
          previous?.dispose();
          for (const [session, owner] of owners) if (owner === previous) owners.delete(session);
        });
      };
    },
    open: (id) =>
      schedule(async () => {
        const current = controller;
        if (!current) return;
        const previous = owners.get(id);
        if (previous && previous !== current) await previous.hide();
        for (const [session, owner] of owners) if (owner === current) owners.delete(session);
        await current.open(id);
        owners.set(id, current);
      }),
    hide: () =>
      schedule(async () => {
        await controller?.hide();
      }),
    focus: () => {
      void schedule(() => {
        controller?.terminal.focus();
        return Promise.resolve();
      });
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
