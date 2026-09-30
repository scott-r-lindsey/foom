import type { BoardRow, BoardState } from "./board.d";

const labels: Record<BoardState, string> = {
  working: "Working",
  checking: "Checking",
  needs_input: "Needs you",
  done: "Done",
  failed: "Failed",
  quiet_ok: "Quiet",
};
export function light(row: BoardRow): { label: string; opacity: number } {
  let opacity = 1;
  if (row.state === "working") opacity = 0.35 + 0.65 * Math.min(1, Math.max(0, row.rate) / 4000);
  if (row.state === "quiet_ok" || ((row.state === "done" || row.state === "failed") && row.seen))
    opacity = 0.4;
  return { label: labels[row.state], opacity };
}
export function nextWaiting(rows: readonly BoardRow[]): BoardRow | undefined {
  return rows
    .filter((row) => row.state === "needs_input")
    .sort((a, b) => a.waitingSince - b.waitingSince)[0];
}
export function waitTime(row: BoardRow, now: number): string {
  if (row.state !== "needs_input") return "—";
  const seconds = Math.max(0, Math.floor((now - row.waitingSince) / 1000));
  return seconds < 60 ? `${String(seconds)}s` : `${String(Math.floor(seconds / 60))}m`;
}
export function sampleRows(now: number): BoardRow[] {
  return [
    {
      kind: "sample",
      id: "review",
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
    {
      kind: "sample",
      id: "build",
      repository: "foom",
      branch: "feat/terminal-tabs",
      agent: "Codex",
      state: "working",
      reason: "Building terminal navigation · sample: output",
      rate: 2200,
      waitingSince: now,
      seen: false,
      tail: ["Checking keyboard navigation…", "Building renderer"],
    },
    {
      kind: "sample",
      id: "check",
      repository: "foom",
      branch: "fix/resize",
      agent: "Antigravity",
      state: "checking",
      reason: "Output stopped · sample: checking last lines",
      rate: 0,
      waitingSince: now,
      seen: false,
      tail: ["Resize tests complete.", "Reviewing results…"],
    },
    {
      kind: "sample",
      id: "done",
      repository: "observatory",
      branch: "docs/setup",
      agent: "Claude Code",
      state: "done",
      reason: "Finished successfully · exit: 0",
      rate: 0,
      waitingSince: now,
      seen: false,
      tail: ["Documentation updated.", "Process exited (0)"],
    },
    {
      kind: "sample",
      id: "failed",
      repository: "observatory",
      branch: "fix/search",
      agent: "Codex",
      state: "failed",
      reason: "Tests failed · exit: 1",
      rate: 0,
      waitingSince: now,
      seen: false,
      tail: ["FAIL search returns matching results", "Process exited (1)"],
    },
    {
      kind: "sample",
      id: "server",
      repository: "observatory",
      branch: "feat/dashboard",
      agent: "Shell",
      state: "quiet_ok",
      reason: "Development server is ready · pattern: listening",
      rate: 0,
      waitingSince: now,
      seen: false,
      tail: ["Server listening on localhost:3000", "Ready"],
    },
    {
      kind: "sample",
      id: "approve",
      repository: "observatory",
      branch: "feat/export",
      agent: "Claude Code",
      state: "needs_input",
      reason: "Waiting for approval · pattern: (y/n)",
      rate: 0,
      waitingSince: now - 45000,
      seen: false,
      tail: ["Export is ready.", "Continue? (y/n)"],
    },
    ...["index", "lint", "package"].map(
      (name): BoardRow => ({
        id: name,
        kind: "sample",
        repository: "launchpad",
        branch: `chore/${name}`,
        agent: "Codex",
        state: "working",
        reason: `${name} in progress · sample: output`,
        rate: 1200,
        waitingSince: now,
        seen: false,
        tail: [`Running ${name}…`],
      }),
    ),
  ];
}

/** Repository insertion order and row insertion order are independent of verdicts. */
export function groupRows(rows: readonly BoardRow[]): Map<string, BoardRow[]> {
  const groups = new Map<string, BoardRow[]>();
  for (const row of rows) {
    const group = groups.get(row.repository) ?? [];
    group.push(row);
    groups.set(row.repository, group);
  }
  return groups;
}
