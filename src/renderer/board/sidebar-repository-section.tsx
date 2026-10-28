import { repositoryKey } from "./sidebar-model";
import { BackgroundErrorMark } from "./error-presentation";
import type { SidebarRowEvents } from "./sidebar-interactions.d";
import type { ReactNode } from "react";
import type { SidebarTree } from "./sidebar.d";
import type { BoardRow } from "./board.d";
import { Highlight } from "./text-highlight";
import { light } from "./board";
export function SidebarRollup({ row }: { row: BoardRow | undefined }) {
  return (
    row && (
      <span className="rollup" role="img" data-state={row.state} aria-label={light(row).label}>
        <span className="board-light" aria-hidden="true" />
      </span>
    )
  );
}
export interface SidebarRepositorySectionProps {
  repo: SidebarTree;
  separator: boolean;
  filter: string;
  empty: boolean;
  panelOpen: boolean;
  events: SidebarRowEvents;
  actions: ReactNode;
  children: ReactNode;
  register: (element: HTMLButtonElement | null) => void;
  toggle: () => void;
  openPanel: (anchor: HTMLElement) => void;
}
export function SidebarRepositorySection({
  repo,
  separator,
  filter,
  empty,
  panelOpen,
  events,
  actions,
  children,
  register,
  toggle,
  openPanel,
}: SidebarRepositorySectionProps) {
  const cleanup = repo.repository.cleanup;
  const deleting = cleanup && cleanup.phase !== "finished";
  return (
    <div>
      {separator && <hr className="tree-separator" aria-hidden="true" />}
      <div role="treeitem" aria-expanded={repo.expanded} aria-label={repo.repository.name}>
        <div {...events} className="tree-row repository-row">
          <button
            type="button"
            className="tree-chevron"
            aria-label={`${repo.expanded ? "Collapse" : "Expand"} ${repo.repository.name}`}
            onClick={() => {
              toggle();
            }}
          >
            {repo.expanded ? "▾" : "▸"}
          </button>
          <button
            type="button"
            data-nav
            ref={(element) => {
              register(element);
            }}
            className="tree-name"
            aria-haspopup="dialog"
            aria-expanded={panelOpen}
            onClick={(event) => {
              openPanel(event.currentTarget);
            }}
          >
            <span className="tree-label">
              <Highlight text={repo.repository.name} filter={filter} />
            </span>
            {repo.pinned && <span aria-label="Pinned">⌖</span>}
          </button>
          {repo.repository.unavailable && <span className="worktree-removed">Unavailable</span>}
          {deleting && (
            <span className="cleanup-tag">
              deleting {cleanup.done}/{cleanup.total}
            </span>
          )}
          {cleanup?.phase === "finished" && (
            <span role="status" className="cleanup-tag">
              Cleanup finished: {cleanup.done}/{cleanup.total}
            </span>
          )}
          {!repo.expanded && (
            <>
              <SidebarRollup row={repo.rollup} />
              <span className="worktree-count">
                {repo.repository.worktrees.filter((tree) => !tree.removed).length}
              </span>
            </>
          )}
          <BackgroundErrorMark row={repositoryKey(repo.repository.path)} />
          {actions}
        </div>
        {repo.expanded && (
          <div role="group">
            {empty && <p className="tree-empty">Nothing here yet</p>}
            {children}
          </div>
        )}
      </div>
    </div>
  );
}
