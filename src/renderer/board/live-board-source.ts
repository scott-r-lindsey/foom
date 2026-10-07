import { createTerminalView } from "../terminal/terminal-view-source";
import type { SidebarRepository } from "./sidebar.d";
import type { createShell } from "../terminal/shell-controller";
import type { BoardSource } from "./board-source.d";
import type { BoardRow } from "./board.d";
import type { TerminalActivity } from "../../shared/desktop";
import type { TerminalState, WorkspaceSnapshot } from "../../shared/workspace";

/** Live terminal truth comes from main; only seen state belongs to this adapter. */
export function createAppSource(): BoardSource {
  // Keep startup failures reachable so the user can retry the local shell.
  const pendingShell = "local-shell";
  const startupRow: BoardRow = {
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
  };
  const owners = new Map<string, ReturnType<typeof createShell>>();
  let viewQueue = Promise.resolve();
  const scheduleView = (operation: () => Promise<void>) => {
    viewQueue = viewQueue.then(operation, operation);
    return viewQueue;
  };
  let loaded = false;
  let rows: readonly BoardRow[] = [];
  let repositories: readonly string[] = [];
  let sidebar: readonly SidebarRepository[] = [];
  let shellName = "Shell";
  let shellId = pendingShell;
  const listeners = new Set<() => void>();
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
        exited: true,
      };
    return state
      ? { ...stateRow(row, state), exited: code !== undefined || row.exited === true }
      : { ...row, rate: rates.get(row.id) ?? row.rate };
  };
  const snapshot = (next: WorkspaceSnapshot) => {
    loaded = true;
    repositories = next.repositories.map((repo) => repo.name);
    const known = new Map(rows.map((row) => [row.id, row]));
    const live = next.terminals.map((entry): BoardRow => {
      const previousState = states.get(entry.id);
      if (entry.state && (!previousState || entry.state.timestamp > previousState.timestamp))
        states.set(entry.id, entry.state);
      return latest({
        id: entry.id,
        kind: entry.kind,
        managed: true,
        repositoryPath: entry.repository,
        worktree: entry.worktree,
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
        exited: entry.exited ?? exits.has(entry.id),
        bypass: entry.bypass === true,
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
    for (const [id, owner] of owners) {
      if (!rows.some((row) => row.id === id)) {
        owner.release(id);
        owners.delete(id);
      }
    }
    publish();
  };
  let starting = false;
  const restart = async () => {
    if (starting) return;
    starting = true;
    try {
      if (shellId !== pendingShell) {
        const previous = shellId;
        await owners.get(previous)?.hide();
        owners.get(previous)?.release(previous);
        owners.delete(previous);
        await window.desktop.kill(previous);
        rows = rows.filter((row) => row.id !== previous);
        shellId = pendingShell;
      }
      const created = await window.desktop.create(80, 24);
      rows = rows.filter((row) => row.id !== shellId);
      shellId = created.id;
      rows = [
        latest({ ...startupRow, id: created.id, state: "working", reason: created.title }),
        ...rows,
      ];
      publish();
    } catch (error) {
      rows = [
        ...rows.filter((row) => row.id !== shellId),
        {
          ...startupRow,
          id: shellId,
          state: "failed",
          exited: true,
          reason: `Unable to start shell: ${error instanceof Error ? error.message : String(error)}`,
        },
      ];
      publish();
    } finally {
      starting = false;
    }
  };
  const connect = () => {
    let disposed = false;
    let revision = 0;
    const refresh = async () => {
      const current = ++revision;
      try {
        const [next, inventory] = await Promise.all([
          window.desktop.workspace(),
          window.desktop.sidebarInventory(),
        ]);
        if (!disposed && current === revision) {
          sidebar = inventory.repositories;
          shellName = inventory.shell;
          snapshot(next);
        }
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
    return () => {
      disposed = true;
      offWorkspace();
      offState();
      offExit();
      offActivity();
    };
  };
  return {
    isDevelopment: window.desktop.isDevelopment,
    connect,
    createView: () => {
      const view = createTerminalView(scheduleView, owners, (id) =>
        rows.some((row) => row.id === id),
      );
      return {
        ...view,
        open: (id) =>
          id !== pendingShell && rows.some((row) => row.id === id) ? view.open(id) : view.hide(),
      };
    },
    isReady: () => loaded,
    getSidebar: () => sidebar,
    shellName: () => shellName,
    sidebarCommand: async (command) => {
      if ("id" in command && command.id === shellId && command.kind === "restart") {
        await restart();
        return;
      }
      if (command.kind === "close" && command.id === pendingShell) {
        rows = rows.filter((row) => row.id !== pendingShell);
        publish();
        return;
      }
      if (command.kind === "close" || command.kind === "restart") {
        await owners.get(command.id)?.hide();
        owners.get(command.id)?.release(command.id);
        owners.delete(command.id);
      }
      await window.desktop.sidebarCommand(command);
      if (command.kind === "close") {
        rows = rows.filter((row) => row.id !== command.id);
        if (command.id === shellId) shellId = pendingShell;
      }
      const inventory = await window.desktop.sidebarInventory();
      sidebar = inventory.repositories;
      shellName = inventory.shell;
      snapshot(await window.desktop.workspace());
    },
    worktrees: {
      load: async () => {
        const [workspace, scan, setup] = await Promise.all([
          window.desktop.workspace(),
          window.desktop.scanAgents(false),
          window.desktop.setupState(),
        ]);
        return {
          repositories: workspace.repositories,
          agents: scan.agents,
          enabled: setup.settings.agents,
          hooks: setup.settings.hooks,
          acknowledged: setup.settings.codexNotifierAcknowledged,
        };
      },
      addRepository: () => window.desktop.addRepository(),
      start: async (request) => {
        await window.desktop.startWorktree(request);
        snapshot(await window.desktop.workspace());
      },
      remove: async (id) => {
        const removed = await window.desktop.removeWorktree(id);
        if (removed) snapshot(await window.desktop.workspace());
        return removed;
      },
    },
    getSnapshot: () => rows,
    getRepositories: () => repositories,
    subscribeCommands: (listener) => window.desktop.onBoardCommand(listener),
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
    shell: { restart },
  };
}
