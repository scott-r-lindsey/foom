import { useConfirmation } from "./use-confirmation";
import type { ConfirmationClient } from "../../shared/confirmation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties } from "react";
export interface RowAction {
  label: string;
  badge?: string;
  run: () => void | Promise<void>;
}
/** A body portal escapes scrolling and stacking contexts; positioning remains viewport-relative. */
export function RowMenu({
  anchor,
  actions,
  close,
  confirmations,
}: {
  anchor: HTMLButtonElement;
  actions: readonly (RowAction | null)[];
  close: () => void;
  confirmations?: ConfirmationClient | undefined;
}) {
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
    const bounds = menu.getBoundingClientRect();
    const top = Math.max(8, Math.min(button.top, window.innerHeight - bounds.height - 8));
    menu.style.top = `${String(top)}px`;
    menu.style.left = `${String(Math.max(8, Math.min(button.right + 10, window.innerWidth - bounds.width - 8)))}px`;
    menu.style.setProperty(
      "--notch",
      `${String(Math.max(12, Math.min(bounds.height - 12, button.top + button.height / 2 - top)))}px`,
    );
    menu.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
  }, [anchor]);
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
      className="row-menu"
      role="menu"
      aria-label="Actions"
      onKeyDown={(event) => {
        const items = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]"),
        );
        const index = items.findIndex((item) => item === document.activeElement);
        if (event.key === "Escape" || event.key === "Tab") {
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
      <div className="row-menu-items">
        {actions.map((action, index) =>
          action ? (
            <button
              key={action.label}
              type="button"
              role="menuitem"
              style={{ "--item": index } as CSSProperties}
              data-armed={(selected === index && Boolean(confirmation.arm)) || undefined}
              onPointerLeave={confirmation.cancel}
              onBlur={confirmation.cancel}
              onClick={() => {
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
              {action.badge && (
                <span className="board-agent" aria-hidden="true">
                  {action.badge}
                </span>
              )}
              <span className="menu-label">
                {selected === index && confirmation.arm ? confirmation.arm.label : action.label}
              </span>
            </button>
          ) : (
            <hr key={`separator-${String(index)}`} />
          ),
        )}
      </div>
    </div>,
    document.body,
  );
}
