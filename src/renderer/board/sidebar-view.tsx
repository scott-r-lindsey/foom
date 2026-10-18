import { SidebarRepositorySection } from "./sidebar-repository-section";
import { SidebarSessionRow } from "./sidebar-session-row";
import { SidebarPreviewRow } from "./sidebar-preview-row";
import { SidebarWorktreeSection } from "./sidebar-worktree-section";
import type { PreviewSummary } from "../../shared/workspace";
import { SidebarPanel } from "./sidebar-panel";
import { PanelIntent } from "./panel-intent";
import type { PanelSubject } from "./panel-facts";
import { AgentBadge } from "./agent-badge";
import { PanelMark } from "./panel-glyphs";
import type { ConfigStatus } from "../../shared/foom-config";
import { AppMenu } from "./app-menu";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RefObject, ReactNode } from "react";
import type { BoardSource, LaunchOptions } from "./board-source.d";
import type { BoardRow } from "./board.d";
import type { SidebarLocation, SidebarPreferences } from "./sidebar.d";
import {
  agentBadges,
  agentNames,
  buildSidebar,
  repositoryKey,
  sessionName,
  sessionIdentity,
  previewOpener,
  sidebarRepositories,
  worktreeKey,
  rowRepository,
  rowWorktree,
  sidebarParent,
} from "./sidebar-model";
import type { RowAction } from "./row-menu";
import { renameSession } from "./sidebar-preferences";
import type { SidebarCommand } from "../../shared/workspace";
import type { AgentId } from "../../shared/agents";

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
export function Sidebar({
  source,
  collapsed = false,
  setCollapsed,
  toggleRef,
  onCompact,
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
  footer,
  tileNumbers,
  previews = [],
  openPreview,
  pickPreview,
  otherViews,
  openSettings,
}: {
  source: BoardSource;
  collapsed?: boolean;
  setCollapsed?: (value: boolean) => void;
  toggleRef?: RefObject<(() => void) | undefined>;
  onCompact?: (value: boolean) => void;
  dragging?: boolean;
  inactive: boolean;
  revealRef: RefObject<((row: BoardRow) => void) | undefined>;
  rows: readonly BoardRow[];
  preferences: SidebarPreferences;
  save: (next: SidebarPreferences) => void;
  selected: string | undefined;
  buttons: RefObject<Map<string, HTMLElement>>;
  sidebar: RefObject<HTMLElement | null>;
  open: (row: BoardRow) => void;
  focus: (id: string) => void;
  /** Opens a repository's panel with the branch field; false when there is no repository. */
  newWorktreeRef?: RefObject<((repository?: string) => boolean) | undefined>;
  command: (command: SidebarCommand) => Promise<void>;
  options: LaunchOptions | undefined;
  footer: ReactNode;
  otherViews?: ReadonlySet<string>;
  previews?: readonly PreviewSummary[];
  openPreview?: (id: string) => void;
  pickPreview?: (worktree: string) => Promise<void>;
  tileNumbers?: ReadonlyMap<string, { number: number; focused: boolean }>;
  openSettings?: (section?: "config") => void;
}) {
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
  const [overlay, setOverlay] = useState(false);
  const [narrow, setNarrow] = useState(
    () => typeof matchMedia !== "undefined" && matchMedia("(max-width: 719px)").matches,
  );
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const media = matchMedia("(max-width: 719px)");
    const change = () => {
      setNarrow(media.matches);
      setOverlay(false);
    };
    media.addEventListener("change", change);
    return () => {
      media.removeEventListener("change", change);
    };
  }, []);
  const repositories = sidebarRepositories(
    rows.filter((row) => !row.home && !row.config),
    source.getSidebar?.() ??
      (source.getRepositories?.() ?? []).map((name) => ({ name, path: name, worktrees: [] })),
  );
  const homeRows = rows.filter((row) => row.home);
  const visibleHomeRows = homeRows.filter((row) =>
    `${sessionName(row, preferences)} ${row.reason} ~`
      .toLocaleLowerCase()
      .includes(filter.trim().toLocaleLowerCase()),
  );
  const configRows = rows.filter((row) => row.config);
  const shellRef = useRef<HTMLElement>(null);
  const toggleButtonRef = useRef<HTMLButtonElement>(null);
  const compact = narrow ? !overlay : collapsed;
  const needsCount =
    rows.filter((row) => row.state === "needs_input").length + (configStatus?.pending ? 1 : 0);
  const toggleSidebar = useCallback(() => {
    const active = document.activeElement;
    const moveFocus = active instanceof Node && shellRef.current?.contains(active);
    closeMenu();
    if (narrow) setOverlay((value) => !value);
    else setCollapsed?.(!collapsed);
    if (moveFocus) toggleButtonRef.current?.focus();
  }, [narrow, collapsed, setCollapsed, closeMenu]);
  useEffect(() => {
    if (toggleRef) toggleRef.current = toggleSidebar;
    return () => {
      if (toggleRef) toggleRef.current = undefined;
    };
  }, [toggleRef, toggleSidebar]);
  useEffect(() => {
    onCompact?.(compact);
  }, [onCompact, compact]);
  useEffect(() => {
    if (!narrow || !overlay) return;
    const outside = (event: MouseEvent) => {
      // Portaled panels and their submenus still belong to the sidebar.
      if (
        event.target instanceof Element &&
        event.target.closest(".sidebar-panel, .app-menu, .row-submenu")
      )
        return;
      if (event.target instanceof Node && !shellRef.current?.contains(event.target)) {
        closeMenu();
        setOverlay(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
        setOverlay(false);
        toggleButtonRef.current?.focus();
      }
    };
    document.addEventListener("click", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("click", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [narrow, overlay, closeMenu]);
  const toggleLabel = narrow
    ? overlay
      ? "Close sidebar"
      : "Open sidebar"
    : collapsed
      ? "Expand sidebar"
      : "Collapse sidebar";
  const shortcut = source.appMenu?.platform === "darwin" ? "⌘B" : "Ctrl+Shift+B";

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
    [source, save, preferences, setCollapsed, narrow],
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
    ...(openSettings
      ? [
          {
            label: "Open Foom config settings",
            run: () => {
              openSettings("config");
            },
          },
        ]
      : []),
    { label: "Open folder", run: () => source.config?.openFolder() },
  ]);
  const configRejected = configStatus?.rejected.length ?? 0;
  const configTone = configStatus?.pending ? "needs" : configRejected ? "failed" : undefined;
  const configLabel = `Foom config${configStatus?.pending ? ", needs you" : ""}${configRejected ? `, ${String(configRejected)} rejected` : ""}`;
  const configGearRef = useRef<HTMLButtonElement>(null);
  const configPanel = () => {
    if (configGearRef.current) togglePanel("config", configGearRef.current);
  };
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
                  label: "Reset reviewed replies",
                  glyph: "resume" as const,
                  run: () => command({ kind: "reset-replies", id: row.id }),
                },
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
  return (
    <aside
      ref={shellRef}
      className="sidebar-shell"
      data-compact={compact}
      data-overlay={narrow && overlay}
    >
      <button
        ref={toggleButtonRef}
        type="button"
        className="sidebar-toggle"
        aria-label={toggleLabel}
        title={`${toggleLabel} (${shortcut})`}
        onClick={toggleSidebar}
      >
        <svg viewBox="0 0 16 14" aria-hidden="true">
          <rect x="1" y="1" width="14" height="12" rx="2" />
          <path d="M6 1v12" />
          <path d={compact ? "M9.5 5l2 2-2 2" : "M11.5 5 9.5 7l2 2"} />
        </svg>
      </button>
      {compact && needsCount > 0 && (
        <p className="rail-needs" role="status">
          {needsCount} need you
        </p>
      )}
      <header className="board-top">
        <AppMenu api={source.appMenu} development={source.isDevelopment} />
        <p className="board-summary" role="status">
          {rows.filter((row) => row.state === "needs_input").length +
            (configStatus?.pending ? 1 : 0)}{" "}
          need you · {rows.filter((row) => row.state === "working").length} working
        </p>
        <div className="sidebar-filter">
          <input
            aria-label="Filter repositories and sessions"
            placeholder="Filter…"
            value={filter}
            onChange={(event) => {
              closeMenu();
              setFilter(event.target.value);
            }}
          />
          {filter && (
            <button
              type="button"
              aria-label="Clear filter"
              onClick={() => {
                setFilter("");
              }}
            >
              ×
            </button>
          )}
          <button
            type="button"
            aria-label="Add repository"
            onClick={() => {
              setError("");
              void source.worktrees?.addRepository().catch(() => {
                setError("Unable to add repository.");
              });
            }}
          >
            {tree.length === 0 ? "Add repository" : "+"}
          </button>
        </div>
      </header>
      {error && <p role="alert">{error}</p>}
      {hiddenNeeds > 0 && (
        <button
          type="button"
          className="hidden-needs"
          onClick={() => {
            setFilter("");
          }}
        >
          {hiddenNeeds} hidden · needs you · Show
        </button>
      )}
      <nav
        className="board-list"
        aria-label="Terminal sidebar"
        tabIndex={-1}
        ref={sidebar}
        onKeyDown={(event) => {
          if (
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            !(event.target instanceof HTMLElement) ||
            event.target.tagName === "INPUT"
          )
            return;
          const ordered = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>("[data-nav]"),
          );
          const index = ordered.indexOf(event.target);
          if (
            event.key === "ArrowDown" ||
            event.key === "ArrowUp" ||
            event.key === "Home" ||
            event.key === "End"
          ) {
            event.preventDefault();
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? ordered.length - 1
                  : (index + (event.key === "ArrowDown" ? 1 : ordered.length - 1)) % ordered.length;
            ordered[next]?.focus();
          }
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            const item = event.target.closest("[role=treeitem]");
            const button = item?.querySelector<HTMLButtonElement>(".tree-chevron");
            if (
              button &&
              item?.getAttribute("aria-expanded") !== String(event.key === "ArrowRight")
            ) {
              event.preventDefault();
              button.click();
            }
          }
        }}
      >
        <div role="tree" aria-label="Repositories and sessions">
          {!compact && (
            <div
              role="treeitem"
              aria-label="Home shell"
              aria-expanded={preferences.expanded["home"] !== false}
            >
              <div className="tree-row home-row" {...rowEvents("home")}>
                <button
                  type="button"
                  className="tree-chevron"
                  aria-label="Toggle home shells"
                  onClick={() => {
                    toggle("home", preferences.expanded["home"] !== false);
                  }}
                >
                  {preferences.expanded["home"] !== false ? "▾" : "▸"}
                </button>
                <button
                  type="button"
                  data-nav
                  className="tree-name"
                  onClick={() => {
                    void command({ kind: "home-shell" });
                  }}
                >
                  <AgentBadge mark=">_" />
                  {source.shellName?.() ?? "Shell"} ~
                </button>
                {actions("home", "Home shell", [
                  { label: "New shell", badge: ">_", run: () => command({ kind: "home-shell" }) },
                ])}
              </div>
              {preferences.expanded["home"] !== false && (
                <div role="group">
                  {visibleHomeRows.length
                    ? visibleHomeRows.map((row) => session(row))
                    : !filter.trim() && <p className="tree-empty">Nothing here yet</p>}
                </div>
              )}
            </div>
          )}
          {compact && (homeRows.length > 0 || configRows.length > 0) && (
            <div className="rail-group">
              {[...homeRows, ...configRows].map((row) => session(row))}
            </div>
          )}
          {compact && matchingPreviews.map(previewRow)}

          {!compact && filter.trim() && tree.length === 0 && visibleHomeRows.length === 0 && (
            <p className="tree-empty">No matches</p>
          )}
          {compact
            ? tree.map((repo) => (
                <div className="rail-group" key={repo.repository.path}>
                  {repo.worktrees
                    .flatMap((worktree) => worktree.sessions)
                    .map((row) => session(row))}
                </div>
              ))
            : tree.map((repo, index) => {
                const rid = repositoryKey(repo.repository.path);
                const cleanup = repo.repository.cleanup;
                const deleting = cleanup && cleanup.phase !== "finished";
                return (
                  <SidebarRepositorySection
                    key={rid}
                    repo={repo}
                    separator={index > 0 && tree[index - 1]?.section !== repo.section}
                    filter={filter}
                    empty={!filter.trim() && repo.worktrees.length === 0}
                    panelOpen={menu?.id === rid}
                    events={rowEvents(rid)}
                    register={(element) => {
                      if (element) anchorsRef.current.set(rid, element);
                      else anchorsRef.current.delete(rid);
                    }}
                    toggle={() => {
                      toggle(rid, repo.expanded);
                    }}
                    openPanel={(anchor) => {
                      togglePanel(rid, anchor);
                    }}
                    actions={actions(rid, repo.repository.name, [
                      ...(source.worktrees
                        ? [
                            {
                              label: "New worktree",
                              glyph: "branch" as const,
                              expanded: Boolean(menu?.field && menu.id === rid),
                              run: () => {
                                if (menu) intent.pin(rid, menu.anchor, true);
                              },
                            },
                          ]
                        : []),
                      null,

                      {
                        label: repo.pinned ? "Unpin" : "Pin to top",
                        glyph: "pin" as const,
                        run: () => {
                          save({
                            ...preferences,
                            pins: repo.pinned
                              ? preferences.pins.filter((path) => path !== repo.repository.path)
                              : [...preferences.pins, repo.repository.path],
                          });
                        },
                      },
                      {
                        label: "Remove from Foom…",
                        hint: "keeps files",
                        glyph: "unlist" as const,
                        run: () => {
                          return command({
                            kind: "remove-repository",
                            repository: repo.repository.path,
                          });
                        },
                      },
                      ...(repo.repository.canDeleteMerged || cleanup
                        ? [
                            null,
                            {
                              label: deleting
                                ? "Deleting merged worktrees"
                                : cleanup
                                  ? "Cleanup results"
                                  : "Delete merged worktrees…",
                              glyph: "trash" as const,
                              hint: deleting
                                ? `${String(cleanup.done)}/${String(cleanup.total)}`
                                : String(repo.repository.mergedCount ?? ""),
                              run: () =>
                                command({
                                  kind: "delete-merged-worktrees",
                                  repository: repo.repository.path,
                                }),
                            },
                          ]
                        : []),
                      ...(repo.repository.mergedError
                        ? [
                            null,
                            {
                              label: repo.repository.mergedError,
                              disabled: true,
                              run: () => undefined,
                            },
                          ]
                        : []),
                    ])}
                  >
                    {repo.expanded && (
                      <>
                        {" "}
                        {repo.worktrees.map(({ tree: worktree, expanded, rollup, sessions }) => {
                          const wid = worktreeKey(worktree.path);
                          const cleanupItem = cleanup?.items.find(
                            (item) =>
                              item.path === worktree.path &&
                              (item.state !== "removed" || worktree.removed),
                          );
                          const cleanupKey = `${cleanup?.id ?? ""}:${worktree.path}`;
                          const branch =
                            worktree.branch ?? `⏣ ${worktree.head?.slice(0, 7) ?? "Unknown"}`;
                          const main = worktree.path === repo.repository.path;
                          const name = main ? "Main checkout" : branch;
                          const target = {
                            repository: repo.repository.path,
                            worktree: worktree.path,
                          };
                          return (
                            <SidebarWorktreeSection
                              key={wid}
                              worktree={worktree}
                              name={name}
                              branch={branch}
                              main={main}
                              expanded={expanded}
                              rollup={rollup}
                              cleanupItem={cleanupItem}
                              cleanupDismissed={dismissedCleanup.has(cleanupKey)}
                              arriving={arrival === worktree.path}
                              filter={filter}
                              panelOpen={menu?.id === wid}
                              events={rowEvents(wid)}
                              register={(element) => {
                                if (element) anchorsRef.current.set(wid, element);
                                else anchorsRef.current.delete(wid);
                              }}
                              toggle={() => {
                                toggle(wid, expanded);
                              }}
                              openPanel={(anchor) => {
                                togglePanel(wid, anchor);
                              }}
                              openPullRequest={() =>
                                command({
                                  kind: "open-pull-request",
                                  repository: repo.repository.path,
                                  worktree: worktree.path,
                                })
                              }
                              dismissCleanup={() => {
                                dismissCleanup(cleanupKey);
                              }}
                              settle={(delay) => {
                                settle(worktree.path, delay);
                              }}
                              actions={
                                !worktree.removed &&
                                actions(wid, name, [
                                  ...launchers(target),
                                  {
                                    label: "Resume conversation…",
                                    expanded: menu?.id === wid && fieldOpen,
                                    run: () => {
                                      const anchor = anchorsRef.current.get(wid);
                                      if (anchor) openField(wid, anchor);
                                    },
                                  },
                                  ...(source.previews && !worktree.bare
                                    ? [
                                        {
                                          label: "Preview file…",
                                          run: () => pickPreview?.(worktree.path),
                                        },
                                      ]
                                    : []),
                                  ...(!main && !worktree.bare
                                    ? [
                                        null,
                                        {
                                          label: "Delete worktree…",
                                          disabled: rows.some(
                                            (session) =>
                                              rowRepository(session) === target.repository &&
                                              rowWorktree(session) === target.worktree &&
                                              !session.exited,
                                          ),
                                          glyph: "trash" as const,
                                          run: () => {
                                            return command({
                                              kind: "remove-worktree",
                                              ...target,
                                            });
                                          },
                                        },
                                      ]
                                    : []),
                                ])
                              }
                            >
                              {expanded && (
                                <>
                                  {" "}
                                  {sessions.length
                                    ? sessions.map((row) => (
                                        <div key={row.id}>
                                          {session(row)}
                                          {matchingPreviews
                                            .filter(
                                              (preview) => preview.openedBy?.terminalId === row.id,
                                            )
                                            .map(previewRow)}
                                        </div>
                                      ))
                                    : !filter.trim() &&
                                      !matchingPreviews.some(
                                        (preview) => preview.worktree === worktree.path,
                                      ) && <p className="tree-empty">Nothing here yet</p>}
                                  {matchingPreviews
                                    .filter(
                                      (preview) =>
                                        !sessions.some(
                                          (row) => row.id === preview.openedBy?.terminalId,
                                        ) &&
                                        preview.worktree === worktree.path &&
                                        preview.repository === repo.repository.path,
                                    )
                                    .map(previewRow)}
                                </>
                              )}
                            </SidebarWorktreeSection>
                          );
                        })}{" "}
                      </>
                    )}
                  </SidebarRepositorySection>
                );
              })}
        </div>
      </nav>
      <footer className="sidebar-footer">
        {!compact && (configStatus?.pending || configRejected > 0 || configRows.length > 0) && (
          <div className="config-dock">
            <button
              type="button"
              className="config-dock-head"
              aria-label={configLabel}
              aria-expanded={menu?.id === "config"}
              onClick={configPanel}
            >
              <PanelMark mark="config" />
              <span className="config-dock-name">Foom config</span>
              {configStatus?.pending && (
                <span className="panel-chip" data-tone="needs">
                  Needs you
                </span>
              )}
              {configRejected > 0 && (
                <span className="panel-chip" data-tone="failed">
                  {configRejected} rejected
                </span>
              )}
            </button>
            {configRows.map((row) => session(row, true))}
          </div>
        )}
        <div className="sidebar-footer-bar">
          {footer}
          <button
            ref={configGearRef}
            type="button"
            className="config-gear"
            title="Foom config"
            aria-label={configLabel}
            aria-haspopup="dialog"
            aria-expanded={menu?.id === "config"}
            data-tone={configTone}
            onClick={configPanel}
          >
            <PanelMark mark="config" />
          </button>
        </div>
      </footer>
      {menu && panel && !inactive && (
        <SidebarPanel
          menu={menu}
          subject={panel.subject}
          name={panel.name}
          kind={panel.kind}
          mark={panel.mark}
          source={source}
          options={options}
          actions={currentActions.get(menu.id) ?? []}
          rename={(value) => {
            save(renameSession(preferences, menu.id, value));
          }}
          command={command}
          created={arrive}
          back={() => {
            intent.pin(menu.id, menu.anchor);
          }}
          close={closeMenu}
          enter={() => {
            intent.hold();
          }}
          leave={() => {
            intent.leave();
          }}
          pin={() => {
            intent.pin(menu.id, menu.anchor);
          }}
        />
      )}
    </aside>
  );
}
