export type AgyPluginAction = "install" | "update" | "remove" | "enable";
export interface AgyPluginStatus {
  state: "not-installed" | "installed" | "outdated" | "disabled" | "unavailable";
  version?: number;
}
