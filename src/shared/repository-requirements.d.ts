export interface RepositoryRequirements {
  markdown: string;
  revision: string;
  agent: string;
  host: string;
  recordedAt: number;
  editedAt?: number;
}

export type RepositoryRequirementsAction =
  | { action: "read"; repository: string }
  | { action: "edit"; repository: string; revision: string; markdown: string }
  | { action: "clear"; repository: string; revision: string };

export interface RepositoryRequirementsApi {
  repositoryRequirements(
    action: RepositoryRequirementsAction,
  ): Promise<RepositoryRequirements | null>;
}

export interface RecordRepositoryRequirements {
  runId: string;
  repository: string;
  markdown: string;
}
