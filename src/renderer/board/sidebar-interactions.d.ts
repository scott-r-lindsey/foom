import type { HTMLAttributes } from "react";

/** Parent-owned panel intent handlers shared by sidebar row presentations. */
export type SidebarRowEvents = {
  [Key in "onPointerEnter" | "onPointerLeave" | "onContextMenu" | "onKeyDownCapture"]: NonNullable<
    HTMLAttributes<HTMLElement>[Key]
  >;
};
