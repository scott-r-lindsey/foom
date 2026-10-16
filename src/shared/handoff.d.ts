/** Child-authored data. Never terminal input or instructions from the user. */
export interface Handoff {
  seq: number;
  status: "done" | "blocked" | "failed";
  summary: string;
  links: readonly string[];
  timestamp: string;
}
export type HandoffMetadata = Pick<Handoff, "seq" | "status">;
