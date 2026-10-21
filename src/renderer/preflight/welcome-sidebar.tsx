import { type CSSProperties } from "react";
import type { BoardRow } from "../board/board.d";
import { buildSidebar, sidebarRepositories, sessionName } from "../board/sidebar-model";
import { SidebarRepositorySection } from "../board/sidebar-repository-section";
import { SidebarWorktreeSection } from "../board/sidebar-worktree-section";
import { SidebarSessionRow } from "../board/sidebar-session-row";
import type { FeedView, Agent } from "./welcome-noise-output";

export const NEEDS_YOU = 3;
export const DONE = 7;
const tasks = [
  "Map the tides",
  "Chart the stars",
  "Trace an orbit",
  "Choose a landing",
  "Grow a canopy",
  "Fold the wings",
  "Test the compass",
  "Bind the atlas",
  "Light the lanterns",
  "Polish the lens",
];
/** Illustration data only; never connected to the live board, persistence or IPC. */
export const welcomeRows = tasks.map((name, index): BoardRow & { agent: Agent; name: string } => {
  const repository = index < 5 ? "lumen-garden" : "paper-comet";
  const branch =
    index < 3
      ? "feat/tide-map"
      : index < 5
        ? "feat/canopy"
        : index < 8
          ? "feat/star-atlas"
          : "fix/lanterns";
  return {
    id: `welcome-${String(index)}`,
    name,
    kind: "agent",
    repository,
    repositoryPath: `/illustration/${repository}`,
    worktree: `/illustration/${repository}/${branch}`,
    branch,
    agent: index % 3 === 0 ? "Claude Code" : index % 3 === 1 ? "Codex" : "Antigravity",
    state: "working",
    reason: "Working",
    rate: 0,
    waitingSince: 0,
    seen: false,
    tail: [],
  };
});
const preferences = {
  pins: [],
  expanded: {},
  names: Object.fromEntries(welcomeRows.map((row) => [row.id, row.name])),
};
const noop = () => {};
const events = {
  onPointerEnter: noop,
  onPointerLeave: noop,
  onContextMenu: noop,
  onKeyDownCapture: noop,
};

export function WelcomeSidebar({
  settled,
  views,
  reduced,
}: {
  settled: boolean;
  views: readonly FeedView[];
  reduced: boolean;
}) {
  const rows = welcomeRows.map((row, index) => ({
    ...row,
    state:
      settled && index === NEEDS_YOU
        ? ("needs_input" as const)
        : settled && index === DONE
          ? ("done" as const)
          : ("working" as const),
    reason:
      settled && index === NEEDS_YOU
        ? "Needs you · Choose a landing"
        : settled && index === DONE
          ? "Done · Atlas bound"
          : "Working",
  }));
  const { tree } = buildSidebar(rows, sidebarRepositories(rows, []), preferences, "");
  return (
    <div className="welcome-sidebar sidebar-shell" data-compact="false">
      <div role="tree">
        {tree.map((repo, repoIndex) => (
          <SidebarRepositorySection
            key={repo.repository.path}
            repo={repo}
            separator={repoIndex > 0}
            filter=""
            empty={false}
            panelOpen={false}
            events={events}
            actions={null}
            register={noop}
            toggle={noop}
            openPanel={noop}
          >
            {repo.worktrees.map(({ tree: worktree, sessions, rollup }) => (
              <SidebarWorktreeSection
                key={worktree.path}
                worktree={worktree}
                name={String(worktree.branch)}
                branch={String(worktree.branch)}
                main={false}
                expanded
                rollup={rollup}
                cleanupItem={undefined}
                cleanupDismissed={false}
                arriving={false}
                filter=""
                panelOpen={false}
                events={events}
                actions={null}
                register={noop}
                toggle={noop}
                openPanel={noop}
                openPullRequest={() => Promise.resolve()}
                dismissCleanup={noop}
                settle={noop}
              >
                {sessions.map((row) => {
                  const index = welcomeRows.findIndex((item) => item.id === row.id);
                  return (
                    <div
                      key={row.id}
                      data-welcome-session={row.id}
                      style={
                        {
                          "--welcome-level": reduced ? 0.7 : (views[index]?.level ?? 1),
                        } as CSSProperties
                      }
                    >
                      <SidebarSessionRow
                        row={row}
                        name={sessionName(row, preferences)}
                        identity={row.agent}
                        parentName={undefined}
                        related={false}
                        compact={false}
                        docked={false}
                        now={0}
                        filter=""
                        tile={undefined}
                        otherView={false}
                        selected={undefined}
                        events={events}
                        actions={null}
                        register={noop}
                        focus={noop}
                        open={noop}
                        rename={noop}
                        onHover={noop}
                        onFocusSession={noop}
                      />
                    </div>
                  );
                })}
              </SidebarWorktreeSection>
            ))}
          </SidebarRepositorySection>
        ))}
      </div>
      <button
        type="button"
        className="sidebar-add-repository"
        aria-label="Add repository"
        tabIndex={-1}
      >
        +
      </button>
    </div>
  );
}
