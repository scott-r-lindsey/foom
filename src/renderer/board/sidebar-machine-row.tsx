import { useState } from "react";
import type { ReactNode } from "react";
import type { SidebarCommand, SidebarMachine } from "../../shared/workspace";
import { RowMenu } from "./row-menu";

/** Machine identity is main-owned; this component holds only the open menu. */
export function SidebarMachineRow({
  machine,
  children,
  compact,
  command,
}: {
  machine: SidebarMachine;
  children: ReactNode;
  compact: boolean;
  command: (command: SidebarCommand) => Promise<void>;
}) {
  const [menu, setMenu] = useState<{
    available: boolean;
    compact: boolean;
    anchor: HTMLElement | undefined;
  }>({ available: machine.available, compact, anchor: undefined });
  const current = menu.available === machine.available && menu.compact === compact;
  if (!current) setMenu({ available: machine.available, compact, anchor: undefined });
  const anchor = current ? menu.anchor : undefined;
  const setAnchor = (anchor: HTMLElement | undefined) => {
    setMenu({ available: machine.available, compact, anchor });
  };
  const label = `${machine.name}${machine.available ? "" : " · Unavailable"}`;
  return (
    <div role="treeitem" aria-label={label} aria-expanded="true" className="machine-section">
      {!compact && (
        <div className="tree-row machine-row" data-unavailable={!machine.available}>
          <button
            type="button"
            className="tree-name"
            data-nav
            aria-disabled={!machine.available}
            aria-label={label}
            aria-haspopup="menu"
            aria-expanded={Boolean(anchor) && machine.available && !compact}
            onClick={(event) => {
              if (machine.available) setAnchor(anchor ? undefined : event.currentTarget);
            }}
          >
            <span className="tree-label">{machine.name}</span>
          </button>
          {!machine.available && <span className="tree-count">⊘ Unavailable</span>}
          <button
            type="button"
            className="row-actions"
            disabled={!machine.available}
            aria-label={`Actions for ${machine.name}`}
            aria-haspopup="menu"
            aria-expanded={Boolean(anchor) && machine.available && !compact}
            onClick={(event) => {
              setAnchor(anchor ? undefined : event.currentTarget);
            }}
          >
            ⋯
          </button>
        </div>
      )}
      <div role="group" className="machine-sessions">
        {children}
      </div>
      {anchor && machine.available && !compact && (
        <RowMenu
          anchor={anchor}
          label={`Actions for ${machine.name}`}
          onAction={(action) => {
            setAnchor(undefined);
            void action.run();
          }}
          actions={[
            {
              label: "New shell",
              run: () => command({ kind: "machine-launch", host: machine.host, run: "shell" }),
            },
            ...machine.agents.map((agent) => ({
              label: `New ${agent.name}`,
              run: () => command({ kind: "machine-launch", host: machine.host, run: agent.id }),
            })),
          ]}
          close={() => {
            setAnchor(undefined);
          }}
        />
      )}
    </div>
  );
}

export function HostChip({ machine }: { machine: Pick<SidebarMachine, "name" | "available"> }) {
  return (
    <span
      className="host-chip"
      title={machine.name}
      role="img"
      aria-label={machine.available ? `Host: ${machine.name}` : `${machine.name} · Unavailable`}
    >
      {machine.available ? machine.name : "⊘ Unavailable"}
    </span>
  );
}
