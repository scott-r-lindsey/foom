import { reviewLabel } from "../../shared/review-state";
import { ActionError, captureErrorFocus, useBackgroundErrors } from "./error-presentation";
import { errorMessage } from "../../shared/application-errors";
import { OrchestrationMark } from "./orchestration-mark";
import type { PreviewSummary } from "../../shared/workspace";
import { TileMenu } from "./tile-menu";
import { AgentBadge } from "./agent-badge";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import type { BoardSource } from "./board-source.d";
import type { BoardRow } from "./board.d";
import type { SidebarPreferences } from "./sidebar.d";
import type { TileAction, TileLayout, TileLeaf, TileRect } from "./tiles.d";
import { subscribeLights, lightState, movingLight } from "./light-activity";
import { light } from "./board";
import {
  sessionIdentity,
  sessionName,
  rowRepository,
  rowWorktree,
  agentBadges,
  previewOpener,
  sidebarParent,
} from "./sidebar-model";
import { landingSpace } from "./tiles";

import type { TerminalViewSource } from "../terminal/terminal-view-source.d";

/** Shared title-bar state mark; illustration callers supply no live subscriptions. */
export function TileLight({
  row,
  lightRef,
}: {
  row: BoardRow;
  lightRef?: React.Ref<HTMLSpanElement>;
}) {
  return (
    <span
      ref={lightRef}
      data-light-state={lightState(row)}
      data-moving={movingLight(row)}
      data-exited={Boolean(row.exited)}
      className="board-light"
      style={{ "--light-opacity": light(row).opacity } as CSSProperties}
      role="img"
      aria-label={light(row).label}
    />
  );
}

