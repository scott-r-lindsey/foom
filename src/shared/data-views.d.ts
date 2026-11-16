import type { SoundEntry } from "./sound";
import type { ReadinessReport } from "./readiness";
import type { SetupState } from "./setup";
import type { HostsState } from "./registered-hosts.d";
import type { AgentReport, WorkspaceTerminal } from "./workspace";
import type { Repository, Worktree } from "./worktrees";
import type { EnvironmentState } from "./environment";
import type { ConfigStatus } from "./foom-config";

export interface DataViews {
  settings: SetupState;
  hosts: HostsState;
  agents: AgentReport & { machine?: HostsState };
  repositories: readonly Repository[];
  worktrees: readonly Worktree[];
  sessions: readonly WorkspaceTerminal[];
  environment: EnvironmentState;
  config: ConfigStatus;
  fonts: readonly string[];
  sounds: readonly SoundEntry[];
  readiness: ReadinessReport;
}
export type DataView = keyof DataViews;
/** List pages are bounded; scalar views accept only an empty object. */
export interface ViewParams {
  offset?: number;
  limit?: number;
  repository?: string;
  machine?: string;
}
export interface ViewRequest {
  id: string;
  view: DataView;
  params: ViewParams;
}
export type ViewSnapshot<K extends DataView = DataView> = ViewRequest & {
  view: K;
  generation: number;
  revision: number;
  nextOffset?: number;
  viewRevision?: number;
} & ({ data: DataViews[K]; error?: never } | { error: "unavailable" | "too-large"; data?: never });
export interface DataViewApi {
  subscribeView<K extends DataView>(
    view: K,
    params: ViewParams,
    receive: (snapshot: ViewSnapshot<K>) => void,
  ): () => void;
}
