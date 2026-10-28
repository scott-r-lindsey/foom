import {
  useImperativeHandle,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { AgentId } from "../../shared/agents";
import type { ConfigStatus } from "../../shared/foom-config";
import type { PreviewSummary } from "../../shared/workspace";
import { AgentBadge } from "./agent-badge";
import type { LaunchOptions } from "./board-source.d";
import type { BoardRow } from "./board.d";
import type { PanelSubject } from "./panel-facts";
import { PanelIntent } from "./panel-intent";
import type { RowAction } from "./row-menu";
import {
  agentBadges,
  agentNames,
  buildSidebar,
  previewOpener,
  repositoryKey,
  repositoryDisplayName,
  rowRepository,
  rowWorktree,
  sessionIdentity,
  sessionName,
  sidebarParent,
  sidebarRepositories,
  worktreeKey,
} from "./sidebar-model";
import { renameSession } from "./sidebar-preferences";
import { SidebarPreviewRow } from "./sidebar-preview-row";
import { SidebarSessionRow } from "./sidebar-session-row";
import type { SidebarLocation } from "./sidebar.d";
import { useSidebarLayout } from "./use-sidebar-layout";

import type { SidebarProps } from "./sidebar-view.d";
export function launcherActions(
  options: LaunchOptions | undefined,
  shell: string | undefined,
): { label: string; badge: string; run: AgentId }[] {
  return [
    ...(options?.agents
      .filter((agent) => agent.path && options.enabled[agent.id] !== false)
      .map((agent) => ({
        label: agent.name ?? agentNames.get(agent.id) ?? agent.id,
        badge: agent.mark ?? agentBadges.get(agent.id) ?? agent.id,
        run: agent.id,
      })) ?? []),
    { label: shell ? `Shell (${shell})` : "Shell", badge: ">_", run: "shell" },
  ];
}
export function useSidebar(props: SidebarProps) {
  const {
    source,
    setCollapsed,
    dragging,
    revealRef,
    inactive,
    rows,
    preferences,
    save,
    selected,
    buttons,
    sidebar,
    open,
    focus,
    newWorktreeRef,
    command,
    options,
    tileNumbers,
    previews = [],
    openPreview,
    otherViews,
    openSettings,
  } = props;
  const [now] = useState(Date.now);
  const [filter, setFilter] = useState("");
  const [hoveredSession, setHoveredSession] = useState<string>();
  const [focusedSession, setFocusedSession] = useState<string>();
  const [error, setError] = useState("");
  const [dismissedCleanup, setDismissedCleanup] = useState<ReadonlySet<string>>(() => new Set());
  const dismissCleanup = (key: string) => {
    setDismissedCleanup((previous) => (previous.has(key) ? previous : new Set([...previous, key])));
  };
  const [intent] = useState(() => new PanelIntent());
  const [configStatus, setConfigStatus] = useState<ConfigStatus>();
  useEffect(() => {
    const config = source.config;
    if (!config) return;
    let active = true;
    void config.status().then(
      (status) => {
        if (active) setConfigStatus(status);
      },
      () => {},
    );
    const unsubscribe = config.subscribe(setConfigStatus);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [source]);
  const menu = useSyncExternalStore(intent.subscribe, intent.getSnapshot);
  // The branch field and a new row's arrival are view state: they never outlive this window.
  const [arrival, setArrival] = useState<string>();
  const anchorsRef = useRef(new Map<string, HTMLElement>());
  // Rows that must render before they can take a panel or focus.
  const pendingRef = useRef<{ field?: string | undefined; focus?: string | undefined }>({});
  const settleTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(
    () => () => {
      clearTimeout(settleTimerRef.current);
    },
    [],
  );
  const settle = (path: string, delay: number) => {
    clearTimeout(settleTimerRef.current);
    // Hover settles after a moment, so a row arriving under the pointer still shows its motion.
    settleTimerRef.current = setTimeout(() => {
      setArrival((current) => (current === path ? undefined : current));
    }, delay);
  };
  const openField = (id: string, anchor: HTMLElement) => {
    if (intent.getSnapshot()?.id !== id) intent.close();
    intent.pin(id, anchor, true);
  };
  useLayoutEffect(() => {
    const pending = pendingRef.current;
    const anchor = pending.field && anchorsRef.current.get(pending.field);
    if (pending.field && anchor) {
      openField(pending.field, anchor);
      pending.field = undefined;
    }
    const row = pending.focus && anchorsRef.current.get(pending.focus);
    if (row) {
      row.focus({ preventScroll: true });
      row.scrollIntoView({ block: "nearest" });
      pending.focus = undefined;
    }
  });
  const fieldOpen = Boolean(menu?.field);
  useEffect(
    () => () => {
      intent.dispose();
    },
    [intent],
  );
  useEffect(() => {
    intent.drag(Boolean(dragging));
  }, [intent, dragging]);
  useLayoutEffect(() => {
    revealRef.current = (row) => {
      setFilter("");
      intent.close();
      save({
        ...preferences,
        expanded: {
          ...preferences.expanded,
          [repositoryKey(rowRepository(row))]: true,
          [worktreeKey(rowWorktree(row))]: true,
        },
      });
    };
    return () => {
      revealRef.current = undefined;
    };
  }, [preferences, save, revealRef, intent, rows]);
  const closeMenu = useCallback(() => {
    intent.close();
  }, [intent]);
  const {
    overlay,
    setOverlay,
    narrow,
    shellRef,
    toggleButtonRef,
    compact,
    toggleSidebar,
    toggleLabel,
    shortcut,
  } = useSidebarLayout(props, closeMenu);
  const repositories = sidebarRepositories(
    rows.filter((row) => !row.home && !row.config),
    source.getSidebar?.() ??
      (source.getRepositories?.() ?? []).map((name) => ({ name, path: name, worktrees: [] })),
  ).map((repository) => ({
    ...repository,
    name: repositoryDisplayName(
      repository,
      options?.codeFolder,
      options?.showNestedRepositoryNames,
    ),
  }));
  const homeRows = rows.filter((row) => row.home);
  const visibleHomeRows = homeRows.filter((row) =>
    `${sessionName(row, preferences)} ${row.reason} ~`
      .toLocaleLowerCase()
      .includes(filter.trim().toLocaleLowerCase()),
  );
  const configRows = rows.filter((row) => row.config);
  const needsCount =
    rows.filter((row) => row.state === "needs_input").length + (configStatus?.pending ? 1 : 0);
  const { tree, hiddenNeeds } = buildSidebar(
    rows.filter((row) => !row.home && !row.config),
    repositories,
    preferences,
    compact ? "" : filter,
    previews,
  );
  const toggle = (id: string, expanded: boolean) => {
    save({ ...preferences, expanded: { ...preferences.expanded, [id]: !expanded } });
  };
  useLayoutEffect(() => {
    if (!newWorktreeRef) return;
    newWorktreeRef.current = (repository) => {
      const target =
        repository && repositories.some((entry) => entry.path === repository)
          ? repository
          : // The sidebar's own order, which puts repositories with sessions first.
            buildSidebar(
              rows.filter((row) => !row.home && !row.config),
              repositories,
              preferences,
              "",
            ).tree[0]?.repository.path;
      if (!target || !source.worktrees) return false;
      const id = repositoryKey(target);
      // A compact sidebar lists sessions only, so the panel opens beside the sidebar itself.
      const anchor = anchorsRef.current.get(id) ?? (compact ? sidebar.current : null);
      if (anchor) openField(id, anchor);
      else {
        // A filter hides the repository; clear it so its row can anchor the panel.
        pendingRef.current.field = id;
        setFilter("");
      }
      return true;
    };
    return () => {
      newWorktreeRef.current = undefined;
    };
  });
  const arrive = (repository: string, path: string) => {
    intent.close();
    // The row may be collapsed or filtered out; focus it once it renders. A compact
    // sidebar shows no worktree rows, so there is nothing to focus.
    if (!compact) pendingRef.current.focus = worktreeKey(path);
    setFilter("");
    save({
      ...preferences,
      expanded: { ...preferences.expanded, [repositoryKey(repository)]: true },
    });
    setArrival(path);
  };
  useEffect(
    () =>
      source.onFocusWorktree?.((path) => {
        const repository = source
          .getSidebar?.()
          .find((repo) => repo.worktrees.some((tree) => tree.path === path));
        if (!repository) return;
        pendingRef.current.focus = worktreeKey(path);
        setCollapsed?.(false);
        if (narrow) setOverlay(true);
        setFilter("");
        save({
          ...preferences,
          expanded: { ...preferences.expanded, [repositoryKey(repository.path)]: true },
        });
      }),
    [source, save, preferences, setCollapsed, narrow, setOverlay],
  );
  const launchers = (location: SidebarLocation) =>
    launcherActions(options, source.shellName?.()).map((action) => ({
      ...action,
      run: () => {
        return command({
          kind: "launch",
          repository: location.repository,
          worktree: location.worktree ?? location.repository,
          run: action.run,
        });
      },
    }));
  const subjects = new Map<
    string,
    { subject: PanelSubject; name: string; kind: string; mark: string }
  >();
  subjects.set("home", {
    subject: { kind: "home", home: source.homeShell?.(), rows: homeRows },
    name: `${source.shellName?.() ?? "Shell"} ~`,
    kind: "Home shell",
    mark: ">_",
  });
  subjects.set("config", {
    subject: { kind: "config", status: configStatus, rows: configRows },
    name: "Foom config",
    kind: "Settings folder",
    mark: "config",
  });
  for (const repository of repositories) {
    subjects.set(repositoryKey(repository.path), {
      subject: {
        kind: "repository",
        repository,
        rows: rows.filter((row) => rowRepository(row) === repository.path),
      },
      name: repository.name,
      kind: "Repository",
      mark: "repository",
    });
    for (const tree of repository.worktrees)
      subjects.set(worktreeKey(tree.path), {
        subject: { kind: "worktree", repository, tree },
        name:
          tree.path === repository.path
            ? "Main checkout"
            : (tree.branch ?? `Detached at ${tree.head?.slice(0, 7) ?? "Unknown"}`),
        kind: tree.path === repository.path ? repository.name : "Worktree",
        mark: tree.path === repository.path ? "checkout" : tree.branch ? "worktree" : "detached",
      });
  }
  for (const row of rows)
    subjects.set(row.id, {
      subject: { kind: "session", row, tile: tileNumbers?.get(row.id)?.number },
      name: sessionName(row, preferences),
      kind: row.kind === "shell" ? "Shell" : "Session",
      mark: row.kind === "shell" ? ">_" : (agentBadges.get(row.agent) ?? "?"),
    });
  const available = !menu || subjects.has(menu.id);
  useLayoutEffect(() => {
    if (menu && (!available || inactive || !menu.anchor.isConnected)) intent.close();
  });
  const rowEvents = (id: string) => ({
    onPointerEnter: (event: React.PointerEvent<HTMLElement>) => {
      const anchor =
        event.currentTarget.querySelector<HTMLElement>("[data-nav]") ?? event.currentTarget;
      intent.enter(id, anchor);
    },
    onPointerLeave: () => {
      intent.leave();
    },
    onContextMenu: (event: React.MouseEvent<HTMLElement>) => {
      if (event.target instanceof HTMLInputElement) return;
      event.preventDefault();
      const anchor =
        event.currentTarget.querySelector<HTMLElement>("[data-nav]") ?? event.currentTarget;
      intent.pin(id, anchor);
    },
    onKeyDownCapture: (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key !== "F10" || !event.shiftKey || event.target instanceof HTMLInputElement)
        return;
      event.preventDefault();
      event.stopPropagation();
      intent.pin(id, event.target instanceof HTMLElement ? event.target : event.currentTarget);
    },
  });
  const currentActions = new Map<string, (RowAction | null)[]>();
  // A repository or checkout name opens the same panel as its actions button, if it has
  // one; the tiles stay unchanged.
  const togglePanel = (id: string, anchor: HTMLElement) => {
    if (!currentActions.has(id)) return;
    if (menu?.id === id && menu.pinned) intent.close();
    else intent.pin(id, anchor);
  };
  const actions = (id: string, name: string, items: (RowAction | null)[]) => {
    const row = rows.find((entry) => entry.id === id);
    currentActions.set(id, items);
    return (
      <button
        className="row-actions"
        type="button"
        aria-label={`Actions for ${name}${compact ? ` · ${row?.repository ?? ""}${row?.state === "needs_input" ? " · Needs you" : ""}` : ""}`}
        aria-haspopup="dialog"
        aria-expanded={menu?.id === id}
        onClick={(event) => {
          event.stopPropagation();
          togglePanel(
            id,
            event.currentTarget
              .closest(".tree-row, .board-row")
              ?.querySelector<HTMLElement>("[data-nav]") ??
              event.currentTarget.closest<HTMLElement>(".board-row") ??
              event.currentTarget,
          );
        }}
      >
        {compact ? (
          <AgentBadge mark={row?.kind === "shell" ? ">_" : agentBadges.get(row?.agent ?? "")} />
        ) : (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
            <circle cx="3" cy="7" r="1.3" />
            <circle cx="7" cy="7" r="1.3" />
            <circle cx="11" cy="7" r="1.3" />
          </svg>
        )}
      </button>
    );
  };
  currentActions.set("config", [
    ...(openSettings
      ? [
          {
            label: "Settings",
            hint: navigator.platform.startsWith("Mac") ? "⌘," : "Ctrl+,",
            run: () => {
              openSettings();
            },
          },
          null,
        ]
      : []),
    ...launcherActions(options, source.shellName?.()).map((action) => ({
      ...action,
      label: action.run === "shell" ? action.label : `Via ${action.label}`,
      run: () => command({ kind: "config-launch", run: action.run }),
    })),
    null,
    { label: "Open folder", run: () => source.config?.openFolder() },
  ]);
  const configRejected = configStatus?.rejected.length ?? 0;
  const configTone = configStatus?.pending ? "needs" : configRejected ? "failed" : undefined;
  const configLabel = `Foom config${configStatus?.pending ? ", needs you" : ""}${configRejected ? `, ${String(configRejected)} rejected` : ""}`;
  const configGearRef = useRef<HTMLButtonElement>(null);
  const configPanel = () => {
    if (configGearRef.current) togglePanel("config", configGearRef.current);
  };
  useImperativeHandle(props.configPanelRef, () => configPanel);
  const parentOf = (row: BoardRow) => sidebarParent(row, rows);
  const related = (row: BoardRow) =>
    [hoveredSession, focusedSession, selected].some((id) => {
      const active = rows.find((candidate) => candidate.id === id);
      return (
        active !== undefined && (parentOf(row)?.id === active.id || parentOf(active)?.id === row.id)
      );
    });
  const session = (row: BoardRow, docked = false) => {
    const name = sessionName(row, preferences);
    const identity = sessionIdentity(row, source.shellName?.());
    const exited =
      row.exited ?? (row.kind === "sample" && (row.state === "done" || row.state === "failed"));
    const items: (RowAction | null)[] = exited
      ? [
          ...(row.review && !["clean", "escalated"].includes(row.review.phase)
            ? [
                {
                  label: "Stop review loop",
                  glyph: "stop" as const,
                  run: () => command({ kind: "stop", id: row.id }),
                },
              ]
            : []),
          ...(row.kind === "shell"
            ? row.worktreeRemoved
              ? []
              : [
                  {
                    label: "Restart shell",
                    glyph: "restart" as const,
                    run: () => {
                      return command({ kind: "restart", id: row.id });
                    },
                  },
                  null,
                ]
            : [
                ...(!row.worktreeRemoved && row.conversationId && row.kind === "agent"
                  ? [
                      {
                        label: "Resume conversation",
                        glyph: "resume" as const,
                        hint: `${row.conversationId.slice(0, 8)}…`,
                        run: () => command({ kind: "resume", id: row.id }),
                      },
                    ]
                  : []),
                ...(!row.worktreeRemoved
                  ? [
                      {
                        label: "New conversation here",
                        glyph: "plus" as const,
                        run: () => command({ kind: "new-conversation", id: row.id }),
                      },
                    ]
                  : []),
                ...(row.conversationId
                  ? [
                      {
                        label: "Copy session ID",
                        glyph: "copy" as const,
                        run: () => command({ kind: "copy-session-id", id: row.id }),
                      },
                    ]
                  : []),
                null,
              ]),
          {
            label: "Close",
            glyph: "close" as const,
            run: () => {
              return command({ kind: "close", id: row.id });
            },
          },
        ]
      : [
          ...(row.orchestration?.role === "child" && !row.orchestration.takenOver
            ? [
                {
                  label: "Take over",
                  glyph: "resume" as const,
                  run: () => command({ kind: "take-over", id: row.id }),
                },
              ]
            : row.kind === "agent" && !row.config
              ? [
                  row.orchestration?.role === "orchestrator" && row.orchestration.active
                    ? {
                        label: "Revoke orchestrator",
                        run: () => command({ kind: "revoke-orchestrator", id: row.id }),
                      }
                    : {
                        label: "Make orchestrator…",
                        run: () => command({ kind: "make-orchestrator", id: row.id }),
                      },
                ]
              : []),
          {
            glyph: "stop" as const,
            label: `Stop ${row.kind === "shell" ? "shell" : (agentNames.get(row.agent) ?? row.agent)}`,
            run: () => {
              return command({ kind: "stop", id: row.id });
            },
          },
        ];
    return (
      <SidebarSessionRow
        key={row.kind === "shell" && !row.managed ? "local-shell" : row.id}
        row={row}
        name={name}
        identity={identity}
        parentName={parentOf(row) ? sessionName(parentOf(row) ?? row, preferences) : undefined}
        related={related(row)}
        compact={compact}
        docked={docked}
        now={now}
        filter={filter}
        tile={tileNumbers?.get(row.id)}
        otherView={otherViews?.has(row.id) ?? false}
        selected={selected}
        events={rowEvents(row.id)}
        actions={actions(row.id, `${name} in ${row.branch}`, items)}
        register={(id, element) => {
          if (element) buttons.current.set(id, element);
          else buttons.current.delete(id);
        }}
        focus={focus}
        open={open}
        rename={(value) => {
          save(renameSession(preferences, row.id, value));
        }}
        onHover={setHoveredSession}
        onFocusSession={setFocusedSession}
      />
    );
  };
  const previewRow = (preview: PreviewSummary) => (
    <SidebarPreviewRow
      key={preview.id}
      preview={preview}
      opener={previewOpener(preview, rows, preferences)}
      tile={tileNumbers?.get(preview.id)}
      filter={filter}
      open={(id) => openPreview?.(id)}
    />
  );
  const panel = menu ? subjects.get(menu.id) : undefined;
  const matchingPreviews = tree.flatMap((repo) =>
    repo.worktrees.flatMap((worktree) => worktree.previews),
  );
  return {
    filter,
    setFilter,
    error,
    setError,
    dismissedCleanup,
    dismissCleanup,
    intent,
    configStatus,
    menu,
    arrival,
    anchorsRef,
    settle,
    openField,
    fieldOpen,
    closeMenu,
    overlay,
    narrow,
    homeRows,
    visibleHomeRows,
    configRows,
    shellRef,
    toggleButtonRef,
    compact,
    needsCount,
    toggleSidebar,
    toggleLabel,
    shortcut,
    tree,
    hiddenNeeds,
    toggle,
    arrive,
    launchers,
    rowEvents,
    currentActions,
    togglePanel,
    actions,
    configRejected,
    configTone,
    configLabel,
    configGearRef,
    configPanel,
    session,
    previewRow,
    panel,
    matchingPreviews,
  };
}
