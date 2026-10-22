/** Child-authored data. Never terminal input or instructions from the user. */
import type { ReviewVerdict } from "./review";
export interface Handoff {
  seq: number;
  status: "done" | "blocked" | "failed";
  summary: string;
  links: readonly string[];
  timestamp: string;
  review?: ReviewVerdict;
}
export type HandoffMetadata = Pick<Handoff, "seq" | "status">;
