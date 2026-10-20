import { ActionError, BackgroundErrorMark } from "./error-presentation";
import { AgentBadge } from "./agent-badge";
import { AppMenu } from "./app-menu";
import { PanelMark } from "./panel-glyphs";
import { repositoryKey, rowRepository, rowWorktree, worktreeKey } from "./sidebar-model";
import { SidebarPanel } from "./sidebar-panel";
import { renameSession } from "./sidebar-preferences";
import { SidebarRepositorySection } from "./sidebar-repository-section";
import { SidebarResize } from "./sidebar-resize";
import { SidebarWorktreeSection } from "./sidebar-worktree-section";

import type { SidebarProps } from "./sidebar-view.d";
import { useSidebar } from "./use-sidebar";
export { launcherActions } from "./use-sidebar";
export function Sidebar(props: SidebarProps) {
  const {
    source,
    width,
    setWidth,
    dragging,
    inactive,
    rows,
    preferences,
    save,
    sidebar,
    command,
    options,
    footer,
    pickPreview,
  } = props;
  const {
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
  } = useSidebar(props);
  return (
    <aside
      ref={shellRef}
      className="sidebar-shell"
      data-compact={compact}
      data-overlay={narrow && overlay}
    >
      <SidebarResize
        key={compact || narrow ? "fixed" : "resizable"}
        sidebarRef={shellRef}
        width={width}
        save={setWidth}
        enabled={!compact && !narrow}
        onDrag={(active) => {
          intent.drag(active || Boolean(dragging));
        }}
      />
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
        </div>
      </header>
      {error && (
        <ActionError
          message={error}
          close={() => {
            setError("");
          }}
        />
      )}
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
        {!compact && !filter.trim() && (
          <button
            type="button"
            className="sidebar-add-repository"
            data-nav
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
        )}
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
          <BackgroundErrorMark />
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
