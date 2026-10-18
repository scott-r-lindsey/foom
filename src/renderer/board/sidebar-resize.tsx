import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

export const SIDEBAR_DEFAULT_WIDTH = 300;
export const SIDEBAR_MIN_WIDTH = 240;
export function sidebarMaxWidth(windowWidth: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.floor(windowWidth * 0.4));
}
export function clampSidebarWidth(width: number, windowWidth: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(width, sidebarMaxWidth(windowWidth)));
}

export function SidebarResize({
  sidebarRef,
  width = SIDEBAR_DEFAULT_WIDTH,
  save,
  enabled,
  onDrag,
}: {
  sidebarRef: RefObject<HTMLElement | null>;
  width?: number | undefined;
  save: ((width: number) => void) | undefined;
  enabled: boolean;
  onDrag: (active: boolean) => void;
}) {
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  const [draft, setDraft] = useState<number>();
  const dragRef = useRef<
    { pointer: number; x: number; initial: number; width: number } | undefined
  >(undefined);
  const onDragRef = useRef(onDrag);
  useLayoutEffect(() => {
    onDragRef.current = onDrag;
  }, [onDrag]);
  const displayed = clampSidebarWidth(draft ?? width, windowWidth);
  useEffect(() => {
    const resize = () => {
      setWindowWidth(window.innerWidth);
    };
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
    };
  }, []);
  useLayoutEffect(() => {
    sidebarRef.current?.style.setProperty("--sidebar-width", `${String(displayed)}px`);
  }, [sidebarRef, displayed]);
  useEffect(() => {
    const element = sidebarRef.current;
    return () => {
      if (dragRef.current) onDragRef.current(false);
      element?.removeAttribute("data-resizing");
      element?.dispatchEvent(new Event("sidebar-resize-end", { bubbles: true }));
    };
  }, [sidebarRef]);
  const finish = () => {
    const active = dragRef.current;
    if (!active) return;
    dragRef.current = undefined;
    save?.(active.width);
    setDraft(undefined);
    sidebarRef.current?.removeAttribute("data-resizing");
    onDrag(false);
    sidebarRef.current?.dispatchEvent(new Event("sidebar-resize-end", { bubbles: true }));
  };
  if (!enabled) return null;
  return (
    <div
      className="sidebar-resize"
      role="separator"
      tabIndex={0}
      aria-label="Sidebar width"
      aria-orientation="vertical"
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={sidebarMaxWidth(windowWidth)}
      aria-valuenow={displayed}
      onDoubleClick={() => save?.(SIDEBAR_DEFAULT_WIDTH)}
      onKeyDown={(event) => {
        const next = {
          ArrowLeft: displayed - 10,
          ArrowRight: displayed + 10,
          Home: SIDEBAR_MIN_WIDTH,
          End: sidebarMaxWidth(windowWidth),
        }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        save?.(clampSidebarWidth(next, windowWidth));
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || dragRef.current) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = {
          pointer: event.pointerId,
          x: event.clientX,
          initial: displayed,
          width: displayed,
        };
        sidebarRef.current?.setAttribute("data-resizing", "true");
        onDrag(true);
      }}
      onPointerMove={(event) => {
        const active = dragRef.current;
        if (!active || active.pointer !== event.pointerId) return;
        active.width = clampSidebarWidth(
          active.initial + event.clientX - active.x,
          window.innerWidth,
        );
        setDraft(active.width);
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
    />
  );
}
