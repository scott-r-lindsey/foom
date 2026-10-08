import { AppMenu } from "./app-menu";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
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
        label: agentNames[agent.id] ?? agent.id,
        badge: agentBadges[agent.id] ?? "",
        run: agent.id,
      })) ?? []),
    { label: shell ? `Shell (${shell})` : "Shell", badge: ">_", run: "shell" },
  ];
}
export function Sidebar({
  source,
  revealRef,
  location,
  inactive,
  rows,
  preferences,
  save,
  selected,
  buttons,
  sidebar,
  open,
  focus,
  peek,
  choose,
  newWorktree,
  command,
  options,
  footer,
  tileNumbers,
  refused,
  clearRefusal,
}: {
  source: BoardSource;
  location: SidebarLocation | undefined;
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
  peek: (id?: string) => void;
  choose: (location: SidebarLocation) => void;
  newWorktree: (repository?: string) => void;
  command: (command: SidebarCommand) => Promise<void>;
  options: LaunchOptions | undefined;
  footer: ReactNode;
  tileNumbers?: ReadonlyMap<string, { number: number; focused: boolean }>;
  refused?: string | undefined;
  clearRefusal?: () => void;
}) {
  const [now] = useState(Date.now);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [menu, setMenu] = useState<{
    id: string;
    anchor: HTMLButtonElement;
    actions: (RowAction | null)[];
  }>();
  useLayoutEffect(() => {
    revealRef.current = (row) => {
      setFilter("");
      setMenu(undefined);
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
  }, [preferences, save, revealRef]);
  const closeMenu = useCallback(() => {
    setMenu(undefined);
  }, []);
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
    rows,
    source.getSidebar?.() ??
      (source.getRepositories?.() ?? []).map((name) => ({ name, path: name, worktrees: [] })),
  );
  const compact = narrow && rows.length > 0;
  const { tree, hiddenNeeds } = buildSidebar(
    rows,
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
  const actions = (id: string, name: string, items: (RowAction | null)[]) => (
    <button
      className="row-actions"
      type="button"
      aria-label={`Actions for ${name}`}
      aria-haspopup="menu"
      aria-expanded={menu?.id === id}
      onClick={(event) => {
        event.stopPropagation();
        peek();
        setMenu(menu?.id === id ? undefined : { id, anchor: event.currentTarget, actions: items });
      }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
        <circle cx="3" cy="7" r="1.3" />
        <circle cx="7" cy="7" r="1.3" />
        <circle cx="11" cy="7" r="1.3" />
      </svg>
    </button>
  );
  const session = (row: BoardRow) => {
    const name = sessionName(row, preferences);
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
                        hint: `${row.conversationId.slice(0, 8)}…`,
                        run: () => command({ kind: "resume", id: row.id }),
                      },
                    ]
                  : []),
                ...(!row.worktreeRemoved
                  ? [
                      {
                        label: "New conversation here",
                        run: () => command({ kind: "new-conversation", id: row.id }),
                      },
                    ]
                  : []),
                ...(row.conversationId
                  ? [
                      {
                        label: "Copy session ID",
                        run: () => command({ kind: "copy-session-id", id: row.id }),
                      },
                    ]
                  : []),
                null,
              ]),
          {
            label: "Close",
            run: () => {
              return command({ kind: "close", id: row.id });
            },
          },
        ]
      : [
          {
            label: `Stop ${row.kind === "shell" ? "shell" : (agentNames[row.agent] ?? row.agent)}`,
            run: () => {
              return command({ kind: "stop", id: row.id });
            },
          },
        ];
    return (
      <div
        className="board-entry session-entry"
        key={row.kind === "shell" && !row.managed ? "local-shell" : row.id}
        role="none"
        data-selected={!location && selected === row.id}
      >
        <div
          role="treeitem"
          aria-selected={!location && selected === row.id}
          className="board-row"
          draggable
          data-drag-session={row.id}
          data-refused={refused === row.id}
          onAnimationEnd={clearRefusal}
          data-nav
          data-kind={row.kind}
          data-state={row.state}
          tabIndex={row.id === selected ? 0 : -1}
          aria-label={`${row.branch} · ${name} · ${light(row).label} · ${row.reason}${row.bypass ? " · Bypass" : ""}${row.worktreeRemoved ? " · Worktree removed" : ""}`}
          ref={(element) => {
            if (element) buttons.current.set(row.id, element);
            else buttons.current.delete(row.id);
          }}
          onFocus={(event) => {
            if (event.target === event.currentTarget) {
              focus(row.id);
              peek(row.id);
            }
          }}
          onBlur={() => {
            peek();
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
          onMouseEnter={() => {
            peek(row.id);
          }}
          onMouseLeave={(event) => {
            if (document.activeElement !== event.currentTarget) peek();
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
              <span className="board-agent">{agentBadges[row.agent] ?? row.agent}</span>
              {row.bypass && (
                <span className="session-bypass" title="Launched with a bypass argument">
                  <span aria-hidden="true">◇</span> Bypass
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
          {rows.filter((row) => row.state === "working" || row.state === "checking").length} working
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
                      aria-selected={
                        location?.repository === repo.repository.path && !location.worktree
                      }
                      aria-label={repo.repository.name}
                    >
                      <div
                        className="tree-row repository-row"
                        data-selected={
                          location?.repository === repo.repository.path && !location.worktree
                        }
                      >
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
                          onClick={() => {
                            choose({ repository: repo.repository.path });
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
                            run: () => {
                              newWorktree(repo.repository.path);
                            },
                          },
                          null,
                          ...launchers({ repository: repo.repository.path }),
                          null,
                          {
                            label: repo.pinned ? "Unpin" : "Pin to top",
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
                            label: "Remove repository…",
                            run: () => {
                              return command({
                                kind: "remove-repository",
                                repository: repo.repository.path,
                              });
                            },
                          },
                        ])}
                      </div>
                      {repo.expanded && (
                        <div role="group">
                          {repo.worktrees.map(({ tree: worktree, expanded, rollup, sessions }) => {
                            const wid = worktreeKey(worktree.path);
                            const branch = worktree.branch ?? "Detached HEAD";
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
                                <div
                                  className="tree-row worktree-row"
                                  data-selected={location?.worktree === worktree.path}
                                >
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
                                    onClick={() => {
                                      choose(target);
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
                                              label: "Remove worktree…",
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
      {menu && !inactive && (
        <RowMenu
          confirmations={source.confirmations}
          anchor={menu.anchor}
          actions={menu.actions}
          close={closeMenu}
        />
      )}
    </aside>
  );
}
