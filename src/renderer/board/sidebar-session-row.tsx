import { BackgroundErrorMark } from "./error-presentation";
import type { SidebarRowEvents } from "./sidebar-interactions.d";
import type { CSSProperties, ReactNode } from "react";
import type { BoardRow } from "./board.d";
import { OrchestrationMark } from "./orchestration-mark";
import { AgentBadge } from "./agent-badge";
import { agentBadges } from "./sidebar-model";
import { lightState, movingLight } from "./light-activity";
import { light, waitTime } from "./board";
import { Highlight } from "./text-highlight";
import { SessionName } from "./session-name";

/** Presentation only: the sidebar owns focus, panel intent and selection. */
export interface SidebarSessionRowProps {
  row: BoardRow;
  name: string;
  identity: string;
  parentName: string | undefined;
  related: boolean;
  compact: boolean;
  docked: boolean;
  now: number;
  filter: string;
  tile: { number: number; focused: boolean } | undefined;
  otherView: boolean;
  selected: string | undefined;
  events: SidebarRowEvents;
  actions: ReactNode;
  register: (id: string, element: HTMLDivElement | null) => void;
  focus: (id: string) => void;
  open: (row: BoardRow) => void;
  rename: (value: string) => void;
  onHover: (id: string | undefined) => void;
  onFocusSession: (id: string | undefined) => void;
}
export function SidebarSessionRow({
  row,
  name,
  identity,
  parentName,
  related,
  compact,
  docked,
  now,
  filter,
  tile,
  otherView,
  selected,
  events,
  actions,
  register,
  focus,
  open,
  rename,
  onHover,
  onFocusSession,
}: SidebarSessionRowProps) {
  const mark =
    row.orchestration?.role === "orchestrator"
      ? "tx"
      : row.orchestration?.role === "child" && !row.orchestration.takenOver
        ? parentName
          ? "rx"
          : "orphan"
        : undefined;
  const robot = mark ? <OrchestrationMark kind={mark} related={related} /> : null;
  return (
    <div
      {...events}
      onPointerEnter={(event) => {
        events.onPointerEnter(event);
        onHover(row.orchestration ? row.id : undefined);
      }}
      onPointerLeave={(event) => {
        events.onPointerLeave(event);
        onHover(undefined);
      }}
      onFocusCapture={() => {
        onFocusSession(row.orchestration ? row.id : undefined);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onFocusSession(undefined);
      }}
      className="board-entry session-entry"
      data-related={related}
      role="none"
      data-selected={selected === row.id}
    >
      <div
        role={docked ? "button" : "treeitem"}
        aria-selected={docked ? undefined : selected === row.id}
        className="board-row"
        title={
          row.orchestration?.role === "child"
            ? `Child of ${parentName ?? row.orchestration.parentId}${row.orchestration.takenOver ? " · Taken over" : ""}`
            : undefined
        }
        draggable
        data-drag-session={row.id}
        data-nav
        data-kind={row.kind}
        data-state={lightState(row)}
        data-exited={Boolean(row.exited)}
        tabIndex={docked || row.id === selected ? 0 : -1}
        aria-label={`${compact ? `${row.home ? "~" : row.config ? "Foom config" : row.repository} · ` : ""}${row.branch} · ${name}${name === identity ? "" : ` · ${identity}`} · ${light(row).label}${row.orchestration?.role === "child" ? ` · Child of ${parentName ?? row.orchestration.parentId}` : ""}${row.foregroundProgram ? ` · ${row.foregroundProgram}` : ""}${row.kind === "shell" ? "" : ` · ${row.reason}`}${row.handoff ? ` · Handoff ${row.handoff.status}` : ""}${row.bypass ? " · Bypass" : ""}${row.worktreeRemoved ? " · Worktree removed" : ""}`}
        ref={(element) => {
          register(row.id, element);
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
          data-light-state={lightState(row)}
          data-moving={movingLight(row)}
          data-exited={Boolean(row.exited)}
          style={{ "--light-opacity": light(row).opacity } as CSSProperties}
          aria-hidden="true"
        />
        <span className="session-lines">
          <span className="visually-hidden board-branch">{row.branch}</span>
          {row.orchestration?.role === "orchestrator" && (
            <span className="session-orchestration">
              {row.orchestration.active
                ? "Orchestrator"
                : row.exited
                  ? "Exited orchestrator"
                  : "Revoked orchestrator"}
            </span>
          )}
          <span className="session-top">
            {!compact && (
              <AgentBadge mark={row.kind === "shell" ? ">_" : agentBadges.get(row.agent)} />
            )}
            {row.handoff && (
              <span
                className="session-handoff"
                data-status={row.handoff.status}
                title={`Handoff #${String(row.handoff.seq)} (${row.handoff.status})`}
              >
                <span aria-hidden="true">
                  {row.handoff.status === "done"
                    ? "✓"
                    : row.handoff.status === "failed"
                      ? "■"
                      : "⊘"}
                </span>{" "}
                {row.handoff.status}
              </span>
            )}
            {row.bypass && (
              <span className="session-bypass" title="Launched with a bypass argument">
                <span aria-hidden="true">◇</span> Bypass
              </span>
            )}
            {otherView && (
              <span
                className="tile-number"
                aria-label="Shown in another window"
                title="Shown in another window"
              >
                ▣
              </span>
            )}
            {tile !== undefined && (
              <span
                className="tile-number"
                data-focused={tile.focused}
                aria-label={`Tile ${String(tile.number)}`}
              >
                {tile.number}
              </span>
            )}
            <SessionName
              name={name}
              filter={filter}
              open={() => {
                open(row);
              }}
              save={(value) => {
                rename(value);
              }}
            />
            {(row.exited || row.foregroundProgram) && (
              <span className="session-program">
                {row.exited ? "exited" : row.foregroundProgram}
              </span>
            )}
            {movingLight(row) && (
              <svg
                className="activity-trace"
                data-light-state={lightState(row)}
                viewBox="0 0 34 12"
                aria-hidden="true"
              >
                <path d="" />
              </svg>
            )}
            {!compact && robot}
            {row.state === "needs_input" && (
              <span className="board-wait">{waitTime(row, now)}</span>
            )}
          </span>
          {row.worktreeRemoved && (
            <span className="worktree-removed">
              <span aria-hidden="true">⊘</span> Worktree removed
            </span>
          )}
          {row.kind !== "shell" && (
            <span className="board-reason" title={row.reason}>
              <Highlight text={row.reason} filter={filter} />
            </span>
          )}
          <span className="visually-hidden board-state">{light(row).label}</span>
        </span>
        {compact && robot}
        {!docked && actions}
      </div>
      <BackgroundErrorMark row={row.id} />
      {docked && actions}
    </div>
  );
}
