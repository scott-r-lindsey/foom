import type { SidebarMachine } from "../../shared/workspace";
import type { PreviewOpenAction } from "../../shared/previews";
import type { SidebarCommandResult } from "../../shared/workspace";
import type { PreviewSummary } from "../../shared/workspace";
import type { HomeShellFacts } from "../../shared/panel";
import type { ExecutionSnapshot } from "../../shared/execution";
import { createTerminalView } from "../terminal/terminal-view-source";
import type { SidebarRepository } from "./sidebar.d";
import type { createShell } from "../terminal/shell-controller";
import { repositoryKey } from "./sidebar-model";
import type { BackgroundErrorReporter, BoardSource } from "./board-source.d";
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
  let inventoryLoaded = false;
  let workspaceSnapshot: WorkspaceSnapshot | undefined;
  let errors: BackgroundErrorReporter | undefined;
  const inventoryFailures = new Set<string>();
  let inventoryRevision = 0;
  let appliedInventoryRevision = 0;
  let inventoryErrorRevision = 0;
  // Locally published IDs need a read begun after publication to remove them.
  // Older worktree membership can still refresh the rest of the sidebar.
  const previewPublications = new Map<string, number>();
  const refreshInventory = async ({
    active = () => true,
    reportFailure = false,
  }: {
    active?: () => boolean;
    reportFailure?: boolean;
  } = {}): Promise<boolean> => {
    const revision = ++inventoryRevision;
    let inventory: Awaited<ReturnType<typeof window.desktop.sidebarInventory>>;
    try {
      inventory = await window.desktop.sidebarInventory();
    } catch (error) {
      if (revision !== inventoryRevision || !active()) return false;
      if (!reportFailure) throw error;
      inventoryErrorRevision = revision;
      errors?.report("sidebar-refresh", "Unable to load sidebar inventory.");
      return false;
    }
    // A pending or failed newer read provides no replacement for good data.
    if (revision <= appliedInventoryRevision || !active()) return false;
    inventoryLoaded = true;
    const previous = new Map(sidebar.map((repo) => [repo.path, repo]));
    const failed = new Set<string>();
    sidebar = inventory.repositories.map((repo) => {
      if (!repo.unavailable) return repo;
      const operation = `sidebar-inventory:${repo.path}`;
      failed.add(operation);
      if (!inventoryFailures.has(operation))
        errors?.report(operation, "Repository unavailable.", repositoryKey(repo.path));
      return { ...repo, worktrees: previous.get(repo.path)?.worktrees ?? repo.worktrees };
    });
    for (const operation of inventoryFailures) if (!failed.has(operation)) errors?.clear(operation);
    inventoryFailures.clear();
    for (const operation of failed) inventoryFailures.add(operation);
    const incoming = inventory.previews ?? [];
    const known = new Set(incoming.map((preview) => preview.id));
    previews = [
      ...incoming,
      ...previews.filter(
        (preview) =>
          !known.has(preview.id) && revision <= (previewPublications.get(preview.id) ?? -1),
      ),
    ];
    for (const [id, published] of previewPublications)
      if (revision > published) previewPublications.delete(id);
    previewActions = inventory.previewActions ?? [];
    shellName = inventory.shell;
    home = inventory.home;
    machines = inventory.machines ?? [];
    appliedInventoryRevision = revision;
    if (revision > inventoryErrorRevision) errors?.clear("sidebar-refresh");
    return true;
  };
  let rows: readonly BoardRow[] = [];
  let repositories: readonly string[] = [];
  let sidebar: readonly SidebarRepository[] = [];
  let previews: readonly PreviewSummary[] = [];
  let previewActions: readonly PreviewOpenAction[] = [];
  let shellName = "Shell";
  let home: HomeShellFacts | undefined;
  let machines: readonly SidebarMachine[] = [];
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
  // Events may precede their first inventory. Bound that exception independently
  // of the number of sessions the user has opened during this window's lifetime.
  const pendingEvents = new Set<string>();
  const forget = (id: string) => {
    executions.delete(id);
    states.delete(id);
    snapshotStates.delete(id);
    exits.delete(id);
    rates.delete(id);
    pendingEvents.delete(id);
  };
  const retainEvent = (id: string) => {
    if (rows.some((row) => row.id === id)) return;
    pendingEvents.add(id);
    if (pendingEvents.size > 256) {
      const oldest = pendingEvents.values().next().value;
      if (oldest !== undefined) forget(oldest);
    }
  };
  const reconcileCaches = () => {
    const ids = new Set(rows.map((row) => row.id));
    for (const id of ids) pendingEvents.delete(id);
    for (const cache of [executions, states, snapshotStates, exits, rates])
      for (const id of cache.keys()) if (!ids.has(id) && !pendingEvents.has(id)) forget(id);
  };
  const publish = () => {
    for (const listener of listeners) listener();
  };
  const rememberPreview = (preview: PreviewSummary) => {
    const repository =
      previews.find((entry) => entry.id === preview.id)?.repository ??
      sidebar.find((entry) => entry.worktrees.some((tree) => tree.path === preview.worktree))
        ?.path ??
      "";
    previews = [...previews.filter((entry) => entry.id !== preview.id), { ...preview, repository }];
    previewPublications.set(preview.id, inventoryRevision);
  };
  const stateRow = (row: BoardRow, state: TerminalState): BoardRow => ({
    ...row,
    rate: rates.get(row.id) ?? row.rate,
    state: state.waitingOn ? "waiting" : state.state,
    waitingOn: state.waitingOn,
    reason: state.waitingOn
      ? `Waiting on ${String(state.waitingOn)}`
      : state.signal === "probe:waiting"
        ? state.reason
        : `${state.reason} · ${state.signal}`,
    verdictId: state.verdictId,
    waitingSince:
      !state.waitingOn && state.state === "needs_input"
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
    if (
      live?.signal === "probe:waiting" ||
      snapshot?.signal === "probe:waiting" ||
      snapshot?.signal === "orchestration:unread"
    )
      return snapshot;
    // A refreshed projection can clear Waiting without a new verdict. Preserve
    // event precedence for distinct verdicts that happen within the same millisecond.
    const sameVerdict =
      live &&
      snapshot &&
      live.verdictId === snapshot.verdictId &&
      live.state === snapshot.state &&
      live.signal === snapshot.signal &&
      live.reason === snapshot.reason;
    return live &&
      (!snapshot ||
        live.timestamp > snapshot.timestamp ||
        (live.timestamp === snapshot.timestamp && !sameVerdict))
      ? live
      : snapshot;
  };
  const executionRow = (row: BoardRow): BoardRow => {
    const execution = executions.get(row.id);
    if (!execution) return row;
    const currentVerdict = currentState(row.id) !== undefined;
    const state = ["orchestration:unread", "probe:waiting"].includes(
      currentState(row.id)?.signal ?? "",
    )
      ? "needs_input"
      : execution.phase === "working"
        ? "working"
        : execution.phase === "blocked"
          ? currentVerdict
            ? row.state
            : "needs_input"
          : (execution.phase === "starting" || execution.phase === "idle") &&
              (!currentVerdict || row.state === "working")
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
    const current = executionRow(latestVerdict(row));
    if (row.closeFailed)
      return { ...current, state: "failed", reason: "Close failed · cleanup may be incomplete" };
    return row.unavailable ? { ...current, reason: "Unavailable" } : current;
  };
  const latestVerdict = (row: BoardRow): BoardRow => {
    const state = currentState(row.id);
    const code = exits.get(row.id);
    if (code !== undefined && state?.state !== "done" && state?.state !== "failed")
      return {
        ...row,
        state: code === 0 ? "done" : "failed",
        waitingSince: 0,
        exitCode: code,
        reason: `Process exited (${String(code)}) · process:exit`,
        seen: false,
        exited: true,
      };
    return state
      ? {
          ...stateRow(row, state),
          ...(code === undefined ? {} : { exitCode: code }),
          exited: code !== undefined || row.exited === true,
        }
      : { ...row, rate: rates.get(row.id) ?? row.rate };
  };
  const snapshot = (next: WorkspaceSnapshot, settledReplacement?: string) => {
    workspaceSnapshot = next;
    loaded = true;
    repositories = next.repositories.map((repo) => repo.name);
    const known = new Map(rows.map((row) => [row.id, row]));
    const visible = next.terminals.filter((entry) => entry.closeState !== "closing");
    const live = visible.map((entry): BoardRow => {
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
      // A queued restore has no host yet; its old exited verdict is not a
      // failure of the replacement that is still starting.
      if (entry.state && !(entry.dormant && entry.exited === false))
        snapshotStates.set(entry.id, entry.state);
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
        reason: entry.dormant
          ? entry.exited === false
            ? "Starting"
            : "Exited · saved session"
          : "Running",
        rate: rates.get(entry.id) ?? 0,
        waitingSince: 0,
        seen: false,
        tail: [],
        ...known.get(entry.id),
        ...(entry.dormant
          ? {
              state: "quiet_ok",
              reason: entry.exited === false ? "Starting" : "Exited · saved session",
              seen: false,
            }
          : {}),
        branch: entry.config
          ? "Foom config"
          : entry.home
            ? "~"
            : ((checkout
                ? checkout.branch
                : entry.placement?.kind === "remote" &&
                    entry.branch?.endsWith(` · ${entry.placement.host}`)
                  ? entry.branch.slice(0, -` · ${entry.placement.host}`.length)
                  : entry.branch) ?? `⏣ ${checkout?.head?.slice(0, 7) ?? "Unknown"}`),
        home: entry.home === true,
        machine: entry.machine === true,
        placement: entry.placement,
        config: entry.config === true,
        probe: entry.probe === true,
        ...(entry.probeOwner ? { probeOwner: entry.probeOwner } : {}),
        probeNote: entry.probeNote === true,
        startedAt: entry.startedAt,
        exitCode: entry.exitCode,
        foregroundProgram: entry.foregroundProgram ?? "",
        ...(entry.recipe ? { recipe: true } : {}),
        launchFlags: entry.launchFlags,
        environment: entry.environment,
        orchestration: entry.orchestration,
        handoff: entry.handoff,
        review: entry.review,
        roleNotRestored: entry.roleNotRestored,
        mcpConnection: entry.mcpConnection,
        worktreeRemoved:
          inventoryLoaded &&
          !entry.home &&
          !entry.config &&
          !sidebar.find((repo) => repo.path === entry.repository)?.unavailable &&
          (!checkout || checkout.prunable) &&
          !(
            entry.placement?.kind === "remote" &&
            machines.some(
              (machine) =>
                machine.host ===
                  (entry.placement?.kind === "remote" ? entry.placement.host : undefined) &&
                !machine.available,
            )
          ),
        exited: entry.exited ?? exits.has(entry.id),
        bypass: entry.bypass === true,
        conversationId: entry.conversationId,
        unavailable:
          entry.placement?.kind === "remote" &&
          machines.some(
            (machine) =>
              machine.host ===
                (entry.placement?.kind === "remote" ? entry.placement.host : undefined) &&
              !machine.available,
          ),
        dormant:
          entry.dormant === true ||
          (entry.placement?.kind === "remote" &&
            machines.some(
              (machine) =>
                machine.host ===
                  (entry.placement?.kind === "remote" ? entry.placement.host : undefined) &&
                !machine.available,
            )),
        closeFailed: entry.closeState === "failed",
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
    reconcileCaches();
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
        forget(previous);
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
    } catch {
      rows = [
        ...rows.filter((row) => row.id !== shellId),
        {
          ...startupRow,
          id: shellId,
          state: "failed",
          exited: true,
          reason: "Unable to start shell.",
        },
      ];
      publish();
    } finally {
      starting = false;
    }
  };
  const connect: NonNullable<BoardSource["connect"]> = (reporter) => {
    errors = reporter;
    let disposed = false;
    let revision = 0;
    const refresh = async () => {
      const current = ++revision;
      const active = () => !disposed && current === revision;
      await Promise.all([
        (async () => {
          try {
            const next = await window.desktop.workspace();
            if (!active()) return;
            errors?.clear("workspace-refresh");
            snapshot(next);
          } catch {
            if (active()) errors?.report("workspace-refresh", "Unable to load terminals.");
          }
        })(),
        (async () => {
          if (!(await refreshInventory({ active: () => !disposed, reportFailure: true }))) return;
          if (workspaceSnapshot) snapshot(workspaceSnapshot);
          else {
            rows = [...rows];
            publish();
          }
        })(),
      ]);
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
      retainEvent(event.terminalId);
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
      retainEvent(state.id);
      states.set(state.id, state);
      rows = rows.map((row) => (row.id === state.id ? latest(row) : row));
      publish();
    });
    const offExit = window.desktop.onExit((id, code) => {
      retainEvent(id);
      exits.set(id, code);
      rows = rows.map((row) => (row.id === id ? latest(row) : row));
      publish();
    });
    const offActivity = window.desktop.onActivity((batch) => {
      for (const { id, rate } of batch) {
        retainEvent(id);
        rates.set(id, rate);
      }
      for (const listener of activityListeners) listener(batch);
    });
    void refresh();
    return () => {
      disposed = true;
      for (const operation of inventoryFailures) errors?.clear(operation);
      errors?.clear("workspace-refresh");
      errors?.clear("sidebar-refresh");
      errors = undefined;
      inventoryFailures.clear();
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
    previews: {
      isReady: () => inventoryLoaded,
      getSnapshot: () => previews,
      getHistory: () => previewActions,
      copyPath: (id) =>
        window.desktop.previews?.copyPath?.(id) ?? Promise.reject(new Error("Copy unavailable")),
      popout: (id) =>
        window.desktop.previews?.popout(id) ??
        Promise.reject(new Error("Preview host unavailable")),
      reload: (id) =>
        window.desktop.previews?.reload(id) ??
        Promise.reject(new Error("Preview host unavailable")),
      network: (id, enabled) =>
        window.desktop.previews?.network(id, enabled) ??
        Promise.reject(new Error("Preview host unavailable")),
      pick: async (worktree) => {
        const id = (await window.desktop.previews?.pick(worktree)) ?? null;
        if (id) {
          try {
            // The picker has already opened the record. Inventory failure must
            // take the same owned-record recovery path as a superseded reply.
            const applied = await refreshInventory().catch(() => false);
            if (!applied || !previews.some((preview) => preview.id === id)) {
              const preview = await window.desktop.previews?.describe?.(id);
              if (preview) {
                if (preview.id !== id) return null;
                rememberPreview(preview);
              }
            }
            if (!previews.some((preview) => preview.id === id)) return null;
            // The returned ID must survive reads already pending at publication.
            previewPublications.set(id, inventoryRevision);
          } finally {
            if (workspaceSnapshot) snapshot(workspaceSnapshot);
            else {
              rows = [...rows];
              publish();
            }
          }
        }
        return id;
      },
      bounds: (id, bounds) => window.desktop.previews?.bounds(id, bounds) ?? Promise.resolve(),
      close: (id) => window.desktop.previews?.close(id) ?? Promise.resolve(),
      ...(window.desktop.previews?.onPlace
        ? {
            onPlace: (callback) =>
              window.desktop.previews?.onPlace?.(async (id, expiresAt) => {
                if (window.desktop.previews?.describe) {
                  // Placement has its own deadline. Repository/host inventory can
                  // take longer; the already-authorized owned record is enough.
                  rememberPreview(await window.desktop.previews.describe(id));
                } else {
                  await refreshInventory();
                }
                rows = [...rows];
                publish();
                return callback(id, expiresAt);
              }) ?? (() => {}),
          }
        : {}),
    },
    connect,
    createHostView: () => createTerminalView(scheduleView, owners),
    closeHostSession: async (id) => {
      await window.desktop.kill(id);
      forget(id);
      snapshot(await window.desktop.workspace());
    },
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
    isSidebarReady: () => inventoryLoaded,
    getSidebar: () => sidebar,
    getMachines: () => machines,
    shellName: () => shellName,
    homeShell: () => home,
    config: {
      status: () => window.desktop.configStatus(),
      decide: (decision, id) => window.desktop.decideConfig(decision, id),
      subscribe: (listener) => window.desktop.onConfigChange(listener),
      openFolder: () => window.desktop.openConfigFolder(),
    },
    cancelSidebarLaunch: (id) => window.desktop.cancelSidebarLaunch(id),
    discardStartup: async (id) => {
      await window.desktop.kill(id);
      snapshot(await window.desktop.workspace());
    },
    panelFacts: (repository, worktree) => window.desktop.panelFacts(repository, worktree),
    messageBoard: window.desktop.messageBoard,
    actionLog: {
      read: (query) => window.desktop.actionLog(query),
      clear: () => window.desktop.clearActionLog(),
    },
    onFocusWorktree: (callback) => window.desktop.onFocusWorktree?.(callback) ?? (() => {}),
    sidebarCommand: async (command, startup) => {
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
      let result: SidebarCommandResult;
      const off = startup
        ? window.desktop.onSidebarLaunchStarted((id) => {
            if (id === startup.id) startup.started();
          })
        : undefined;
      try {
        result = await (startup
          ? window.desktop.sidebarCommand(command, startup.id)
          : window.desktop.sidebarCommand(command));
      } finally {
        off?.();
        if (command.kind === "resume" || command.kind === "new-conversation")
          snapshot(await window.desktop.workspace(), command.id);
      }
      if (
        command.kind === "close" &&
        !(await window.desktop.workspace()).terminals.some((row) => row.id === command.id)
      ) {
        forget(command.id);
        rows = rows.filter((row) => row.id !== command.id);
        if (command.id === shellId) shellId = pendingShell;
      }
      await refreshInventory();
      snapshot(await window.desktop.workspace());
      return result;
    },
    worktrees: {
      subscribe: (listener) => window.desktop.onSetupChange(listener),
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
          registeredHosts: setup.settings.registeredHosts ?? [],
          codeFolder: setup.settings.codeFolder,
          showNestedRepositoryNames: setup.settings.showNestedRepositoryNames,
        };
      },
      addRepository: () => window.desktop.addRepository(),
      branches: (repository) => window.desktop.branches(repository),
      create: async (repository, branch, host) => {
        const created =
          host === undefined
            ? await window.desktop.createWorktree(repository, branch)
            : await window.desktop.createWorktree(repository, branch, undefined, host);
        await refreshInventory();
        snapshot(await window.desktop.workspace());
        return created;
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
      if (rates.size) listener([...rates].map(([id, rate]) => ({ id, rate })));
      return () => {
        activityListeners.delete(listener);
      };
    },
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
