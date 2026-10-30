import { terminalContextMenu } from "./context-menu";
import type { TerminalContextMenu } from "./terminal-view-source.d";
import { createShell } from "./shell-controller";
import type { TerminalViewSource } from "./terminal-view-source.d";
import type { ShellView } from "./shell.d";
import {
  nextTerminalFocusGeneration,
  isCurrentTerminalFocusGeneration,
} from "../board/focus-restore";

/** A view never creates or stops a process. Workspace lifecycle remains in main. */
export function createTerminalView(
  schedule: (operation: () => Promise<void>) => Promise<void> = (operation) => operation(),
  owners = new Map<string, ReturnType<typeof createShell>>(),
  available: (id: string) => boolean = () => true,
  hasExited: (id: string) => boolean = () => false,
): TerminalViewSource {
  let controller: ReturnType<typeof createShell> | undefined;
  let session: string | undefined;
  const menus = new Set<(menu: TerminalContextMenu) => void>();
  let cancelFocus: (() => void) | undefined;
  let pendingRestoration: { from: Element | null } | undefined;
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
    onContextMenu: (listener) => {
      menus.add(listener);
      return () => {
        menus.delete(listener);
      };
    },
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
      const current = controller;
      const offMenu = terminalContextMenu(
        element,
        current.terminal,
        () =>
          controller === current && snapshot.visible && !snapshot.attaching ? session : undefined,
        (menu) => {
          for (const listener of menus) listener(menu);
        },
      );
      return () => {
        offMenu();
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
        session = id;
        owners.set(id, current);
      }),
    hide: () => {
      // Reopening a modal revokes restoration immediately, before its hide
      // operation reaches the shared attachment queue.
      cancelFocus?.();
      return run(async () => {
        const before = document.activeElement;
        await controller?.hide();
        // An earlier queued hide can blur the opener after a later dismissal
        // requested restoration. Preserve only that implicit body fallback.
        if (
          pendingRestoration &&
          pendingRestoration.from === before &&
          document.activeElement === document.body
        )
          pendingRestoration.from = document.body;
      });
    },
    focus: (restoration) => {
      if (restoration && !isCurrentTerminalFocusGeneration(restoration.generation)) return;
      cancelFocus?.();
      const current = controller;
      const generation = nextTerminalFocusGeneration();
      const expected = restoration ? { from: restoration.from } : undefined;
      pendingRestoration = expected;
      let cancelled = false;
      const cancel = () => {
        cancelled = true;
        document.removeEventListener("focusin", cancel, true);
        if (cancelFocus === cancel) {
          cancelFocus = undefined;
          pendingRestoration = undefined;
        }
      };
      cancelFocus = cancel;
      // A newer focus choice wins even if focus later returns to the opener.
      if (restoration) document.addEventListener("focusin", cancel, true);
      void run(() => {
        if (
          !cancelled &&
          isCurrentTerminalFocusGeneration(generation) &&
          (!expected || document.activeElement === expected.from)
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
