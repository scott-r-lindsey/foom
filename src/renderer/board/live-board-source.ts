import type { ExecutionSnapshot } from "../../shared/execution";
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
  // Live events can arrive before their launch snapshot. Keep snapshot evidence
  // separate so replacing an old snapshot never discards those newer events.
  const executions = new Map<string, ExecutionSnapshot>();
  const acceptExecution = (next: ExecutionSnapshot) => {
    const old = executions.get(next.terminalId);
    if (
      !old ||
      next.launch > old.launch ||
      (next.launch === old.launch && next.revision > old.revision)
    )
      executions.set(next.terminalId, next);
  };
  const states = new Map<string, TerminalState>();
  const snapshotStates = new Map<string, TerminalState>();
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
  const currentState = (id: string): TerminalState | undefined => {
    const execution = executions.get(id);
    const current = (state: TerminalState | undefined) =>
      !execution ||
      (state?.execution?.launch === execution.launch &&
        state.execution.revision === execution.revision);
    const event = states.get(id);
    const saved = snapshotStates.get(id);
    const live = current(event) ? event : undefined;
    const snapshot = current(saved) ? saved : undefined;
    return live && (!snapshot || live.timestamp >= snapshot.timestamp) ? live : snapshot;
  };
  const executionRow = (row: BoardRow): BoardRow => {
    const execution = executions.get(row.id);
    if (!execution) return row;
    const currentVerdict = currentState(row.id) !== undefined;
    const state =
      execution.phase === "working"
        ? "working"
        : execution.phase === "blocked"
          ? currentVerdict
            ? row.state
            : "needs_input"
          : (execution.phase === "starting" || execution.phase === "idle") &&
              (!currentVerdict || row.state === "working" || row.state === "checking")
            ? "quiet_ok"
            : row.state;
    return {
      ...row,
      execution,
      state,
      reason:
        currentVerdict || execution.phase === "exited"
          ? row.reason
          : {
              starting: "Waiting for agent activity",
              idle: "Agent turn ended; checking result",
              working: "Agent is working",
              blocked: "Agent needs input",
            }[execution.phase],
      waitingSince: state === "needs_input" ? row.waitingSince || Date.now() : 0,
    };
  };
  const latest = (row: BoardRow): BoardRow => {
    const next = executionRow(latestVerdict(row));
    return next.readOnly && !next.reason.startsWith("Reviewing read-only · ")
      ? { ...next, reason: `Reviewing read-only · ${next.reason}` }
      : next;
  };
  const latestVerdict = (row: BoardRow): BoardRow => {
    const state = currentState(row.id);
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
  const snapshot = (next: WorkspaceSnapshot, settledReplacement?: string) => {
    loaded = true;
    repositories = next.repositories.map((repo) => repo.name);
    const known = new Map(rows.map((row) => [row.id, row]));
    const live = next.terminals.map((entry): BoardRow => {
      const previous = known.get(entry.id);
      const version = entry.launchVersion ?? 0;
      if (previous && (previous.launchVersion ?? 0) > version) {
        if (entry.id !== settledReplacement) return latest(previous);
        // A failure after host creation can retain the old saved record. The
        // snapshot explicitly requested after settlement is authoritative.
        states.delete(entry.id);
        exits.delete(entry.id);
        rates.delete(entry.id);
        known.delete(entry.id);
      }
      if (previous && version > (previous.launchVersion ?? 0)) known.delete(entry.id);
      const checkout = sidebar
        .find((repo) => repo.path === entry.repository)
        ?.worktrees.find((tree) => tree.path === entry.worktree);
      if (entry.execution) acceptExecution(entry.execution);
      if (entry.state) snapshotStates.set(entry.id, entry.state);
      else snapshotStates.delete(entry.id);
      return latest({
        id: entry.id,
        kind: entry.kind,
        managed: true,
        repositoryPath: entry.repository,
        worktree: entry.worktree,
        repository:
          next.repositories.find((repo) => repo.path === entry.repository)?.name ??
          entry.repository,
        agent: entry.agent,
        state: entry.dormant || entry.kind === "agent" ? "quiet_ok" : "working",
        reason: entry.dormant ? "Exited · saved session" : "Running",
        rate: rates.get(entry.id) ?? 0,
        waitingSince: 0,
        seen: false,
        tail: [],
        ...known.get(entry.id),
        ...(entry.dormant
          ? { state: "quiet_ok", reason: "Exited · saved session", seen: false }
          : {}),
        branch: (checkout ? checkout.branch : entry.branch) ?? "Detached HEAD",
        worktreeRemoved: !checkout || checkout.prunable,
        exited: entry.exited ?? exits.has(entry.id),
        bypass: entry.bypass === true,
        readOnly: entry.readOnly === true,
        conversationId: entry.conversationId,
        dormant: entry.dormant === true,
        launchVersion: entry.launchVersion ?? 0,
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
      if (!rows.some((row) => row.id === id && !row.dormant)) {
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
    // Main publishes reset after revoking the old host and before forwarding
    // replacement events. Old snapshots must not cross this launch boundary.
    const offAvailability = window.desktop.onTerminalAvailability((id, available, reset) => {
      if (!available || !reset) return;
      states.delete(id);
      snapshotStates.delete(id);
      exits.delete(id);
      rates.delete(id);
      rows = rows.map((row) =>
        row.id === id
          ? {
              ...row,
              launchVersion: (row.launchVersion ?? 0) + 1,
              state: "working",
              reason: "Starting…",
              exited: false,
              dormant: false,
              verdictId: null,
              waitingSince: 0,
              rate: 0,
              tail: [],
              seen: false,
            }
          : row,
      );
      publish();
    });
    const offExecution = window.desktop.onExecution((event) => {
      acceptExecution(event);
      rows = rows.map((row) => (row.id === event.terminalId ? latest(row) : row));
      publish();
    });
    const offState = window.desktop.onState((state) => {
      if (state.execution) {
        const current = executions.get(state.id);
        if (
          current &&
          (state.execution.launch < current.launch ||
            (state.execution.launch === current.launch &&
              state.execution.revision < current.revision))
        )
          return;
        acceptExecution(state.execution);
      }
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
      offAvailability();
      offState();
      offExecution();
      offExit();
      offActivity();
    };
  };
  return {
    ...(window.desktop.windows ? { windows: window.desktop.windows } : {}),
    isDevelopment: window.desktop.isDevelopment,
    connect,
    createView: () => {
      const view = createTerminalView(
        scheduleView,
        owners,
        (id) => rows.some((row) => row.id === id && !row.dormant),
        (id) => rows.some((row) => row.id === id && row.exited === true),
      );
      return {
        ...view,
        open: (id) =>
          id !== pendingShell && rows.some((row) => row.id === id && !row.dormant)
            ? view.open(id)
            : view.hide(),
      };
    },
    confirmations: window.desktop.confirmations,
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
      if (
        command.kind === "close" ||
        command.kind === "restart" ||
        command.kind === "resume" ||
        command.kind === "new-conversation"
      ) {
        await owners.get(command.id)?.hide();
        owners.get(command.id)?.release(command.id);
        owners.delete(command.id);
      }
      if (command.kind === "resume" || command.kind === "new-conversation") {
        states.delete(command.id);
        snapshotStates.delete(command.id);
        exits.delete(command.id);
        rates.delete(command.id);
        rows = rows.map((row) =>
          row.id === command.id
            ? { ...row, state: "working", reason: "Starting…", tail: [], seen: false }
            : row,
        );
      }
      try {
        await window.desktop.sidebarCommand(command);
      } finally {
        if (command.kind === "resume" || command.kind === "new-conversation")
          snapshot(await window.desktop.workspace(), command.id);
      }
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
      confirmations: window.desktop.confirmations,
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
    appMenu: window.desktop.appMenu,
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
      id !== pendingShell && rows.some((row) => row.id === id && !row.dormant)
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
