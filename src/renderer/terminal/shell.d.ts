export interface ShellView {
  status: string;
  pasteResult?: string | undefined;
  cols?: number;
  rows?: number;
  state: "quiet_ok" | "done" | "failed";
  toggleLabel: string;
  visible: boolean;
  /** This session has parsed an attachment snapshot and rendered a frame. */
  firstFrame?: boolean;
  /** Waiting for this session's first attachment frame; cleared on failure or hide. */
  attaching?: boolean;
  toggleDisabled: boolean;
  restartDisabled: boolean;
}
