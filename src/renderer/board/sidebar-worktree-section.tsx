import { worktreeKey } from "./sidebar-model";
import { BackgroundErrorMark } from "./error-presentation";
import type { SidebarRowEvents } from "./sidebar-interactions.d";
import type { ReactNode } from "react";
import type { SidebarWorktree } from "./sidebar.d";
import type { BoardRow } from "./board.d";
import type { CleanupProgress } from "../../shared/cleanup";
import { Highlight } from "./text-highlight";
import { PullRequestMark } from "./pull-request";
import { SidebarRollup } from "./sidebar-repository-section";
export interface SidebarWorktreeSectionProps {
  worktree: SidebarWorktree;
  name: string;
  branch: string;
  main: boolean;
  expanded: boolean;
  rollup: BoardRow | undefined;
  cleanupItem: CleanupProgress["items"][number] | undefined;
  cleanupDismissed: boolean;
  arriving: boolean;
  filter: string;
  panelOpen: boolean;
  events: SidebarRowEvents;
  actions: ReactNode;
  children: ReactNode;
  register: (element: HTMLButtonElement | null) => void;
  toggle: () => void;
  openPanel: (anchor: HTMLElement) => void;
  openPullRequest: () => Promise<void>;
  dismissCleanup: () => void;
  settle: (delay: number) => void;
}
export function SidebarWorktreeSection({
  worktree,
  name,
  branch,
  main,
  expanded,
  rollup,
  cleanupItem,
  cleanupDismissed,
  arriving,
  filter,
  panelOpen,
  events,
  actions,
  children,
  register,
  toggle,
  openPanel,
  openPullRequest,
  dismissCleanup,
  settle,
}: SidebarWorktreeSectionProps) {
  return (
    <div
      data-cleanup={cleanupItem?.state}
      aria-hidden={cleanupItem?.state === "removed" ? true : undefined}
      role="treeitem"
      aria-expanded={expanded}
      aria-label={name}
    >
      <div
        {...events}
        data-cleanup={cleanupItem?.state}
        onFocus={() => {
          if (cleanupItem?.state === "kept") dismissCleanup();
        }}
        className={`tree-row worktree-row${arriving ? " arriving" : ""}`}
        onPointerEnter={(event) => {
          events.onPointerEnter(event);
          if (cleanupItem?.state === "kept") dismissCleanup();
          if (arriving) settle(600);
        }}
      >
        <button
          type="button"
          className="tree-chevron"
          aria-label={`${expanded ? "Collapse" : "Expand"} ${name}`}
          onClick={() => {
            toggle();
          }}
        >
          {expanded ? "▾" : "▸"}
        </button>
        <button
          type="button"
          data-nav
          ref={(element) => {
            register(element);
          }}
          onBlur={() => {
            if (arriving) settle(0);
          }}
          className="tree-name"
          aria-label={name}
          aria-haspopup="dialog"
          aria-expanded={panelOpen}
          onClick={(event) => {
            openPanel(event.currentTarget);
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
            <span className={main ? "tree-label tree-checkout-branch" : undefined}>
              <Highlight text={branch} filter={filter} />
            </span>
          </span>
        </button>
        {worktree.unavailable && <span className="worktree-removed">Unavailable</span>}
        {worktree.prunable && <span className="worktree-removed">Broken checkout</span>}
        {worktree.pullRequest && (
          <PullRequestMark pr={worktree.pullRequest} open={openPullRequest} />
        )}
        {cleanupItem && !(cleanupItem.state === "kept" && cleanupDismissed) && (
          <span className="cleanup-tag">{cleanupItem.reason ?? cleanupItem.state}</span>
        )}
        {worktree.removed && (
          <span className="worktree-removed">
            <span aria-hidden="true">⊘</span> Worktree removed
          </span>
        )}
        {!expanded && <SidebarRollup row={rollup} />}
        <BackgroundErrorMark row={worktreeKey(worktree.path)} />
        {actions}
      </div>
      {expanded && <div role="group">{children}</div>}
    </div>
  );
}
