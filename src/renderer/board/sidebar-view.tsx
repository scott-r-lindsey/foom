import { PanelIntent } from "./panel-intent";
import { PanelFacts, PanelTitle } from "./panel-facts";
import type { PanelSubject } from "./panel-facts";
import { AgentBadge } from "./agent-badge";
import { AppMenu } from "./app-menu";
import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import type { RefObject, ReactNode, CSSProperties } from "react";
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
  sidebarRepositories,
  worktreeKey,
  rowRepository,
  rowWorktree,
} from "./sidebar-model";
import { light, waitTime } from "./board";
import { RowMenu } from "./row-menu";
import type { RowAction } from "./row-menu";
import { Highlight } from "./text-highlight";
import { SessionName } from "./session-name";
import { renameSession } from "./sidebar-preferences";
import type { SidebarCommand } from "../../shared/workspace";
import type { AgentId } from "../../shared/agents";

export function launcherActions(
  options: LaunchOptions | undefined,
  shell: string | undefined,
): { label: string; badge: string; run: AgentId | "shell" }[] {
  return [
    ...(options?.agents
      .filter((agent) => agent.path && options.enabled[agent.id])
      .map((agent) => ({
        label: agentNames.get(agent.id) ?? agent.id,
        badge: agentBadges.get(agent.id) ?? agent.id,
        run: agent.id,
      })) ?? []),
    { label: shell ? `Shell (${shell})` : "Shell", badge: ">_", run: "shell" },
  ];
}
export function Sidebar({
  source,
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
  newWorktree,
  command,
  options,
  footer,
  tileNumbers,
  otherViews,
  refused,
  clearRefusal,
}: {
  source: BoardSource;
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
  newWorktree: (repository?: string) => void;
  command: (command: SidebarCommand) => Promise<void>;
  options: LaunchOptions | undefined;
  footer: ReactNode;
  otherViews?: ReadonlySet<string>;
  tileNumbers?: ReadonlyMap<string, { number: number; focused: boolean }>;
  refused?: string | undefined;
  clearRefusal?: () => void;
}) {
  const [now] = useState(Date.now);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [intent] = useState(() => new PanelIntent());
  const menu = useSyncExternalStore(intent.subscribe, intent.getSnapshot);
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
  }, [preferences, save, revealRef, intent]);
  const closeMenu = useCallback(() => {
    intent.close();
  }, [intent]);
  const [narrow, setNarrow] = useState(
    () => typeof matchMedia !== "undefined" && matchMedia("(max-width: 719px)").matches,
  );
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const media = matchMedia("(max-width: 719px)");
    const change = () => {
      setNarrow(media.matches);
    };
    media.addEventListener("change", change);
    return () => {
      media.removeEventListener("change", change);
    };
  }, []);
  const repositories = sidebarRepositories(
    rows.filter((row) => !row.home),
    source.getSidebar?.() ??
      (source.getRepositories?.() ?? []).map((name) => ({ name, path: name, worktrees: [] })),
  );
  const homeRows = rows.filter((row) => row.home);
  const compact = narrow && rows.length > 0;
  const { tree, hiddenNeeds } = buildSidebar(
    rows.filter((row) => !row.home),
    repositories,
    preferences,
    compact ? "" : filter,
  );
  const toggle = (id: string, expanded: boolean) => {
    save({ ...preferences, expanded: { ...preferences.expanded, [id]: !expanded } });
  };
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
    currentActions.set(id, items);
    return (
      <button
        className="row-actions"
        type="button"
        aria-label={`Actions for ${name}`}
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
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
          <circle cx="3" cy="7" r="1.3" />
          <circle cx="7" cy="7" r="1.3" />
          <circle cx="11" cy="7" r="1.3" />
        </svg>
      </button>
    );
  };
  const session = (row: BoardRow) => {
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
                ...(!row.worktreeRemoved &&
                row.conversationId &&
                (row.agent === "claude" || row.agent === "codex")
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
          {
            glyph: "stop" as const,
            label: `Stop ${row.kind === "shell" ? "shell" : (agentNames.get(row.agent) ?? row.agent)}`,
            run: () => {
              return command({ kind: "stop", id: row.id });
            },
          },
        ];
    return (
      <div
        key={row.kind === "shell" && !row.managed ? "local-shell" : row.id}
        {...rowEvents(row.id)}
        className="board-entry session-entry"
        role="none"
        data-selected={selected === row.id}
      >
        <div
          role="treeitem"
          aria-selected={selected === row.id}
          className="board-row"
          draggable
          data-drag-session={row.id}
          data-refused={refused === row.id}
          onAnimationEnd={clearRefusal}
          data-nav
          data-kind={row.kind}
          data-state={row.state}
          tabIndex={row.id === selected ? 0 : -1}
          aria-label={`${row.branch} · ${name}${name === identity ? "" : ` · ${identity}`} · ${light(row).label} · ${row.reason}${row.bypass ? " · Bypass" : ""}${row.worktreeRemoved ? " · Worktree removed" : ""}`}
          ref={(element) => {
            if (element) buttons.current.set(row.id, element);
            else buttons.current.delete(row.id);
          }}
          onFocus={(event) => {
            if (event.target === event.currentTarget) {
              focus(row.id);
            }
          }}
          onClick={() => {
            open(row);
          }}
          onKeyDown={(event) => {
            if (
              event.target === event.currentTarget &&
              (event.key === "Enter" || event.key === " ")
            ) {
              event.preventDefault();
              open(row);
            }
          }}
        >
          <span
            className="board-light"
            style={{ "--light-opacity": light(row).opacity } as CSSProperties}
            aria-hidden="true"
          />
          <span className="session-lines">
            <span className="visually-hidden board-branch">{row.branch}</span>
            <span className="session-top">
              <AgentBadge mark={row.kind === "shell" ? ">_" : agentBadges.get(row.agent)} />
              {row.bypass && (
                <span className="session-bypass" title="Launched with a bypass argument">
                  <span aria-hidden="true">◇</span> Bypass
                </span>
              )}
              {otherViews?.has(row.id) && (
                <span
                  className="tile-number"
                  aria-label="Shown in another window"
                  title="Shown in another window"
                >
                  ▣
                </span>
              )}
              {tileNumbers?.has(row.id) && (
                <span
                  className="tile-number"
                  data-focused={tileNumbers.get(row.id)?.focused}
                  aria-label={`Tile ${String(tileNumbers.get(row.id)?.number)}`}
                >
                  {tileNumbers.get(row.id)?.number}
                </span>
              )}
              <SessionName
                name={name}
                filter={filter}
                open={() => {
                  open(row);
                }}
                save={(value) => {
                  save(renameSession(preferences, row.id, value));
                }}
              />
              {row.state === "needs_input" && (
                <span className="board-wait">{waitTime(row, now)}</span>
              )}
            </span>
            {row.worktreeRemoved && (
              <span className="worktree-removed">
                <span aria-hidden="true">⊘</span> Worktree removed
              </span>
            )}
            <span className="board-reason" title={row.reason}>
              <Highlight text={row.reason} filter={filter} />
            </span>
            <span className="visually-hidden board-state">{light(row).label}</span>
          </span>
          {actions(row.id, `${name} in ${row.branch}`, items)}
        </div>
      </div>
    );
  };
  const roll = (row: BoardRow | undefined) =>
    row && (
      <span className="rollup" role="img" data-state={row.state} aria-label={light(row).label}>
        <span className="board-light" aria-hidden="true" />
      </span>
    );
  return (
    <aside className="sidebar-shell" data-compact={compact}>
      <header className="board-top">
        <AppMenu api={source.appMenu} development={source.isDevelopment} />
        <p className="board-summary" role="status">
          {rows.filter((row) => row.state === "needs_input").length} need you ·{" "}
          {rows.filter((row) => row.state === "working").length} working
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
                  {homeRows
                    .filter(
                      (row) =>
                        !filter ||
                        `${sessionName(row, preferences)} ${row.reason} ~`
                          .toLocaleLowerCase()
                          .includes(filter.toLocaleLowerCase()),
                    )
                    .map(session)}
                </div>
              )}
            </div>
          )}
          {compact && homeRows.map(session)}
          {compact
            ? tree
                .flatMap((repo) => repo.worktrees.flatMap((worktree) => worktree.sessions))
                .map(session)
            : tree.map((repo, index) => {
                const rid = repositoryKey(repo.repository.path);
                return (
                  <div key={rid}>
                    {index > 0 && tree[index - 1]?.section !== repo.section && (
                      <hr className="tree-separator" />
                    )}
                    <div
                      role="treeitem"
                      aria-expanded={repo.expanded}
                      aria-label={repo.repository.name}
                    >
                      <div {...rowEvents(rid)} className="tree-row repository-row">
                        <button
                          type="button"
                          className="tree-chevron"
                          aria-label={`${repo.expanded ? "Collapse" : "Expand"} ${repo.repository.name}`}
                          onClick={() => {
                            toggle(rid, repo.expanded);
                          }}
                        >
                          {repo.expanded ? "▾" : "▸"}
                        </button>
                        <button
                          type="button"
                          data-nav
                          className="tree-name"
                          aria-haspopup="dialog"
                          aria-expanded={menu?.id === rid}
                          onClick={(event) => {
                            togglePanel(rid, event.currentTarget);
                          }}
                        >
                          <span className="tree-label">
                            <Highlight text={repo.repository.name} filter={filter} />
                          </span>
                          {repo.pinned && <span aria-label="Pinned">⌖</span>}
                        </button>
                        {!repo.expanded && (
                          <>
                            {roll(repo.rollup)}
                            <span className="worktree-count">
                              {repo.repository.worktrees.length}
                            </span>
                          </>
                        )}
                        {actions(rid, repo.repository.name, [
                          {
                            label: "New worktree…",
                            glyph: "branch" as const,
                            run: () => {
                              newWorktree(repo.repository.path);
                            },
                          },
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
                          ...(repo.repository.canDeleteMerged
                            ? [
                                null,
                                {
                                  label: "Delete merged worktrees…",
                                  glyph: "trash" as const,
                                  hint: String(repo.repository.mergedCount ?? ""),
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
                      </div>
                      {repo.expanded && (
                        <div role="group">
                          {repo.worktrees.map(({ tree: worktree, expanded, rollup, sessions }) => {
                            const wid = worktreeKey(worktree.path);
                            const branch =
                              worktree.branch ?? `⏣ ${worktree.head?.slice(0, 7) ?? "Unknown"}`;
                            const main = worktree.path === repo.repository.path;
                            const name = main ? "Main checkout" : branch;
                            const target = {
                              repository: repo.repository.path,
                              worktree: worktree.path,
                            };
                            return (
                              <div
                                key={wid}
                                role="treeitem"
                                aria-expanded={expanded}
                                aria-label={name}
                              >
                                <div {...rowEvents(wid)} className="tree-row worktree-row">
                                  <button
                                    type="button"
                                    className="tree-chevron"
                                    aria-label={`${expanded ? "Collapse" : "Expand"} ${name}`}
                                    onClick={() => {
                                      toggle(wid, expanded);
                                    }}
                                  >
                                    {expanded ? "▾" : "▸"}
                                  </button>
                                  <button
                                    type="button"
                                    data-nav
                                    className="tree-name"
                                    aria-label={name}
                                    aria-haspopup="dialog"
                                    aria-expanded={menu?.id === wid}
                                    onClick={(event) => {
                                      togglePanel(wid, event.currentTarget);
                                    }}
                                  >
                                    <svg
                                      role="img"
                                      aria-label={main ? "Main checkout" : "Worktree"}
                                      width="12"
                                      height="12"
                                      viewBox="0 0 12 12"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="1.2"
                                    >
                                      {main ? (
                                        <path d="M1.5 3h3.2l1 1.2h4.8v5.3h-9z" />
                                      ) : (
                                        <>
                                          <circle cx="3" cy="2.5" r="1.3" />
                                          <circle cx="3" cy="9.5" r="1.3" />
                                          <circle cx="9" cy="4" r="1.3" />
                                          <path d="M3 3.8v4.4M9 5.3c0 2-3 1.7-5.6 3.3" />
                                        </>
                                      )}
                                    </svg>
                                    <span className={main ? "tree-checkout-label" : "tree-label"}>
                                      {main && (
                                        <span>
                                          <Highlight text="Main checkout" filter={filter} />
                                        </span>
                                      )}
                                      <span
                                        className={
                                          main ? "tree-label tree-checkout-branch" : undefined
                                        }
                                      >
                                        <Highlight text={branch} filter={filter} />
                                      </span>
                                    </span>
                                  </button>
                                  {worktree.removed && (
                                    <span className="worktree-removed">
                                      <span aria-hidden="true">⊘</span> Worktree removed
                                    </span>
                                  )}
                                  {!expanded && roll(rollup)}
                                  {!worktree.removed &&
                                    actions(wid, name, [
                                      ...launchers(target),
                                      ...(!main && !worktree.bare
                                        ? [
                                            null,
                                            {
                                              label: "Delete worktree…",
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
                                    ])}
                                </div>
                                {expanded && <div role="group">{sessions.map(session)}</div>}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
        </div>
      </nav>
      <footer className="sidebar-footer">{footer}</footer>
      {menu && subjects.has(menu.id) && !inactive && (
        <RowMenu
          panel={{
            title:
              subjects.get(menu.id)?.subject.kind === "session" ? (
                <PanelTitle
                  name={subjects.get(menu.id)?.name ?? "Session"}
                  save={(value) => {
                    save(renameSession(preferences, menu.id, value));
                  }}
                />
              ) : (
                subjects.get(menu.id)?.name
              ),
            kind: subjects.get(menu.id)?.kind ?? "",
            mark: subjects.get(menu.id)?.mark ?? "",
            facts: (() => {
              const subject = subjects.get(menu.id)?.subject;
              return subject ? (
                <PanelFacts key={menu.id} subject={subject} source={source} options={options} />
              ) : null;
            })(),
            pinned: menu.pinned,
            enter: () => {
              intent.hold();
            },
            leave: () => {
              intent.leave();
            },
            pin: () => {
              if (!menu.pinned) intent.pin(menu.id, menu.anchor);
            },
          }}
          label={`${subjects.get(menu.id)?.name ?? "Row"} details and commands`}
          confirmations={source.confirmations}
          anchor={menu.anchor}
          actions={currentActions.get(menu.id) ?? []}
          close={closeMenu}
        />
      )}
    </aside>
  );
}
