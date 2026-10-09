import { sampleRows } from "../../src/renderer/board/sample-rows";
import type { BoardRow } from "../../src/renderer/board/board.d";

/** Two waiting sessions exercise attention ordering independently of the demo data. */
export function boardRows(now: number): BoardRow[] {
  return [
    {
      kind: "sample",
      id: "permission",
      repository: "foom",
      branch: "fix/session-restore",
      agent: "Claude Code",
      state: "needs_input",
      reason: "Wants permission to run tests · hook: permission",
      rate: 0,
      waitingSince: now - 184000,
      seen: false,
      tail: ["Ready to verify session restore.", "Run npm test? (y/n)"],
    },
    ...sampleRows(now),
  ];
}
