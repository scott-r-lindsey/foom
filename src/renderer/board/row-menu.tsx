import { restoreBoardFocus } from "./focus-restore";
import { registerErrorFocus } from "./error-presentation";
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
  /** Launches without a sharing warning dismiss before dispatching work. */
  dismissBeforeRun?: boolean;
  checked?: boolean | undefined;
  badge?: string;
  glyph?: CommandGlyphName;
  hint?: string;
  reason?: string;
  /** Shows something beside the item, opened by Right, Enter or click; the panel stays open. */
  expanded?: boolean;
  /** A nested menu, opened by hover, Right, Enter or click. */
  submenu?: MenuActions | (() => Promise<MenuActions>);
  /** One stop holding a live value between two step buttons; stepping keeps the menu open. */
  stepper?: { value: string; decrease: RowAction; increase: RowAction };
  run: () => void | Promise<void>;
}
type MenuActions = readonly (RowAction | null)[];

/** A submenu's link to the menu that opened it. */
interface Nested {
  parent: HTMLElement;
  inline: boolean;
  loading: boolean;
  /** Move focus into the submenu when it opens; hovering opens it without focus. */
  focus: boolean;
  /** Close the submenu and return focus to its item. */
  back: () => void;
  /** Close every level and return focus to the top anchor. */
  dismiss: () => void;
}

const submenuGap = 10;
const viewportMargin = 8;
const minSubmenuWidth = 120;
function sideSpace(parent: HTMLElement) {
  const { left, right } = parent.getBoundingClientRect();
  return {
    left,
    right,
    leftSpace: left - submenuGap - viewportMargin,
    rightSpace: window.innerWidth - right - submenuGap - viewportMargin,
  };
}

