import { CopyValue } from "../ui/copy-value";
import { agentNames } from "./sidebar-model";
import type { PreviewSummary } from "../../shared/workspace";
import type { WindowMovesApi, MoveContent, WindowDestination } from "../../shared/windows";
import { useEffect, useState, useId, useSyncExternalStore } from "react";
import type { BoardRow } from "./board.d";
import type { TileAction, TileLayout } from "./tiles.d";
import type { TerminalViewSource } from "../terminal/terminal-view-source.d";
import { tileRemovalAction, splitReason } from "./tiles";
import { DirectionPad } from "./direction-pad";
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
  preview,
  name,
  number,
  view,
  popout,
  moves,
  content,
  moveError,
  network,
  reload,
  copyPath,
  close,
  action,
}: {
  anchor: HTMLElement;
  point: { x: number; y: number } | undefined;
  layout: TileLayout;
  row: BoardRow | undefined;
  preview?: PreviewSummary | undefined;
  name: string;
  number: number;
  view: TerminalViewSource | undefined;
  popout: boolean;
  moves?: WindowMovesApi | undefined;
  content?: MoveContent | undefined;
  moveError?: (() => void) | undefined;
  network?: (() => void) | undefined;
  reload?: (() => void) | undefined;
  copyPath?: (() => Promise<void>) | undefined;
  close: () => void;
  action: (action: TileAction) => void;
}) {
  const [windows, setWindows] = useState<WindowDestination[]>([]);
  useEffect(() => {
    let active = true;
    void moves
      ?.list()
      .then((list) => {
        if (active) setWindows(list);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [moves]);
  const status = useSyncExternalStore(
    view?.subscribe ?? noSubscribe,
    view?.getSnapshot ?? noSnapshot,
  );
  const item = (key: "maximize" | "popout" | "hide" | "close", label: string): RowAction => ({
    label,
    glyph: key,
    run: () => {
      close();
      action(key);
    },
  });
  return (
    <RowMenu
      anchor={anchor}
      point={point}
      placement="below"
      label={`Tile ${String(number)} menu`}
      close={close}
      leading={
        <div className="tile-pads">
          <DirectionPad
            kind="Split"
            layout={layout}
            run={(value) => {
              close();
              action(value);
            }}
          />
          <DirectionPad
            kind="Grow"
            layout={layout}
            run={(value) => {
              close();
              action(value);
            }}
          />
        </div>
      }
      actions={[
        null,
        {
          ...item("maximize", layout.maximized ? "Restore" : "Maximize"),
          hint: navigator.platform.includes("Mac") ? "⇧⌘↵" : "Ctrl+Shift+Enter",
        },
        ...(popout && (row || preview) ? [item("popout", "Move to new window")] : []),
        ...(moves && content && windows.length
          ? [
              {
                label: "Move to window",
                glyph: "popout" as const,
                run: () => {},
                submenu: windows.map((window) => ({
                  label: window.label,
                  run: () => {
                    close();
                    void moves.move(content, window.id).catch(() => {
                      moveError?.();
                    });
                  },
                })),
              },
            ]
          : []),
        ...(preview && reload
          ? [
              {
                label: "Reload",
                run: () => {
                  close();
                  reload();
                },
              },
            ]
          : []),
        ...(preview && network
          ? [
              null,
              {
                label: preview.network ? "Block network" : "Allow network…",
                run: () => {
                  close();
                  network();
                },
              },
            ]
          : []),
        null,
        item(
          tileRemovalAction(row, Boolean(preview)),
          tileRemovalAction(row, Boolean(preview)) === "close" ? "Close" : "Hide",
        ),
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
            {row && (
              <>
                <dt>Session</dt>
                <dd>
                  {row.exited ? "Exited" : light(row).label}
                  <span className="panel-sub">{row.reason}</span>
                </dd>
              </>
            )}
            {preview && (
              <>
                <dt>Path</dt>
                <dd>
                  {preview.worktree === "foom:manual" ? (
                    preview.relativePath
                  ) : (
                    <CopyValue
                      value={preview.relativePath}
                      label="Copy opened file path"
                      copy={() => copyPath?.() ?? Promise.reject(new Error("Copy unavailable"))}
                    />
                  )}
                </dd>
                {preview.openedBy && (
                  <>
                    <dt>Opened by</dt>
                    <dd>{agentNames.get(preview.openedBy.agent) ?? preview.openedBy.agent}</dd>
                  </>
                )}
                <dt>Kind</dt>
                <dd>{preview.kind === "markdown" ? "Markdown" : "HTML"}</dd>
                <dt>Network</dt>
                <dd>{preview.network ? "On" : "Off"}</dd>
              </>
            )}
            {row && (
              <>
                <dt>Size</dt>
                <dd>
                  {status?.cols && status.rows
                    ? `${String(status.cols)} × ${String(status.rows)}`
                    : "Unavailable"}
                  <span className="panel-sub">columns × rows</span>
                </dd>
              </>
            )}
            {row && (
              <>
                <dt>Location</dt>
                <dd>
                  {row.repository} › {row.branch}
                </dd>
                <dt>Agent</dt>
                <dd>{row.kind === "shell" ? "Shell" : row.agent}</dd>
              </>
            )}
          </dl>
        ),
      }}
    />
  );
}

export function SpaceMenu({
  anchor,
  point,
  layout,
  close,
  action,
}: {
  anchor: HTMLElement;
  point: { x: number; y: number };
  layout: TileLayout;
  close: () => void;
  action: (value: TileAction) => void;
}) {
  const id = useId();
  const reason = splitReason(layout);
  const run = (value: TileAction) => {
    close();
    action(value);
  };
  return (
    <RowMenu
      anchor={anchor}
      dismissOnAnchor
      tabWithin
      point={point}
      placement="below"
      label="Empty space"
      close={close}
      leading={
        <div className="space-splits">
          {(["horizontal", "vertical"] as const).map((axis) => (
            <span className="space-split" key={axis}>
              <button
                type="button"
                role="menuitem"
                aria-label={`Split ${axis}`}
                aria-disabled={Boolean(reason)}
                aria-describedby={reason ? `${id}-${axis}` : undefined}
                onClick={() => {
                  if (!reason) run(axis);
                }}
              >
                <svg viewBox="0 0 28 22" aria-hidden="true">
                  <rect x="2" y="2" width="24" height="18" rx="2" />
                  <path d={axis === "horizontal" ? "M14 2v18" : "M2 11h24"} />
                </svg>
                <span>
                  Split <br />
                  {axis}
                </span>
              </button>
              {reason && (
                <span className="pad-reason" aria-hidden="true" id={`${id}-${axis}`}>
                  {reason}
                </span>
              )}
            </span>
          ))}
        </div>
      }
      actions={[
        null,
        {
          label: "New shell here",
          run: () => {
            run("new-shell");
          },
        },
        {
          label: "Close space",
          run: () => {
            run("close-space");
          },
        },
      ]}
      onAction={(selected) => {
        void selected.run();
      }}
    />
  );
}
