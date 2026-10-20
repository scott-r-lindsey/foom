import { useCallback, useEffect, useRef, useState } from "react";

import type { SidebarProps } from "./sidebar-view.d";
export function useSidebarLayout(
  { source, collapsed = false, setCollapsed, toggleRef, onCompact }: SidebarProps,
  closeMenu: () => void,
) {
  const [overlay, setOverlay] = useState(false);
  const [narrow, setNarrow] = useState(
    () => typeof matchMedia !== "undefined" && matchMedia("(max-width: 719px)").matches,
  );
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const media = matchMedia("(max-width: 719px)");
    const change = () => {
      setNarrow(media.matches);
      setOverlay(false);
    };
    media.addEventListener("change", change);
    return () => {
      media.removeEventListener("change", change);
    };
  }, []);
  const shellRef = useRef<HTMLElement>(null);
  const toggleButtonRef = useRef<HTMLButtonElement>(null);
  const compact = narrow ? !overlay : collapsed;
  const toggleSidebar = useCallback(() => {
    const active = document.activeElement;
    const moveFocus = active instanceof Node && shellRef.current?.contains(active);
    closeMenu();
    if (narrow) setOverlay((value) => !value);
    else setCollapsed?.(!collapsed);
    if (moveFocus) toggleButtonRef.current?.focus();
  }, [narrow, collapsed, setCollapsed, closeMenu]);
  useEffect(() => {
    if (toggleRef) toggleRef.current = toggleSidebar;
    return () => {
      if (toggleRef) toggleRef.current = undefined;
    };
  }, [toggleRef, toggleSidebar]);
  useEffect(() => {
    onCompact?.(compact);
  }, [onCompact, compact]);
  useEffect(() => {
    if (!narrow || !overlay) return;
    const outside = (event: MouseEvent) => {
      // Portaled panels and their submenus still belong to the sidebar.
      if (
        event.target instanceof Element &&
        event.target.closest(".sidebar-panel, .app-menu, .row-submenu")
      )
        return;
      if (event.target instanceof Node && !shellRef.current?.contains(event.target)) {
        closeMenu();
        setOverlay(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
        setOverlay(false);
        toggleButtonRef.current?.focus();
      }
    };
    document.addEventListener("click", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("click", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [narrow, overlay, closeMenu]);
  const toggleLabel = narrow
    ? overlay
      ? "Close sidebar"
      : "Open sidebar"
    : collapsed
      ? "Expand sidebar"
      : "Collapse sidebar";
  const shortcut = source.appMenu?.platform === "darwin" ? "⌘B" : "Ctrl+Shift+B";

  return {
    overlay,
    setOverlay,
    narrow,
    shellRef,
    toggleButtonRef,
    compact,
    toggleSidebar,
    toggleLabel,
    shortcut,
  };
}
