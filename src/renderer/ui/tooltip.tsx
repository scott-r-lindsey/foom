import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const GAP = 6;
const MARGIN = 8;

/**
 * Where the bubble goes, in viewport coordinates: below its trigger, or above when it
 * doesn't fit below, and shifted sideways to stay inside the window.
 */
export function placeBubble(
  trigger: Box,
  bubble: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const left = Math.max(MARGIN, Math.min(trigger.left, viewport.width - MARGIN - bubble.width));
  const below = trigger.bottom + GAP;
  const fitsBelow = below + bubble.height <= viewport.height - MARGIN;
  const above = trigger.top - GAP - bubble.height;
  const top = fitsBelow || above < MARGIN ? below : above;
  return { left, top };
}

/** Only one tooltip shows at a time: opening one closes the last. */
let closeOpen: (() => void) | undefined;

/**
 * A small tooltip on a focusable trigger. It opens on hover, keyboard focus or a tap,
 * stays open while the pointer is over it, and Esc closes it (WCAG 1.4.13). Screen
 * readers hear its text as the trigger's description.
 */
export function Tooltip({
  label,
  className,
  children,
}: {
  label: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  // Placed against the window, not the card, so it never runs off screen.
  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const bubble = bubbleRef.current;
    if (!open || !trigger || !bubble) return;
    const place = () => {
      const { left, top } = placeBubble(
        trigger.getBoundingClientRect(),
        { width: bubble.offsetWidth, height: bubble.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      );
      bubble.style.left = `${String(left)}px`;
      bubble.style.top = `${String(top)}px`;
    };
    place();
    // A scaled or animated ancestor can move the trigger without a window event.
    let frame = 0;
    const follow = () => {
      place();
      frame = requestAnimationFrame(follow);
    };
    frame = requestAnimationFrame(follow);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = () => {
      setOpen(false);
    };
    if (closeOpen !== close) closeOpen?.();
    closeOpen = close;
    return () => {
      if (closeOpen === close) closeOpen = undefined;
    };
  }, [open]);
  return (
    <span
      className="tip"
      onMouseEnter={() => {
        setOpen(true);
      }}
      onMouseLeave={() => {
        setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={className}
        aria-describedby={id}
        onFocus={() => {
          setOpen(true);
        }}
        onBlur={() => {
          setOpen(false);
        }}
        onClick={() => {
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          // Close only the tooltip, not whatever else listens for Esc.
          if (event.key === "Escape" && open) {
            event.stopPropagation();
            setOpen(false);
          }
        }}
      >
        {label}
      </button>
      {/* Viewport coordinates must not inherit the preflight's zoom or containment. */}
      {createPortal(
        <span ref={bubbleRef} role="tooltip" id={id} className="tip-bubble" hidden={!open}>
          {children}
        </span>,
        document.body,
      )}
    </span>
  );
}