function TerminalView({
  view,
  session,
  active,
  launchVersion,
  row,
  name,
}: {
  row: BoardRow | undefined;
  name: string;
  view: TerminalViewSource;
  session: string | undefined;
  active: boolean;
  launchVersion: number;
}) {
  const status = useSyncExternalStore(view.subscribe, view.getSnapshot);
  const mount = useCallback(
    (element: HTMLDivElement | null) => (element ? view.mount(element) : undefined),
    [view],
  );
  useEffect(() => {
    void (active && session ? view.open(session) : view.hide());
    // A relaunch keeps its row ID but needs a fresh host attachment.
  }, [view, session, active, launchVersion]);
  return (
    <>
      <span className="tile-status visually-hidden" role="status">
        {status.status}
      </span>
      <div className="tile-terminal" ref={mount} />
      {row && (row.dormant || status.attaching) && (
        <div className="tile-restoring" aria-label={`Restoring ${name}`} role="status">
          <div className="tile-restoring-identity">
            <AgentBadge mark={row.kind === "shell" ? ">_" : agentBadges.get(row.agent)} />
            <span>{name}</span>
          </div>
          <div className="tile-restoring-lines" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </div>
      )}
    </>
  );
}
export const position = (rect: TileRect): CSSProperties => ({
  left: `${String(rect.x)}%`,
  top: `${String(rect.y)}%`,
  width: `${String(rect.width)}%`,
  height: `${String(rect.height)}%`,
});
export function Tile({
  tile,
  rect,
  number,
  source,
  row,
  rows,
  preview,
  preferences,
  focused,
  maximized,
  behind,
  inactive,
  focusRequest,
  select,
  action,
  layout,
  collapsing,
  arrived,
  acknowledgePreview,
}: {
  layout: TileLayout;
  collapsing: boolean;
  arrived: boolean;
  acknowledgePreview: () => void;
  rows: readonly BoardRow[];
  tile: TileLeaf;
  rect: TileRect;
  number: number;
  source: BoardSource;
  row: BoardRow | undefined;
  preview: PreviewSummary | undefined;
  preferences: SidebarPreferences;
  focused: boolean;
  maximized: boolean;
  behind: boolean;
  inactive: boolean;
  focusRequest: number;
  select: () => void;
  action: (action: TileAction) => void;
}) {
  const { report, clear } = useBackgroundErrors();
  const [view] = useState(() => source.createView?.());
  const [error, setError] = useState("");
  const errorOriginRef = useRef<Element | null>(null);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; point?: { x: number; y: number } }>();
  const menuRef = useRef<HTMLButtonElement>(null);
  const lightRef = useRef<HTMLSpanElement>(null);
  const elementRef = useRef<HTMLElement>(null);
  const rowId = row?.id;
  const parent = row ? sidebarParent(row, rows) : undefined;
  const driver = rows.find((entry) => entry.id === row?.probeOwner);
  const occupied = Boolean(row || preview);
  const name = row ? sessionName(row, preferences) : (preview?.relativePath ?? "");
  useEffect(
    () =>
      subscribeLights(source, () => {
        const current = source.getSnapshot().find((item) => item.id === rowId);
        return current && lightRef.current ? [{ row: current, element: lightRef.current }] : [];
      }),
    [source, rowId],
  );
  const previewRef = useRef<HTMLDivElement>(null);
  const reportRef = useRef(() => {});
  // Hide the native view only when this preview leaves the tile. Re-running the
  // lifetime effect on every layout change detached and re-attached the view on
  // each step of a gutter drag, which some X11 compositors never repaint.
  useEffect(() => {
    const id = preview?.id;
    const element = previewRef.current;
    if (!id || !element || !source.previews) return;
    const report = () => {
      reportRef.current();
    };
    const observer = new ResizeObserver(report);
    observer.observe(element);
    window.addEventListener("resize", report);
    const tileElement = element.parentElement;
    tileElement?.addEventListener("transitionend", report);
    return () => {
      observer.disconnect();
      tileElement?.removeEventListener("transitionend", report);
      window.removeEventListener("resize", report);
      reportRef.current = () => {};
      void source.previews
        ?.bounds(id, { x: 0, y: 0, width: 0, height: 0, visible: false })
        .catch(() => {});
    };
  }, [source, preview?.id]);
  useEffect(() => {
    const id = preview?.id;
    const element = previewRef.current;
    if (!id || !element || !source.previews) return;
    reportRef.current = () => {
      const bounds = element.getBoundingClientRect();
      void source.previews
        ?.bounds(id, {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          visible: !inactive && !behind && bounds.width > 0 && bounds.height > 0,
        })
        .then(() => {
          clear(`preview-bounds:${id}`);
        })
        .catch(() => {
          report(`preview-bounds:${id}`, "Unable to display preview.", id);
        });
    };
    reportRef.current();
  }, [
    source,
    preview?.id,
    inactive,
    behind,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    clear,
    report,
  ]);
  const lastFocusRef = useRef(0);
  useEffect(() => {
    if (focusRequest === lastFocusRef.current) return;
    lastFocusRef.current = focusRequest;
    if (focused && !inactive) {
      if (view && row?.kind !== "sample" && row) view.focus();
      else elementRef.current?.focus();
    }
  }, [focusRequest, focused, inactive, view, row]);
  return (
    <section
      ref={elementRef}
      className="terminal-tile"
      data-tile={tile.id}
      data-arrived={arrived}
      onPointerEnter={acknowledgePreview}
      data-preview-id={preview?.id}
      data-focused={occupied && focused}
      data-landing={!occupied && landingSpace(layout)?.id === tile.id}
      data-collapsing={collapsing}
      data-state={row ? lightState(row) : undefined}
      data-exited={row?.exited}
      data-kind={row?.kind ?? (preview ? "preview" : undefined)}
      data-empty={!occupied}
      data-maximized={maximized}
      data-behind={behind}
      style={position(maximized ? { x: 0, y: 0, width: 100, height: 100 } : rect)}
      aria-label={`Tile ${String(number)}${occupied ? `: ${name}` : ": empty"}${preview?.openedBy ? `, opened by ${previewOpener(preview, rows, preferences)}` : ""}`}
      aria-hidden={!occupied || undefined}
      tabIndex={occupied ? (focused ? 0 : -1) : undefined}
      inert={behind || inactive}
      onFocus={() => {
        acknowledgePreview();
        if (occupied) select();
      }}
      onPointerDown={(event) => {
        if (!occupied) return;
        acknowledgePreview();
        select();
        if (
          event.button !== 2 &&
          event.target instanceof Element &&
          !event.target.closest("button") &&
          !event.target.closest(".xterm")
        ) {
          if (view && row) view.focus();
          else elementRef.current?.focus();
        }
      }}
    >
      {occupied && (
        <header
          className="tile-title"
          draggable
          onDoubleClick={(event) => {
            if (event.target instanceof Element && !event.target.closest("button"))
              action("maximize");
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            select();
            if (menuRef.current)
              setMenu({ anchor: menuRef.current, point: { x: event.clientX, y: event.clientY } });
          }}
        >
          {row && (
            <>
              <h2 className="visually-hidden">{`${row.repository} › ${rowWorktree(row) === rowRepository(row) ? "Main checkout" : row.branch} › ${sessionName(row, preferences)}`}</h2>
              <TileLight row={row} lightRef={lightRef} />
              {row.state === "waiting" && (
                <span className="session-waiting">{light(row).label}</span>
              )}
              {row.review && (
                <span className="session-orchestration" data-review-phase={row.review.phase}>
                  {reviewLabel(row.review)}
                </span>
              )}
              <AgentBadge mark={row.kind === "shell" ? ">_" : agentBadges.get(row.agent)} />
              {row.orchestration?.role === "child" && (
                <OrchestrationMark
                  kind="rx"
                  related={false}
                  label="Worker"
                  title={`Child of ${parent ? sessionName(parent, preferences) : row.orchestration.parentId}${row.orchestration.takenOver ? " · Taken over" : ""}`}
                />
              )}
              <span
                className={row.probe ? "tile-location probe-driver" : "tile-location"}
                title={`${row.repository} › ${row.branch}`}
              >
                {row.probe
                  ? `Probe · ${driver ? sessionName(driver, preferences) : "Config session"}`
                  : `${row.repository} › ${row.branch}`}
              </span>
              <span className="tile-name" title={sessionIdentity(row, source.shellName?.())}>
                {sessionName(row.probe ? { ...row, probe: false } : row, preferences)}
              </span>
              {(row.exited || row.foregroundProgram) && (
                <span className="session-program">
                  {row.exited ? "exited" : row.foregroundProgram}
                </span>
              )}
            </>
          )}
          {preview && (
            <>
              {arrived && (
                <span className="visually-hidden" role="status">
                  New preview
                </span>
              )}
              <svg className="preview-glyph" aria-hidden="true" viewBox="0 0 16 16">
                <path d="M4 1.5h5l3 3v10H4z M9 1.5v3h3 M6 8h4 M6 10.5h4" />
              </svg>
              <AgentBadge mark={preview.kind === "markdown" ? "MD" : "HTML"} />
              <span className="tile-name" title={preview.relativePath}>
                {preview.relativePath}
              </span>
              {preview.openedBy && (
                <span
                  className="preview-opener"
                  title={`Opened by ${previewOpener(preview, rows, preferences)}`}
                >
                  <span>opened by</span>
                  <AgentBadge mark={agentBadges.get(preview.openedBy.agent) ?? "?"} />
                </span>
              )}
              {preview.network && <span className="session-program">network</span>}
            </>
          )}
          <button
            ref={menuRef}
            type="button"
            className="tile-number"
            aria-label={`Tile ${String(number)} menu`}
            aria-haspopup="dialog"
            aria-expanded={Boolean(menu)}
            onClick={(event) => {
              setMenu(menu ? undefined : { anchor: event.currentTarget });
            }}
          >
            {number} <span aria-hidden="true">⌄</span>
          </button>
          <div className="tile-controls">
            <button
              type="button"
              aria-label={maximized ? "Restore tile" : "Maximize tile"}
              title={maximized ? "Restore tile" : "Maximize tile"}
              onClick={() => {
                action("maximize");
              }}
            >
              □
            </button>
            <button
              type="button"
              aria-label={preview || row?.exited ? "Close" : "Hide"}
              title={preview || row?.exited ? "Close" : "Hide"}
              onClick={() => {
                action(preview || row?.exited ? "close" : "hide");
              }}
            >
              {preview || row?.exited ? "×" : "−"}
            </button>
          </div>
        </header>
      )}
      {occupied && menu && !inactive && !behind && (
        <TileMenu
          anchor={menu.anchor}
          point={menu.point}
          layout={{ ...layout, focused: tile.id }}
          row={row}
          preview={preview}
          name={name}
          number={number}
          view={view}
          popout={preview ? typeof source.previews?.popout === "function" : Boolean(source.windows)}
          network={
            preview && preview.worktree !== "foom:manual" && source.previews?.network
              ? () => {
                  errorOriginRef.current = captureErrorFocus();
                  void source.previews
                    ?.network?.(preview.id, !preview.network)
                    .catch((error: unknown) => {
                      setError(errorMessage(error, "Network change failed"));
                    });
                }
              : undefined
          }
          close={() => {
            setMenu(undefined);
          }}
          action={action}
        />
      )}
      {row && (
        <>
          {row.probeNote && (
            <p className="probe-note" role="note">
              Runs the real CLI on your account. May use credits.
            </p>
          )}
          {!row.probe && row.state === "needs_input" && (
            <div className="tile-attention">
              <span title={row.reason}>{row.reason}</span>
              <button
                type="button"
                aria-label="Dismiss incorrect attention flag"
                title="Dismiss incorrect attention flag (records a false positive)"
                onClick={() => {
                  errorOriginRef.current = captureErrorFocus();
                  setError("");
                  void Promise.resolve(source.resolve(row.id, "Dismissed")).catch(() => {
                    setError("Unable to record feedback. Try again.");
                  });
                }}
              >
                Dismiss
              </button>
            </div>
          )}
          {row.kind === "sample" && (
            <div className="sample-terminal">
              <pre>{row.tail.join("\n")}</pre>
              <p>Sample output · read-only</p>
            </div>
          )}
        </>
      )}
      {preview && <div className="tile-shell" ref={previewRef} />}
      {error && (
        <ActionError
          message={error}
          returnFocus={() => errorOriginRef.current}
          close={() => {
            setError("");
          }}
        />
      )}
      {view && (
        <div className="tile-shell" hidden={!row || row.kind === "sample"}>
          <TerminalView
            view={view}
            row={row}
            name={name}
            session={row?.kind === "sample" ? undefined : row?.id}
            active={!inactive}
            launchVersion={row?.launchVersion ?? 0}
          />
        </div>
      )}
    </section>
  );
}
