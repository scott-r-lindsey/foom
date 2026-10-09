export interface ShellView {
  status: string;
  cols?: number;
  rows?: number;
  state: "quiet_ok" | "done" | "failed";
  toggleLabel: string;
  visible: boolean;
  toggleDisabled: boolean;
  restartDisabled: boolean;
}
