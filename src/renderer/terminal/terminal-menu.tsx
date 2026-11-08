import { DirectionPad } from "../board/direction-pad";
import { RowMenu } from "../board/row-menu";
import type { TileMetrics, TileAction, TileLayout } from "../board/tiles.d";
import type { TerminalContextMenu } from "./terminal-view-source.d";

export function TerminalMenu({
  menu,
  layout,
  metrics,
  close,
  action,
}: {
  menu: TerminalContextMenu;
  layout: TileLayout;
  metrics?: TileMetrics | undefined;
  close: () => void;
  action: (value: TileAction) => void;
}) {
  const run = (value: TileAction) => {
    close();
    action(value);
  };
  return (
    <RowMenu
      anchor={menu.anchor}
      point={menu.point}
      placement="below"
      label="Terminal menu"
      dismissOnScroll={false}
      dismissOnAnchor
      tabWithin
      close={close}
      leading={
        menu.link ? (
          <>
            {(["Copy link", "Open link"] as const).map((label) => (
              <button
                key={label}
                type="button"
                role="menuitem"
                title={menu.link?.url}
                onClick={() => {
                  close();
                  if (label === "Copy link") void menu.link?.copy().catch(() => {});
                  else menu.link?.open();
                }}
              >
                {label}
              </button>
            ))}
          </>
        ) : (
          <>
            {(["Copy", "Paste", "Select all", "Clear"] as const).map((label, index) => {
              const command = [menu.copy, menu.paste, menu.selectAll, menu.clear][index];
              return (
                <button
                  key={label}
                  type="button"
                  role="menuitem"
                  disabled={!command}
                  onClick={() => {
                    close();
                    void command?.();
                  }}
                >
                  {label}
                </button>
              );
            })}
            <hr />
            <div className="tile-pads">
              <DirectionPad kind="Split" layout={layout} metrics={metrics} run={run} />
              <DirectionPad kind="Grow" layout={layout} run={run} />
            </div>
          </>
        )
      }
      actions={[]}
    />
  );
}
