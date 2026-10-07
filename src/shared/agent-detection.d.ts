/** Local terminal metadata only; never included in a model request. */
export interface AgentEvidence {
  title: string;
  progress: { state: number; value: number | null } | null;
}
