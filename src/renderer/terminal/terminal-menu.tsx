import { DirectionPad } from "../board/direction-pad";
import { RowMenu } from "../board/row-menu";
import type { TileAction, TileLayout } from "../board/tiles.d";
import type { TerminalContextMenu } from "./terminal-view-source.d";

export function TerminalMenu({
  menu,
  layout,
  close,
  action,
}: {
  menu: TerminalContextMenu;
  layout: TileLayout;
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
            <DirectionPad kind="Split" layout={layout} run={run} />
            <DirectionPad kind="Grow" layout={layout} run={run} />
          </div>
        </>
      }
      actions={[]}
    />
  );
}
