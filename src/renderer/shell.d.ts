export interface ShellView {
  status: string;
  state: "quiet_ok" | "done" | "failed";
  toggleLabel: string;
  visible: boolean;
  toggleDisabled: boolean;
  restartDisabled: boolean;
}
