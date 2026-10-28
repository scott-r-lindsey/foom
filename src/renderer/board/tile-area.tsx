import { Tile, position } from "./terminal-tile";

import type { PreviewSummary } from "../../shared/workspace";

import { useState } from "react";
import type { DragEvent } from "react";
import type { BoardSource } from "./board-source.d";
import type { BoardRow } from "./board.d";
import type { SidebarPreferences } from "./sidebar.d";
import type { TileAction, TileDrag, DropZone, TileLayout, TileRect, TileSplit } from "./tiles.d";

import {
  rectangles,
  resizeSplit,
  evenSplitRun,
  dropTile,
  dropZone,
  terminals,
  ratioLimits,
  leaves,
  sessionId,
} from "./tiles";

function Gutter({
  node,
  rect,
  area,
  change,
  even,
}: {
  node: TileSplit;
  rect: TileRect;
  area: TileRect;
  change: (id: string, ratio: number, commit?: boolean) => void;
  even: () => void;
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
      onDoubleClick={even}
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
        if (event.key === "Enter") {
          event.preventDefault();
          even();
          return;
        }
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
  previews,
  arrivals,
  acknowledgePreview,
  preferences,
  inactive,
  focusRequest,
  restoreFocusRequest = 0,
  action,
}: {
  drag?: TileDrag | undefined;
  endDrag: () => void;
  dropLayout: (next: TileLayout) => void;
  source: BoardSource;
  layout: TileLayout;
  setLayout: (next: TileLayout) => void;
  rows: readonly BoardRow[];
  previews: readonly PreviewSummary[];
  arrivals: ReadonlySet<string>;
  acknowledgePreview: (id: string) => void;
  preferences: SidebarPreferences;
  inactive: boolean;
  focusRequest: number;
  restoreFocusRequest?: number;
  action: (tile: string, action: TileAction) => void;
}) {
  const [lastPreview, setLastPreview] = useState<{
    tile: string;
    zone: DropZone;
    drag: TileDrag;
  }>();
  const preview = lastPreview?.drag === drag ? lastPreview : undefined;
  const geometry = rectangles(layout.tree);
  const placing =
    preview && !geometry.tiles.find(({ tile }) => tile.id === preview.tile)?.tile.content;
  const targetAt = (event: DragEvent<HTMLDivElement>) => {
    if (
      !drag ||
      inactive ||
      !(event.target instanceof Element) ||
      (drag.kind === "session" &&
        !rows.some((row) => row.id === drag.id && !(row.dormant && row.exited)))
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
      role="group"
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
            ? `Drop ${preview.zone === "center" ? (placing ? "to place here" : drag.kind === "tile" ? "to swap" : "to replace session") : `to split ${preview.zone}`} on tile ${String(geometry.tiles.findIndex(({ tile }) => tile.id === preview.tile) + 1)}. Escape cancels.`
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
            ? placing
              ? "Place here"
              : drag.kind === "tile"
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
          rows={rows}
          arrived={tile.content?.kind === "preview" && arrivals.has(tile.content.preview)}
          acknowledgePreview={() => {
            if (tile.content?.kind === "preview" && arrivals.has(tile.content.preview))
              acknowledgePreview(tile.content.preview);
          }}
          row={rows.find((row) => row.id === sessionId(tile))}
          preview={previews.find(
            (preview) => tile.content?.kind === "preview" && preview.id === tile.content.preview,
          )}
          preferences={preferences}
          focused={layout.focused === tile.id}
          maximized={layout.maximized === tile.id}
          behind={layout.maximized !== null && layout.maximized !== tile.id}
          inactive={inactive}
          focusRequest={focusRequest}
          restoreFocusRequest={restoreFocusRequest}
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
            even={() => {
              setLayout(evenSplitRun(layout, split.id));
            }}
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
