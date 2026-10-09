import { TileMenu } from "./tile-menu";
import { AgentBadge } from "./agent-badge";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, DragEvent } from "react";
import type { BoardSource } from "./board-source.d";
import type { BoardRow } from "./board.d";
import type { SidebarPreferences } from "./sidebar.d";
import type {
  TileAction,
  TileDrag,
  DropZone,
  TileLayout,
  TileLeaf,
  TileRect,
  TileSplit,
} from "./tiles.d";
import type { TerminalViewSource } from "../terminal/terminal-view-source.d";
import { light } from "./board";
import {
  sessionIdentity,
  sessionName,
  rowRepository,
  rowWorktree,
  agentBadges,
} from "./sidebar-model";
import {
  rectangles,
  resizeSplit,
  dropTile,
  dropZone,
  terminals,
  landingSpace,
  ratioLimits,
  leaves,
} from "./tiles";

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
  layout,
  collapsing,
}: {
  layout: TileLayout;
  collapsing: boolean;
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
  action: (action: TileAction) => void;
}) {
  const [view] = useState(() => source.createView?.());
  const [error, setError] = useState("");
  const [menu, setMenu] = useState<{ anchor: HTMLElement; point?: { x: number; y: number } }>();
  const menuRef = useRef<HTMLButtonElement>(null);
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
      data-focused={Boolean(row) && focused}
      data-landing={!row && landingSpace(layout)?.id === tile.id}
      data-collapsing={collapsing}
      data-state={row?.state}
      data-empty={!row}
      data-maximized={maximized}
      data-behind={behind}
      style={position(maximized ? { x: 0, y: 0, width: 100, height: 100 } : rect)}
      aria-label={`Tile ${String(number)}${row ? `: ${sessionName(row, preferences)}` : ": empty"}`}
      aria-hidden={!row || undefined}
      tabIndex={row ? (focused ? 0 : -1) : undefined}
      inert={behind || inactive}
      onFocus={() => {
        if (row) select();
      }}
      onPointerDown={(event) => {
        if (!row) return;
        select();
        if (
          event.target instanceof Element &&
          !event.target.closest("button") &&
          !event.target.closest(".xterm")
        ) {
          if (view) view.focus();
          else elementRef.current?.focus();
        }
      }}
    >
      {row && (
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
          {
            <>
              <h2 className="visually-hidden">{`${row.repository} › ${rowWorktree(row) === rowRepository(row) ? "Main checkout" : row.branch} › ${sessionName(row, preferences)}`}</h2>
              <span
                ref={lightRef}
                className="board-light"
                style={{ "--light-opacity": light(row).opacity } as CSSProperties}
                role="img"
                aria-label={light(row).label}
              />
              <AgentBadge mark={row.kind === "shell" ? ">_" : agentBadges.get(row.agent)} />
              <span className="tile-location" title={`${row.repository} › ${row.branch}`}>
                {row.repository} › {row.branch}
              </span>
              <span className="tile-name" title={sessionIdentity(row, source.shellName?.())}>
                {sessionName(row, preferences)}
              </span>
            </>
          }
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
              aria-label={row.exited ? "Close" : "Hide"}
              title={row.exited ? "Close" : "Hide"}
              onClick={() => {
                action(row.exited ? "close" : "hide");
              }}
            >
              {row.exited ? "×" : "−"}
            </button>
          </div>
        </header>
      )}
      {row && menu && !inactive && !behind && (
        <TileMenu
          anchor={menu.anchor}
          point={menu.point}
          layout={{ ...layout, focused: tile.id }}
          row={row}
          name={sessionName(row, preferences)}
          number={number}
          view={view}
          popout={Boolean(source.windows)}
          close={() => {
            setMenu(undefined);
          }}
          action={action}
        />
      )}
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
  change: (id: string, ratio: number, commit?: boolean) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [min, max] = ratioLimits(node);
  const horizontal = node.direction === "horizontal";
  return (
    <div
      role="separator"
      aria-label="Resize tiles"
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      aria-valuemin={min * 100}
      aria-valuemax={max * 100}
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
        change(node.id, node.ratio, true);
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
              ? min
              : event.key === "End"
                ? max
                : node.ratio + (event.key === decrease ? -0.05 : 0.05),
            true,
          );
        }
      }}
    />
  );
}
export function TileArea({
  drag,
  endDrag,
  dropLayout,
  source,
  layout,
  setLayout,
  rows,
  preferences,
  inactive,
  focusRequest,
  action,
}: {
  drag?: TileDrag | undefined;
  endDrag: () => void;
  dropLayout: (next: TileLayout) => void;
  source: BoardSource;
  layout: TileLayout;
  setLayout: (next: TileLayout) => void;
  rows: readonly BoardRow[];
  preferences: SidebarPreferences;
  inactive: boolean;
  focusRequest: number;
  action: (tile: string, action: TileAction) => void;
}) {
  const [lastPreview, setLastPreview] = useState<{
    tile: string;
    zone: DropZone;
    drag: TileDrag;
  }>();
  const preview = lastPreview?.drag === drag ? lastPreview : undefined;
  const geometry = rectangles(layout.tree);
  const targetAt = (event: DragEvent<HTMLDivElement>) => {
    if (
      !drag ||
      inactive ||
      !(event.target instanceof Element) ||
      (drag.kind === "session" && !rows.some((row) => row.id === drag.id))
    )
      return;
    const tile = event.target.closest<HTMLElement>("[data-tile]");
    const id = tile?.dataset["tile"];
    if (!tile || !id) return;
    const bounds = tile.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    return {
      drag,
      tile: id,
      zone:
        tile.dataset["empty"] === "true"
          ? ("center" as const)
          : dropZone(
              (event.clientX - bounds.left) / bounds.width,
              (event.clientY - bounds.top) / bounds.height,
            ),
    };
  };
  return (
    <div
      className="tile-area"
      aria-label="Terminal tiles"
      hidden={inactive}
      onDragOver={(event) => {
        const target = targetAt(event);
        if (!target) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setLastPreview(target);
      }}
      onDragLeave={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          setLastPreview(undefined);
      }}
      onDrop={(event) => {
        const target = targetAt(event);
        if (target && drag) {
          event.preventDefault();
          const next = dropTile(layout, drag, target.tile, target.zone);
          if (next !== layout) dropLayout(next);
        }
        setLastPreview(undefined);
        endDrag();
      }}
    >
      <span className="visually-hidden" role="status">
        {drag
          ? preview
            ? `Drop ${preview.zone === "center" ? (drag.kind === "tile" ? "to swap" : "to replace session") : `to split ${preview.zone}`} on tile ${String(geometry.tiles.findIndex(({ tile }) => tile.id === preview.tile) + 1)}. Escape cancels.`
            : "Drag to a tile center to replace or swap, or an edge to split. Escape cancels."
          : ""}
      </span>
      {drag && preview && (
        <div
          className="tile-drop-preview"
          data-zone={preview.zone}
          style={position(
            (() => {
              const rect = geometry.tiles.find(({ tile }) => tile.id === preview.tile)?.rect ?? {
                x: 0,
                y: 0,
                width: 0,
                height: 0,
              };
              const area = layout.maximized ? { x: 0, y: 0, width: 100, height: 100 } : rect;
              return {
                x: area.x + (preview.zone === "right" ? area.width / 2 : 0),
                y: area.y + (preview.zone === "down" ? area.height / 2 : 0),
                width: area.width / (preview.zone === "left" || preview.zone === "right" ? 2 : 1),
                height: area.height / (preview.zone === "up" || preview.zone === "down" ? 2 : 1),
              };
            })(),
          )}
        >
          {preview.zone === "center"
            ? drag.kind === "tile"
              ? "Swap tiles"
              : "Replace session"
            : `Split ${preview.zone}`}
        </div>
      )}
      {geometry.tiles.map(({ tile, rect }) => (
        <Tile
          key={tile.id}
          tile={tile}
          rect={rect}
          number={terminals(layout.tree).findIndex((item) => item.id === tile.id) + 1}
          layout={layout}
          collapsing={geometry.gutters.some(({ split }) => {
            const [min, max] = ratioLimits(split);
            return (
              (min === 0 &&
                split.ratio < 0.08 &&
                leaves(split.first).some((item) => item.id === tile.id)) ||
              (max === 1 &&
                split.ratio > 0.92 &&
                leaves(split.second).some((item) => item.id === tile.id))
            );
          })}
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
            change={(id, ratio, commit) => {
              const next = resizeSplit(layout, id, ratio, commit);
              if (leaves(next.tree).length < leaves(layout.tree).length) dropLayout(next);
              else setLayout(next);
            }}
          />
        ))}
    </div>
  );
}
