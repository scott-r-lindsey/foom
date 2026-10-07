import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import type { BoardSource } from "./board-source.d";
import type { BoardRow } from "./board.d";
import type { SidebarPreferences } from "./sidebar.d";
import type { TileLayout, TileLeaf, TileRect, TileSplit } from "./tiles.d";
import type { TerminalViewSource } from "../terminal/terminal-view-source.d";
import { light } from "./board";
import { sessionName, rowRepository, rowWorktree, agentBadges } from "./sidebar-model";
import { rectangles, resizeSplit } from "./tiles";

function TerminalView({
  view,
  session,
  active,
  launchVersion,
}: {
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
    </>
  );
}
const position = (rect: TileRect): CSSProperties => ({
  left: `${String(rect.x)}%`,
  top: `${String(rect.y)}%`,
  width: `${String(rect.width)}%`,
  height: `${String(rect.height)}%`,
});
function Tile({
  tile,
  rect,
  number,
  source,
  row,
  preferences,
  focused,
  maximized,
  behind,
  inactive,
  focusRequest,
  select,
  action,
}: {
  tile: TileLeaf;
  rect: TileRect;
  number: number;
  source: BoardSource;
  row: BoardRow | undefined;
  preferences: SidebarPreferences;
  focused: boolean;
  maximized: boolean;
  behind: boolean;
  inactive: boolean;
  focusRequest: number;
  select: () => void;
  action: (action: "right" | "down" | "maximize" | "hide" | "close" | "restart") => void;
}) {
  const [view] = useState(() => source.createView?.());
  const [error, setError] = useState("");
  const lightRef = useRef<HTMLSpanElement>(null);
  const elementRef = useRef<HTMLElement>(null);
  useEffect(
    () =>
      source.subscribeActivity((batch) => {
        const activity = batch.find((item) => item.id === row?.id);
        if (activity && row)
          lightRef.current?.style.setProperty(
            "--light-opacity",
            String(light({ ...row, rate: activity.rate }).opacity),
          );
      }),
    [source, row],
  );
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
      data-focused={focused}
      data-state={row?.state}
      data-empty={!row}
      data-maximized={maximized}
      data-behind={behind}
      style={position(maximized ? { x: 0, y: 0, width: 100, height: 100 } : rect)}
      aria-label={`Tile ${String(number)}${row ? `: ${sessionName(row, preferences)}` : ": empty"}`}
      tabIndex={focused ? 0 : -1}
      inert={behind || inactive}
      onFocus={select}
      onPointerDown={(event) => {
        select();
        if (
          event.target instanceof Element &&
          !event.target.closest("button") &&
          !event.target.closest(".xterm")
        ) {
          if (view && row) view.focus();
          else elementRef.current?.focus();
        }
      }}
    >
      <header className="tile-title">
        {row && (
          <>
            <h2 className="visually-hidden">{`${row.repository} › ${rowWorktree(row) === rowRepository(row) ? "Main checkout" : row.branch} › ${sessionName(row, preferences)}`}</h2>
            <span
              ref={lightRef}
              className="board-light"
              style={{ "--light-opacity": light(row).opacity } as CSSProperties}
              role="img"
              aria-label={light(row).label}
            />
            <span className="board-agent">{agentBadges[row.agent] ?? row.agent}</span>
            <span className="tile-location" title={`${row.repository} › ${row.branch}`}>
              {row.repository} › {row.branch}
            </span>
            <span className="tile-name">{sessionName(row, preferences)}</span>
          </>
        )}
        <span className="tile-number">{number}</span>
        <div className="tile-controls">
          {(
            [
              ["right", "Split right", "◫"],
              ["down", "Split down", "⬒"],
              ["maximize", maximized ? "Restore tile" : "Maximize tile", "□"],
              ["hide", "Hide session", "−"],
              ["close", "Close tile", "×"],
            ] as const
          )
            .filter(([key]) => row || (key !== "maximize" && key !== "hide"))
            .map(([key, label, icon]) => (
              <button
                key={key}
                type="button"
                aria-label={label}
                title={label}
                onClick={() => {
                  action(key);
                }}
              >
                {icon}
              </button>
            ))}
        </div>
      </header>
      {row && (
        <>
          {row.state === "needs_input" && (
            <div className="tile-attention">
              <span title={row.reason}>{row.reason}</span>
              <button
                type="button"
                onClick={() => {
                  setError("");
                  void Promise.resolve(source.resolve(row.id, "Not attention")).catch(() => {
                    setError("Unable to record feedback. Try again.");
                  });
                }}
              >
                Not attention
              </button>
            </div>
          )}
          {row.exited && row.kind === "shell" && (
            <button
              type="button"
              onClick={() => {
                action("restart");
              }}
            >
              Restart shell
            </button>
          )}
          {error && <p role="alert">{error}</p>}
          {row.kind === "sample" && (
            <div className="sample-terminal">
              <pre>{row.tail.join("\n")}</pre>
              <p>Sample output · read-only</p>
            </div>
          )}
        </>
      )}
      {view && (
        <div className="tile-shell" hidden={!row || row.kind === "sample"}>
          <TerminalView
            view={view}
            session={row?.kind === "sample" ? undefined : row?.id}
            active={!inactive}
            launchVersion={row?.launchVersion ?? 0}
          />
        </div>
      )}
    </section>
  );
}
function Gutter({
  node,
  rect,
  area,
  change,
}: {
  node: TileSplit;
  rect: TileRect;
  area: TileRect;
  change: (id: string, ratio: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const horizontal = node.direction === "horizontal";
  return (
    <div
      role="separator"
      aria-label="Resize tiles"
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      aria-valuemin={15}
      aria-valuemax={85}
      aria-valuenow={Math.round(node.ratio * 100)}
      tabIndex={0}
      className="tile-gutter"
      data-direction={node.direction}
      data-dragging={dragging}
      style={position(rect)}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (!dragging) return;
        const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
        if (!bounds) return;
        const total = horizontal ? bounds.width : bounds.height;
        if (!total) return;
        const value =
          (((horizontal ? event.clientX - bounds.left : event.clientY - bounds.top) / total) * 100 -
            (horizontal ? area.x : area.y)) /
          (horizontal ? area.width : area.height);
        change(node.id, value);
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
        setDragging(false);
      }}
      onLostPointerCapture={() => {
        setDragging(false);
      }}
      onKeyDown={(event) => {
        const decrease = horizontal ? "ArrowLeft" : "ArrowUp",
          increase = horizontal ? "ArrowRight" : "ArrowDown";
        if (
          event.key === decrease ||
          event.key === increase ||
          event.key === "Home" ||
          event.key === "End"
        ) {
          event.preventDefault();
          change(
            node.id,
            event.key === "Home"
              ? 0.15
              : event.key === "End"
                ? 0.85
                : node.ratio + (event.key === decrease ? -0.05 : 0.05),
          );
        }
      }}
    />
  );
}
export function TileArea({
  source,
  layout,
  setLayout,
  rows,
  preferences,
  inactive,
  focusRequest,
  action,
}: {
  source: BoardSource;
  layout: TileLayout;
  setLayout: (next: TileLayout) => void;
  rows: readonly BoardRow[];
  preferences: SidebarPreferences;
  inactive: boolean;
  focusRequest: number;
  action: (
    tile: string,
    action: "right" | "down" | "maximize" | "hide" | "close" | "restart",
  ) => void;
}) {
  const geometry = rectangles(layout.tree);
  return (
    <div className="tile-area" aria-label="Terminal tiles" hidden={inactive}>
      {geometry.tiles.map(({ tile, rect }, index) => (
        <Tile
          key={tile.id}
          tile={tile}
          rect={rect}
          number={index + 1}
          source={source}
          row={rows.find((row) => row.id === tile.session)}
          preferences={preferences}
          focused={layout.focused === tile.id}
          maximized={layout.maximized === tile.id}
          behind={layout.maximized !== null && layout.maximized !== tile.id}
          inactive={inactive}
          focusRequest={focusRequest}
          select={() => {
            if (layout.focused !== tile.id) setLayout({ ...layout, focused: tile.id });
          }}
          action={(value) => {
            action(tile.id, value);
          }}
        />
      ))}
      {!layout.maximized &&
        geometry.gutters.map(({ split, rect, area }) => (
          <Gutter
            key={split.id}
            node={split}
            rect={rect}
            area={area}
            change={(id, ratio) => {
              setLayout(resizeSplit(layout, id, ratio));
            }}
          />
        ))}
    </div>
  );
}
