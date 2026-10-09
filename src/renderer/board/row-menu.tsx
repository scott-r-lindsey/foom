import { AgentBadge } from "./agent-badge";
import { useConfirmation } from "./use-confirmation";
import type { ConfirmationClient } from "../../shared/confirmation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, ReactNode } from "react";
export interface RowAction {
  label: string;
  disabled?: boolean;
  checked?: boolean | undefined;
  badge?: string;
  glyph?: string;
  hint?: string;
  run: () => void | Promise<void>;
}
export interface PanelContent {
  title: ReactNode;
  kind: string;
  mark: string;
  facts: ReactNode;
  pinned: boolean;
  enter: () => void;
  leave: () => void;
  pin: () => void;
}
/** A body portal escapes scrolling and stacking contexts; positioning remains viewport-relative. */
export function RowMenu({
  anchor,
  actions,
  close,
  confirmations,
  placement = "right",
  label = "Actions",
  onAction,
  panel,
}: {
  panel?: PanelContent;
  /** Overrides confirmation handling; the caller owns dismissal, focus and dispatch. */
  onAction?: (action: RowAction) => void;
  placement?: "right" | "below";
  label?: string;
  anchor: HTMLElement;
  actions: readonly (RowAction | null)[];
  close: () => void;
  confirmations?: ConfirmationClient | undefined;
}) {
  const focusOnOpen = !panel || panel.pinned;
  const confirmation = useConfirmation(confirmations);
  const [selected, setSelected] = useState<number>();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(
    () =>
      confirmations?.onDialog?.(() => {
        close();
        anchor.focus();
      }),
    [confirmations, close, anchor],
  );
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const button = anchor.getBoundingClientRect();
    if (placement === "below")
      menu.style.maxHeight = `${String(Math.max(80, window.innerHeight - button.bottom - 16))}px`;
    // Opening animations transform the border box; placement needs its final
    // layout size or the expanded menu can extend beyond the window edge.
    const bounds = { width: menu.offsetWidth, height: menu.offsetHeight };
    const top = Math.max(
      8,
      Math.min(
        placement === "below" ? button.bottom + 8 : button.top,
        window.innerHeight - bounds.height - 8,
      ),
    );
    menu.style.top = `${String(top)}px`;
    menu.style.left = `${String(Math.max(8, Math.min(placement === "below" ? button.left : button.right + 10, window.innerWidth - bounds.width - 8)))}px`;
    menu.style.setProperty(
      "--notch",
      `${String(Math.max(12, Math.min(bounds.height - 12, button.top + button.height / 2 - top)))}px`,
    );
    if (focusOnOpen)
      menu.querySelector<HTMLButtonElement>(".row-menu-items button:not(:disabled)")?.focus();
  }, [anchor, placement, focusOnOpen]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !ref.current?.contains(event.target) &&
        !anchor.contains(event.target)
      )
        close();
    };
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node) || !ref.current?.contains(event.target)) close();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", close);
    };
  }, [anchor, close]);
  return createPortal(
    <div
      ref={ref}
      className={`row-menu${placement === "below" ? " app-menu" : ""}${panel ? " sidebar-panel" : ""}`}
      role={panel ? "dialog" : "menu"}
      data-pinned={panel?.pinned}
      onPointerEnter={panel?.enter}
      onPointerLeave={panel?.leave}
      onPointerDown={panel?.pin}
      aria-label={label}
      onKeyDown={(event) => {
        const items = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
        );
        const index = items.findIndex((item) => item === document.activeElement);
        if (event.target instanceof HTMLInputElement) return;
        if (event.key === "Escape" || (event.key === "Tab" && !panel)) {
          if (event.key === "Escape") event.preventDefault();
          event.stopPropagation();
          close();
          anchor.focus();
        } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? items.length - 1
                : (index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
          items[next]?.focus();
        }
      }}
    >
      {panel && (
        <header className="panel-header">
          <span className="panel-mark" aria-hidden="true">
            {panel.mark}
          </span>
          <div className="panel-title">{panel.title}</div>
          <span className="panel-kind">{panel.kind}</span>
        </header>
      )}
      <div className={panel ? "panel-body" : undefined}>
        <div
          className="row-menu-items"
          role={panel ? "menu" : undefined}
          aria-label={panel ? "Commands" : undefined}
        >
          {actions.map((action, index) =>
            action ? (
              <button
                key={action.label}
                type="button"
                role={action.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                aria-checked={action.checked}
                disabled={action.disabled}
                style={{ "--item": index } as CSSProperties}
                data-armed={(selected === index && Boolean(confirmation.arm)) || undefined}
                onPointerLeave={confirmation.cancel}
                onBlur={confirmation.cancel}
                onClick={() => {
                  if (onAction) {
                    onAction(action);
                    return;
                  }
                  if (confirmation.pending && selected !== index) {
                    confirmation.cancel();
                    return;
                  }
                  setSelected(index);
                  void confirmation.run(action.run, () => {
                    close();
                    anchor.focus();
                  });
                }}
              >
                {panel && !action.badge && (
                  <span className="command-glyph" aria-hidden="true">
                    {action.glyph ?? "·"}
                  </span>
                )}
                {action.badge && <AgentBadge mark={action.badge} />}
                <span className="menu-label">
                  {selected === index && confirmation.arm ? confirmation.arm.label : action.label}
                </span>
                {action.hint && <span className="menu-hint">{action.hint}</span>}
              </button>
            ) : (
              <hr key={`separator-${String(index)}`} />
            ),
          )}
        </div>
        {panel?.facts}
      </div>
    </div>,
    document.body,
  );
}
