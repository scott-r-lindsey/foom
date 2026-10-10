import { AgentBadge } from "./agent-badge";
import { CommandGlyph, PanelMark } from "./panel-glyphs";
import type { CommandGlyphName } from "./panel-glyphs";
import { useConfirmation } from "./use-confirmation";
import type { ConfirmationClient } from "../../shared/confirmation";
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, ReactNode } from "react";
export interface RowAction {
  label: string;
  disabled?: boolean;
  checked?: boolean | undefined;
  badge?: string;
  glyph?: CommandGlyphName;
  hint?: string;
  reason?: string;
  /** A nested menu, opened by hover, Right, Enter or click. */
  submenu?: readonly (RowAction | null)[];
  /** One stop holding a live value between two step buttons; stepping keeps the menu open. */
  stepper?: { value: string; decrease: RowAction; increase: RowAction };
  run: () => void | Promise<void>;
}
/** A submenu's link to the menu that opened it. */
interface Nested {
  /** Move focus into the submenu when it opens; hovering opens it without focus. */
  focus: boolean;
  /** Close the submenu and return focus to its item. */
  back: () => void;
  /** Close every level and return focus to the top anchor. */
  dismiss: () => void;
}
export interface PanelContent {
  title: ReactNode;
  kind: string;
  mark: string;
  facts: ReactNode;
  pinned: boolean;
  enter?: () => void;
  leave?: () => void;
  pin?: () => void;
}
/** A small stroke chevron; down rotates while its menu is open, right marks a submenu. */
export function Chevron({ direction }: { direction: "down" | "right" }) {
  return (
    <svg className="menu-chevron" viewBox="0 0 10 10" aria-hidden="true">
      <path d={direction === "down" ? "M2.5 4l2.5 2.5L7.5 4" : "M4 2.5l2.5 2.5L4 7.5"} />
    </svg>
  );
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
  point,
  keepOnResize = false,
  nested,
}: {
  /** Reposition rather than close when the window resizes, as interface size steps do. */
  keepOnResize?: boolean;
  nested?: Nested;
  point?: { x: number; y: number } | undefined;
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
  const isPanel = Boolean(panel);
  const isNested = Boolean(nested);
  const stepperId = useId();
  const focusOnOpen = nested ? nested.focus : !panel || panel.pinned;
  const [sub, setSub] = useState<{ index: number; anchor: HTMLButtonElement; focus: boolean }>();
  const confirmation = useConfirmation(confirmations);
  const [selected, setSelected] = useState<number>();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(
    () =>
      confirmations?.onDialog?.(() => {
        close();
        anchor.focus({ preventScroll: true });
      }),
    [confirmations, close, anchor],
  );
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const position = () => {
      const button = anchor.getBoundingClientRect();
      if (isNested) {
        // Beside its item, flipping left when the window has no room on the right.
        const width = menu.offsetWidth;
        const left =
          button.right + 10 + width > window.innerWidth - 8
            ? button.left - width - 10
            : button.right + 10;
        menu.style.left = `${String(Math.max(8, left))}px`;
        menu.style.top = `${String(Math.max(8, Math.min(button.top - 7, window.innerHeight - menu.offsetHeight - 8)))}px`;
        return;
      }
      const right = isPanel
        ? (anchor.closest(".sidebar-shell")?.getBoundingClientRect().right ?? button.right)
        : button.right;
      if (isPanel)
        menu.style.width = `${String(Math.min(720, Math.max(280, placement === "below" ? window.innerWidth - 16 : window.innerWidth - right - 18)))}px`;
      if (placement === "below")
        menu.style.maxHeight = `${String(Math.max(80, window.innerHeight - button.bottom - 16))}px`;
      // Opening animations transform the border box; placement needs its final
      // layout size or the expanded menu can extend beyond the window edge.
      const bounds = { width: menu.offsetWidth, height: menu.offsetHeight };
      const top = Math.max(
        8,
        Math.min(
          point ? point.y : placement === "below" ? button.bottom + 8 : button.top,
          window.innerHeight - bounds.height - 8,
        ),
      );
      menu.style.top = `${String(top)}px`;
      menu.style.left = `${String(Math.max(8, Math.min(point ? point.x : placement === "below" ? button.left : right + 10, window.innerWidth - bounds.width - 8)))}px`;
      menu.style.setProperty(
        "--notch",
        `${String(Math.max(12, Math.min(bounds.height - 12, button.top + button.height / 2 - top)))}px`,
      );
    };
    position();
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(position);
    observer?.observe(menu);
    if (keepOnResize) window.addEventListener("resize", position);
    if (focusOnOpen)
      menu.querySelector<HTMLButtonElement>(".row-menu-items button:not(:disabled)")?.focus();
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", position);
    };
  }, [anchor, placement, focusOnOpen, isPanel, point, keepOnResize, isNested]);
  useEffect(() => {
    // The top-level menu owns dismissal for its submenu.
    if (isNested) return;
    const inSubmenu = (target: EventTarget | null) =>
      target instanceof Element && Boolean(target.closest(".row-submenu"));
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !ref.current?.contains(event.target) &&
        !inSubmenu(event.target) &&
        !anchor.contains(event.target) &&
        !(isPanel && anchor.closest(".tree-row, .board-row")?.contains(event.target))
      )
        close();
    };
    const scroll = (event: Event) => {
      if (
        !(event.target instanceof Node) ||
        (!ref.current?.contains(event.target) && !inSubmenu(event.target))
      )
        close();
    };
    const escape = (event: KeyboardEvent) => {
      if (
        isPanel &&
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !(event.target instanceof HTMLInputElement && ref.current?.contains(event.target))
      ) {
        event.preventDefault();
        close();
      } else if (
        !isPanel &&
        event.key === "Escape" &&
        !event.defaultPrevented &&
        (document.activeElement === null || document.activeElement === document.body)
      ) {
        // Pressing a disabled item leaves focus on the body, outside the menu's handler.
        event.preventDefault();
        close();
        anchor.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("scroll", scroll, true);
    if (!keepOnResize) window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("keydown", escape);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", close);
    };
  }, [anchor, close, isPanel, keepOnResize, isNested]);
  const openSub = (index: number, item: HTMLButtonElement, focus: boolean) => {
    setSub((current) =>
      current?.index === index && (current.focus || !focus)
        ? current
        : { index, anchor: item, focus },
    );
  };
  const submenu = sub && actions[sub.index]?.submenu;
  return createPortal(
    <div
      ref={ref}
      className={`row-menu${placement === "below" ? " app-menu" : ""}${panel ? " sidebar-panel" : ""}${nested ? " row-submenu" : ""}`}
      role={panel ? "dialog" : "menu"}
      data-pinned={panel?.pinned}
      onPointerEnter={panel?.enter}
      onPointerLeave={panel?.leave}
      onPointerDown={panel?.pin}
      aria-label={label}
      onKeyDown={(event) => {
        const items = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            ".row-menu-items button:not(:disabled)",
          ),
        );
        // Keys from a submenu portal bubble through React; that menu handles its own.
        if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
        if (event.target instanceof HTMLInputElement) return;
        const active = document.activeElement;
        // A stepper is one stop: Up and Down skip its second button.
        const stops = items.filter((item) => !item.dataset["secondary"]);
        const stop =
          active instanceof HTMLElement && active.dataset["secondary"]
            ? active.parentElement?.querySelector("button")
            : active;
        const index = stops.findIndex((item) => item === stop);
        if (nested && (event.key === "Escape" || event.key === "ArrowLeft")) {
          event.preventDefault();
          event.stopPropagation();
          nested.back();
        } else if (nested && event.key === "Tab") {
          event.stopPropagation();
          nested.dismiss();
        } else if (event.key === "Escape" || (event.key === "Tab" && !panel)) {
          if (event.key === "Escape") event.preventDefault();
          event.stopPropagation();
          close();
          anchor.focus({ preventScroll: true });
        } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? stops.length - 1
                : (index + (event.key === "ArrowDown" ? 1 : stops.length - 1)) % stops.length;
          stops[next]?.focus();
        } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
          const stepper = active instanceof HTMLElement ? active.closest(".menu-stepper") : null;
          const steps = stepper ? Array.from(stepper.querySelectorAll("button")) : [];
          if (steps.length) {
            event.preventDefault();
            steps[event.key === "ArrowRight" ? steps.length - 1 : 0]?.focus();
          } else if (
            event.key === "ArrowRight" &&
            active instanceof HTMLButtonElement &&
            active.getAttribute("aria-haspopup") === "menu"
          ) {
            event.preventDefault();
            active.click();
          }
        }
      }}
    >
      {panel && (
        <header className="panel-header">
          <PanelMark mark={panel.mark} />
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
            action?.stepper ? (
              <div
                key={action.label}
                className="menu-stepper"
                role="group"
                aria-labelledby={`${stepperId}-${String(index)}-label ${stepperId}-${String(index)}-value`}
                style={{ "--item": index } as CSSProperties}
                onPointerEnter={() => {
                  setSub(undefined);
                }}
              >
                <span className="menu-label" id={`${stepperId}-${String(index)}-label`}>
                  {action.label}
                </span>
                {[action.stepper.decrease, action.stepper.increase].map((step, side) => (
                  <Fragment key={step.label}>
                    {side === 1 && (
                      // Named by the group; a live region is not a permitted menu child.
                      <span className="menu-step-value" id={`${stepperId}-${String(index)}-value`}>
                        {action.stepper?.value}
                      </span>
                    )}
                    <button
                      type="button"
                      role="menuitem"
                      aria-label={step.label}
                      title={step.hint ? `${step.label} (${step.hint})` : step.label}
                      data-secondary={side === 1 || undefined}
                      onClick={() => {
                        void step.run();
                      }}
                    >
                      {side === 0 ? "−" : "+"}
                    </button>
                  </Fragment>
                ))}
              </div>
            ) : action ? (
              <button
                key={action.label}
                type="button"
                role={action.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                aria-checked={action.checked}
                aria-haspopup={action.submenu ? "menu" : undefined}
                aria-expanded={action.submenu ? sub?.index === index : undefined}
                data-open={(action.submenu && sub?.index === index) || undefined}
                disabled={action.disabled}
                style={{ "--item": index } as CSSProperties}
                data-armed={(selected === index && Boolean(confirmation.arm)) || undefined}
                onPointerLeave={confirmation.cancel}
                onBlur={confirmation.cancel}
                onPointerEnter={(event) => {
                  if (action.submenu) openSub(index, event.currentTarget, false);
                  else if (!action.disabled) setSub(undefined);
                }}
                onClick={(event) => {
                  if (action.submenu) {
                    openSub(index, event.currentTarget, true);
                    return;
                  }
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
                    anchor.focus({ preventScroll: true });
                  });
                }}
              >
                {panel && !action.badge && <CommandGlyph name={action.glyph} />}
                {action.badge && <AgentBadge mark={action.badge} />}
                <span className="menu-label">
                  {selected === index && confirmation.arm ? confirmation.arm.label : action.label}
                  {action.reason && <small className="command-reason">{action.reason}</small>}
                </span>
                {action.hint && <span className="menu-hint">{action.hint}</span>}
                {action.submenu && <Chevron direction="right" />}
              </button>
            ) : (
              <hr key={`separator-${String(index)}`} />
            ),
          )}
        </div>
        {panel?.facts}
      </div>
      {sub && submenu && (
        <RowMenu
          anchor={sub.anchor}
          actions={submenu}
          close={close}
          label={actions[sub.index]?.label ?? label}
          {...(onAction ? { onAction } : {})}
          nested={{
            focus: sub.focus,
            back: () => {
              setSub(undefined);
              sub.anchor.focus({ preventScroll: true });
            },
            dismiss: () => {
              close();
              anchor.focus({ preventScroll: true });
            },
          }}
        />
      )}
    </div>,
    document.body,
  );
}