function unavailableAction(label: string): MenuActions {
  return [{ label, disabled: true, run: () => {} }];
}
const loadingActions = unavailableAction("Loading…");

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
/** A small stroke chevron; down rotates while its menu is open. */
export function Chevron({ direction }: { direction: "down" | "right" | "left" }) {
  return (
    <svg className="menu-chevron" viewBox="0 0 10 10" aria-hidden="true">
      <path
        d={
          direction === "down"
            ? "M2.5 4l2.5 2.5L7.5 4"
            : direction === "left"
              ? "M6 2.5l-2.5 2.5L6 7.5"
              : "M4 2.5l2.5 2.5L4 7.5"
        }
      />
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
  bottomAligned = false,
  leading,
  dismissOnAnchor = false,
  tabWithin = false,
  dismissOnScroll = true,
}: {
  /** Terminal menus remain anchored while xterm scrolls during focus changes or output. */
  dismissOnScroll?: boolean;
  /** Context menus on unfocusable regions also dismiss when that region is clicked. */
  dismissOnAnchor?: boolean;
  /** Keep native Tab navigation between controls inside a composite context menu. */
  tabWithin?: boolean;
  leading?: ReactNode;
  bottomAligned?: boolean;
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
  actions: MenuActions;
  close: () => void;
  confirmations?: ConfirmationClient | undefined;
}) {
  const isPanel = Boolean(panel);
  const isNested = Boolean(nested);
  const inline = Boolean(nested?.inline);
  const parent = nested?.parent;
  const loading = !inline && nested?.loading;
  const stepperId = useId();
  const focusOnOpen = nested ? nested.focus : !panel || panel.pinned;
  const [sub, setSub] = useState<{
    index: number;
    parent: HTMLElement;
    anchor: HTMLButtonElement;
    focus: boolean;
    inline: boolean;
    request?: { load: () => Promise<MenuActions> };
    loaded?: MenuActions;
  }>();
  const drillTrigger = sub?.inline ? sub.anchor : undefined;
  const confirmation = useConfirmation(confirmations);
  const [selected, setSelected] = useState<number>();
  const ref = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLButtonElement>(null);
  const pointerPinRef = useRef(false);
  const dismiss =
    nested?.dismiss ??
    (() => {
      close();
      restoreBoardFocus(anchor);
    });
  const request = sub?.request;
  useEffect(() => {
    if (!request) return;
    const complete = (loaded: MenuActions) => {
      setSub((current) => (current?.request === request ? { ...current, loaded } : current));
    };
    void request.load().then(complete, () => {
      complete(unavailableAction("Unable to load options"));
    });
  }, [request]);
  useLayoutEffect(() => {
    if (inline) return;
    const menu = ref.current;
    return () => {
      // Scroll, resize and programmatic closure can remove the focused item.
      // An outside click that already moved focus retains its chosen target.
      if (menu?.contains(document.activeElement)) restoreBoardFocus(anchor);
    };
  }, [anchor, inline]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element) return registerErrorFocus(element, anchor, close);
    return undefined;
  }, [anchor, close]);
  useEffect(
    () =>
      confirmations?.onDialog?.(() => {
        close();
        restoreBoardFocus(anchor);
      }),
    [confirmations, close, anchor],
  );
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu || inline) return;
    let panelTop: number | undefined;
    const position = () => {
      const button = anchor.getBoundingClientRect();
      if (parent) {
        const { left, right, leftSpace, rightSpace } = sideSpace(parent);
        const fits = Math.max(leftSpace, rightSpace) >= minSubmenuWidth;
        menu.style.visibility = fits ? "" : "hidden";
        if (!fits) return;
        menu.style.removeProperty("--submenu-max-width");
        const opensRight = menu.offsetWidth <= rightSpace || rightSpace >= leftSpace;
        const width = opensRight ? rightSpace : leftSpace;
        menu.style.setProperty("--submenu-max-width", `${String(width)}px`);
        const actualWidth = menu.getBoundingClientRect().width;
        menu.style.left = `${String(opensRight ? right + submenuGap : left - actualWidth - submenuGap)}px`;
        menu.style.top = `${String(Math.max(8, Math.min(button.top - 7, window.innerHeight - menu.offsetHeight - 8)))}px`;
        return;
      }
      const right = isPanel
        ? (anchor.closest(".sidebar-shell")?.getBoundingClientRect().right ?? button.right)
        : button.right;
      if (isPanel)
        menu.style.width = `${String(Math.min(720, Math.max(280, placement === "below" ? window.innerWidth - 16 : window.innerWidth - right - 18)))}px`;
      if (placement === "below")
        menu.style.maxHeight = `${String(Math.max(80, window.innerHeight - (point ? 0 : button.bottom) - 16))}px`;
      // Fit the layout box within the viewport, independent of decoration.
      const bounds = { width: menu.offsetWidth, height: menu.offsetHeight };
      const top =
        panelTop ??
        Math.max(
          8,
          Math.min(
            point
              ? point.y
              : bottomAligned
                ? button.bottom - bounds.height
                : placement === "below"
                  ? button.bottom + 8
                  : button.top,
            window.innerHeight - bounds.height - 8,
          ),
        );
      if (isPanel && !bottomAligned) {
        // Late facts may grow the panel. Keep commands under the pointer and
        // let the body scroll within the remaining viewport instead of moving up.
        panelTop = top;
        menu.style.maxHeight = `${String(window.innerHeight - top - 8)}px`;
      }
      menu.style.top = `${String(top)}px`;
      menu.style.left = `${String(Math.max(8, Math.min(point ? point.x : placement === "below" ? button.left : right + 10, window.innerWidth - bounds.width - 8)))}px`;
      menu.style.setProperty(
        "--notch",
        `${String(Math.max(12, Math.min(bounds.height - 12, button.top + button.height / 2 - top)))}px`,
      );
    };
    const resize = () => {
      panelTop = undefined;
      menu.style.removeProperty("max-height");
      position();
    };
    resize();
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(position);
    observer?.observe(menu);
    if (parent) observer?.observe(parent);
    if (keepOnResize) window.addEventListener("resize", resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [anchor, placement, isPanel, point, keepOnResize, parent, inline, bottomAligned]);
  useLayoutEffect(() => {
    // Pinning changes focus policy, not placement. Pointer pinning leaves focus
    // to the pressed launcher so it cannot scroll away before mouse-up.
    if (focusOnOpen && !pointerPinRef.current) {
      const menu = ref.current;
      const first = menu?.querySelector<HTMLButtonElement>(
        ".row-menu-items:not([hidden]) button:not(:disabled)",
      );
      (first ?? (isNested ? menu : null))?.focus();
    }
    pointerPinRef.current = false;
  }, [
    anchor,
    placement,
    focusOnOpen,
    isPanel,
    point,
    keepOnResize,
    isNested,
    bottomAligned,
    loading,
  ]);
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
        (dismissOnAnchor || !anchor.contains(event.target)) &&
        !(isPanel && anchor.closest(".tree-row, .board-row")?.contains(event.target))
      )
        close();
    };
    const scroll = (event: Event) => {
      if (!dismissOnScroll) return;
      if (isPanel && event.target instanceof Node && ref.current?.contains(event.target)) {
        // Panel scrolling moves submenu anchors; retain the panel, not stale portals.
        setSub((current) => (current?.inline ? current : undefined));
        return;
      }
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
        restoreBoardFocus(anchor);
      }
    };
    document.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("scroll", scroll, true);
    const resize = keepOnResize
      ? () => {
          const focused = document.activeElement;
          if (drillTrigger && focused?.closest(".row-drill-in") && ref.current?.contains(focused))
            returnFocusRef.current = drillTrigger;
          setSub(undefined);
        }
      : close;
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("keydown", escape);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", resize);
    };
  }, [
    anchor,
    close,
    isPanel,
    keepOnResize,
    isNested,
    bottomAligned,
    dismissOnAnchor,
    dismissOnScroll,
    drillTrigger,
  ]);
  useLayoutEffect(() => {
    if (!sub && returnFocusRef.current) {
      returnFocusRef.current.focus();
      returnFocusRef.current = null;
    }
  }, [sub]);
  const openSub = (
    index: number,
    item: HTMLButtonElement,
    focus: boolean,
    submenu: NonNullable<RowAction["submenu"]>,
  ) => {
    const parent = ref.current;
    if (!parent) return;
    const { leftSpace, rightSpace } = sideSpace(parent);
    const inline = Math.max(leftSpace, rightSpace) < minSubmenuWidth;
    // Swapping the body on hover would put a different row under the pointer
    // before the click arrives. Drill in only on activation.
    if (inline && !focus) return;
    setSub((current) =>
      current?.index === index
        ? focus && !current.focus
          ? { ...current, focus }
          : current
        : {
            index,
            parent,
            anchor: item,
            focus,
            inline,
            ...(typeof submenu === "function" ? { request: { load: submenu } } : {}),
          },
    );
  };
  const submenu = sub && actions[sub.index]?.submenu;
  const drillingIn = Boolean(sub?.inline && submenu);
  const child = sub && submenu && (
    <RowMenu
      key={sub.index}
      anchor={sub.anchor}
      actions={typeof submenu === "function" ? (sub.loaded ?? loadingActions) : submenu}
      confirmations={confirmations}
      close={close}
      label={actions[sub.index]?.label ?? label}
      {...(onAction ? { onAction } : {})}
      nested={{
        parent: sub.parent,
        inline: sub.inline,
        loading: typeof submenu === "function" && !sub.loaded,
        focus: sub.focus,
        back: () => {
          setSub(undefined);
          if (sub.inline) returnFocusRef.current = sub.anchor;
          else restoreBoardFocus(sub.anchor);
        },
        dismiss,
      }}
    />
  );
  const menu = (
    <div
      ref={ref}
      className={
        inline
          ? "row-drill-in"
          : `row-menu${placement === "below" ? " app-menu" : ""}${panel ? " sidebar-panel" : ""}${nested ? " row-submenu" : ""}`
      }
      role={panel ? "dialog" : drillingIn ? undefined : "menu"}
      tabIndex={nested ? -1 : undefined}
      data-pinned={panel?.pinned}
      onPointerEnter={panel?.enter}
      onPointerLeave={panel?.leave}
      onPointerDown={() => {
        if (panel?.pin && !panel.pinned) pointerPinRef.current = true;
        panel?.pin?.();
      }}
      aria-label={panel || !drillingIn ? label : undefined}
      onKeyDown={(event) => {
        // Submenu events bubble through React, including from portals.
        if (
          !(event.target instanceof Element) ||
          event.target.closest(".row-menu, .row-drill-in") !== event.currentTarget
        )
          return;
        if (event.target instanceof HTMLInputElement) return;
        const items = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            ".row-menu-items button:not(:disabled)",
          ),
        );
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
        } else if (
          event.key === "Tab" &&
          tabWithin &&
          items[items.findIndex((item) => item === active) + (event.shiftKey ? -1 : 1)]
        ) {
          event.stopPropagation();
        } else if (event.key === "Escape" || (event.key === "Tab" && !panel)) {
          if (event.key === "Escape") event.preventDefault();
          event.stopPropagation();
          close();
          restoreBoardFocus(anchor);
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
            (active.getAttribute("aria-haspopup") === "menu" || active.dataset["expands"])
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
      <div className={panel ? "panel-body" : undefined} data-drill-in={drillingIn || undefined}>
        <div
          className="row-menu-items"
          hidden={drillingIn}
          role={panel ? "menu" : undefined}
          aria-label={panel ? "Commands" : undefined}
        >
          {inline && (
            <button type="button" role="menuitem" className="menu-back" onClick={nested?.back}>
              <Chevron direction="left" />
              <span className="menu-label">Back</span>
            </button>
          )}
          {leading}
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
                aria-expanded={action.submenu ? sub?.index === index : action.expanded}
                data-expands={action.expanded === undefined ? undefined : true}
                data-open={(action.submenu && sub?.index === index) || undefined}
                disabled={action.disabled}
                style={{ "--item": index } as CSSProperties}
                data-armed={(selected === index && Boolean(confirmation.arm)) || undefined}
                onPointerLeave={confirmation.cancel}
                onBlur={confirmation.cancel}
                onPointerEnter={(event) => {
                  if (action.submenu) openSub(index, event.currentTarget, false, action.submenu);
                  else if (!action.disabled) setSub(undefined);
                }}
                onClick={(event) => {
                  if (action.submenu) {
                    openSub(index, event.currentTarget, true, action.submenu);
                    return;
                  }
                  if (onAction) {
                    onAction(action);
                    return;
                  }
                  if (action.expanded !== undefined) {
                    setSub(undefined);
                    nested?.back();
                    void action.run();
                    return;
                  }
                  if (confirmation.pending && selected !== index) {
                    confirmation.cancel();
                    return;
                  }
                  if (action.dismissBeforeRun) {
                    dismiss();
                    void action.run();
                    return;
                  }
                  setSelected(index);
                  void confirmation.run(action.run, dismiss);
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
        {drillingIn ? child : panel?.facts}
      </div>
      {!drillingIn && child}
    </div>
  );
  return inline ? menu : createPortal(menu, document.body);
}
