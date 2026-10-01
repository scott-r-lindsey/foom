import { createShell } from "./shell-controller";
import type { BoardSource } from "./board-source.d";
import type { BoardRow } from "./board.d";
import type { ShellView } from "./shell.d";
import type { TerminalActivity } from "../shared/desktop";
import type { TerminalState, WorkspaceSnapshot } from "../shared/workspace";

/** Live terminal truth comes from main; only seen state belongs to this adapter. */
export function createAppSource(): BoardSource {
  // Keep startup failures reachable so the user can retry the local shell.
  const pendingShell = "local-shell";
  let rows: readonly BoardRow[] = [
    {
      id: pendingShell,
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
  ];
  let controller: ReturnType<typeof createShell> | undefined;
  let shellId = pendingShell;
  let view: ShellView = {
    status: "Starting shell…",
    state: "quiet_ok",
    toggleLabel: "Open terminal",
    visible: false,
    toggleDisabled: true,
    restartDisabled: true,
  };
  const listeners = new Set<() => void>();
  const viewListeners = new Set<() => void>();
  const activityListeners = new Set<(batch: readonly TerminalActivity[]) => void>();
  const states = new Map<string, TerminalState>();
  const exits = new Map<string, number>();
  const rates = new Map<string, number>();
  const publish = () => {
    for (const listener of listeners) listener();
  };
  const stateRow = (row: BoardRow, state: TerminalState): BoardRow => ({
    ...row,
    rate: rates.get(row.id) ?? row.rate,
    state: state.state,
    reason: `${state.reason} · ${state.signal}`,
    verdictId: state.verdictId,
    waitingSince:
      state.state === "needs_input"
        ? row.state === "needs_input"
          ? row.waitingSince
          : state.timestamp
        : 0,
    seen: row.state === state.state && row.verdictId === state.verdictId ? row.seen : false,
  });
  const latest = (row: BoardRow): BoardRow => {
    const state = states.get(row.id);
    const code = exits.get(row.id);
    if (code !== undefined && state?.state !== "done" && state?.state !== "failed")
      return {
        ...row,
        state: code === 0 ? "done" : "failed",
        waitingSince: 0,
        reason: `Process exited (${String(code)}) · process:exit`,
        seen: false,
      };
    return state ? stateRow(row, state) : { ...row, rate: rates.get(row.id) ?? row.rate };
  };
  const snapshot = (next: WorkspaceSnapshot) => {
    const known = new Map(rows.map((row) => [row.id, row]));
    const live = next.terminals.map((entry): BoardRow => {
      const previousState = states.get(entry.id);
      if (entry.state && (!previousState || entry.state.timestamp > previousState.timestamp))
        states.set(entry.id, entry.state);
      return latest({
        id: entry.id,
        kind: entry.kind,
        repository:
          next.repositories.find((repo) => repo.path === entry.repository)?.name ??
          entry.repository,
        branch: entry.branch ?? "Detached HEAD",
        agent: entry.agent,
        state: "working",
        reason: "Running",
        rate: rates.get(entry.id) ?? 0,
        waitingSince: 0,
        seen: false,
        tail: [],
        ...known.get(entry.id),
      });
    });
    // Keep surviving rows in place; append newly launched terminals.
    const incoming = new Map(live.map((row) => [row.id, row]));
    rows = rows
      .flatMap((row) => {
        if (row.id === shellId || row.kind === "sample") return [row];
        const nextRow = incoming.get(row.id);
        incoming.delete(row.id);
        return nextRow ? [nextRow] : [];
      })
      .concat([...incoming.values()]);
    publish();
  };
  return {
    getSnapshot: () => rows,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeActivity: (listener) => {
      activityListeners.add(listener);
      return () => {
        activityListeners.delete(listener);
      };
    },
    tail: (id) =>
      id !== pendingShell && rows.some((row) => row.id === id)
        ? window.desktop.tail(id, 40)
        : Promise.resolve([]),
    markSeen: (id) => {
      rows = rows.map((row) => (row.id === id ? { ...row, seen: true } : row));
      publish();
    },
    resolve: async (id) => {
      const row = rows.find((row) => row.id === id);
      if (row?.state === "needs_input")
        await window.desktop.feedback(id, row.verdictId ?? null, "dismissed");
    },
    shell: {
      getSnapshot: () => view,
      subscribe: (listener) => {
        viewListeners.add(listener);
        return () => {
          viewListeners.delete(listener);
        };
      },
      mount: (element, onHide) => {
        let disposed = false;
        let revision = 0;
        const refresh = async () => {
          const current = ++revision;
          try {
            const next = await window.desktop.workspace();
            if (!disposed && current === revision) snapshot(next);
          } catch (error) {
            if (!disposed) console.error("Unable to load terminals:", error);
          }
        };
        const offWorkspace = window.desktop.onWorkspaceChange(() => void refresh());
        const offState = window.desktop.onState((state) => {
          states.set(state.id, state);
          rows = rows.map((row) => (row.id === state.id ? latest(row) : row));
          publish();
        });
        const offExit = window.desktop.onExit((id, code) => {
          exits.set(id, code);
          rows = rows.map((row) => (row.id === id ? latest(row) : row));
          publish();
        });
        const offActivity = window.desktop.onActivity((batch) => {
          for (const { id, rate } of batch) rates.set(id, rate);
          for (const listener of activityListeners) listener(batch);
        });
        void refresh();
        controller = createShell(
          element,
          (next) => {
            view = next;
            if (shellId === pendingShell) {
              rows = rows.map((row) =>
                row.id === pendingShell ? { ...row, state: next.state, reason: next.status } : row,
              );
              publish();
            }
            for (const listener of viewListeners) listener();
          },
          false,
          onHide,
          (id, title) => {
            rows = rows.filter((row) => row.id !== shellId);
            shellId = id;
            rows = [
              latest({
                id,
                kind: "shell",
                repository: "Local",
                branch: "Shell",
                agent: "Shell",
                state: "working",
                reason: title,
                rate: 0,
                waitingSince: 0,
                seen: false,
                tail: [],
              }),
              ...rows,
            ];
            publish();
          },
        );
        return () => {
          disposed = true;
          offWorkspace();
          offState();
          offExit();
          offActivity();
          controller?.dispose();
          controller = undefined;
          states.clear();
          exits.clear();
          rates.clear();
        };
      },
      open: async (id) => {
        if (id && rows.some((row) => row.id === id))
          await controller?.open(id === pendingShell ? undefined : id);
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
