import { createSampleSource } from "./board-source";
import { sampleRows } from "./board";
import { createShell } from "./shell-controller";
import type { BoardSource } from "./board-source.d";
import type { ShellView } from "./shell.d";

/** Temporary shell + sample adapter. Live worktree/verdict IPC is #57. */
export function createAppSource(): BoardSource {
  const samples = createSampleSource([
    {
      id: "local-shell",
      kind: "shell",
      repository: "Local",
      branch: "Shell",
      agent: "Shell",
      state: "quiet_ok",
      reason: "Starting shell…",
      rate: 0,
      waitingSince: 0,
      seen: false,
      tail: [],
    },
    ...sampleRows(Date.now()),
  ]);
  let controller: ReturnType<typeof createShell> | undefined;
  let view: ShellView = {
    status: "Starting shell…",
    state: "quiet_ok",
    toggleLabel: "Open terminal",
    visible: false,
    toggleDisabled: true,
    restartDisabled: true,
  };
  const listeners = new Set<() => void>();
  return {
    ...samples,
    tail: (id) => (id === "local-shell" && controller ? controller.tail() : samples.tail(id)),
    shell: {
      getSnapshot: () => view,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      mount: (element, onHide) => {
        controller = createShell(
          element,
          (next) => {
            if (view.status !== next.status || view.state !== next.state) {
              samples.update("local-shell", {
                reason: `${next.status} · process: shell`,
                state: next.state,
                ...(view.state !== next.state ? { seen: next.visible } : {}),
              });
            }
            view = next;
            for (const listener of listeners) listener();
          },
          false,
          onHide,
        );
        const off = window.desktop.onActivity((batch) => {
          for (const { id, rate } of batch) {
            if (controller?.owns(id)) samples.setActivity("local-shell", rate);
          }
        });
        // Demonstrate the activity contract without changing row/verdict snapshots.
        let tick = 0;
        const timer = window.setInterval(() => {
          tick++;
          for (const row of samples.getSnapshot()) {
            if (row.kind === "sample")
              samples.setActivity(row.id, 2000 + 1800 * Math.sin(tick / 8));
          }
        }, 100);
        return () => {
          window.clearInterval(timer);
          off();
          controller?.dispose();
          controller = undefined;
        };
      },
      open: async () => {
        await controller?.open();
      },
      hide: async () => {
        await controller?.hide();
      },
      toggle: async () => {
        await controller?.toggle();
      },
      restart: async () => {
        await controller?.restart();
      },
    },
  };
}
