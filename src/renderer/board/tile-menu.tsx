import { useSyncExternalStore } from "react";
import type { BoardRow } from "./board.d";
import type { TileAction, TileLayout } from "./tiles.d";
import type { TerminalViewSource } from "../terminal/terminal-view-source.d";
import { growTarget } from "./tiles";
import { light } from "./board";
import { RowMenu } from "./row-menu";
import type { RowAction } from "./row-menu";
const noSubscribe = () => () => {};
const noSnapshot = () => undefined;
export function TileMenu({
  anchor,
  point,
  layout,
  row,
  name,
  number,
  view,
  popout,
  close,
  action,
}: {
  anchor: HTMLElement;
  point: { x: number; y: number } | undefined;
  layout: TileLayout;
  row: BoardRow;
  name: string;
  number: number;
  view: TerminalViewSource | undefined;
  popout: boolean;
  close: () => void;
  action: (action: TileAction) => void;
}) {
  const status = useSyncExternalStore(
    view?.subscribe ?? noSubscribe,
    view?.getSnapshot ?? noSnapshot,
  );
  const item = (key: TileAction, label: string, reason?: string): RowAction => ({
    label,
    glyph: key,
    ...(reason ? { reason, disabled: true } : {}),
    run: () => {
      close();
      action(key);
    },
  });
  const gx = growTarget(layout, "horizontal"),
    gy = growTarget(layout, "vertical");
  return (
    <RowMenu
      anchor={anchor}
      point={point}
      placement="below"
      label={`Tile ${String(number)} menu`}
      close={close}
      actions={[
        item("right", "Split right"),
        item("down", "Split down"),
        item("growx", "Grow sideways", "reason" in gx ? gx.reason : undefined),
        item("growy", "Grow vertically", "reason" in gy ? gy.reason : undefined),
        null,
        {
          ...item("maximize", layout.maximized ? "Restore" : "Maximize"),
          hint: navigator.platform.includes("Mac") ? "⇧⌘↵" : "Ctrl+Shift+Enter",
        },
        ...(popout ? [item("popout", "Move to new window")] : []),
        null,
        item(row.exited ? "close" : "hide", row.exited ? "Close" : "Hide"),
      ]}
      onAction={(selected) => {
        void selected.run();
      }}
      panel={{
        title: name,
        kind: `Tile ${String(number)}`,
        mark: String(number),
        pinned: true,
        facts: (
          <dl className="panel-facts">
            <dt>Session</dt>
            <dd>
              {row.exited ? "Exited" : light(row).label}
              <span className="panel-sub">{row.reason}</span>
            </dd>
            <dt>Size</dt>
            <dd>
              {status?.cols && status.rows
                ? `${String(status.cols)} × ${String(status.rows)}`
                : "Unavailable"}
              <span className="panel-sub">columns × rows</span>
            </dd>
            <dt>Location</dt>
            <dd>
              {row.repository} › {row.branch}
            </dd>
            <dt>Agent</dt>
            <dd>{row.kind === "shell" ? "Shell" : row.agent}</dd>
          </dl>
        ),
      }}
    />
  );
}
