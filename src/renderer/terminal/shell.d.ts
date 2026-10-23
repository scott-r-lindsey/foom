export interface ShellView {
  status: string;
  cols?: number;
  rows?: number;
  state: "quiet_ok" | "done" | "failed";
  toggleLabel: string;
  visible: boolean;
  /** The current attachment has parsed its snapshot and rendered a frame. */
  firstFrame?: boolean;
  toggleDisabled: boolean;
  restartDisabled: boolean;
}
