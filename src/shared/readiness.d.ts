export type GitReadiness = "ready" | "not-installed" | "invalid-version" | "unavailable";
export type ForgeReadiness =
  | "ready"
  | "not-installed"
  | "not-signed-in"
  | "unavailable"
  | "unassigned";
export interface ReadinessReport {
  git: GitReadiness;
  platform: "macos" | "windows" | "linux";
  forges: readonly { host: string; status: ForgeReadiness }[];
}
