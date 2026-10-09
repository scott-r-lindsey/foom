import type { BoardRow, BoardState } from "./board.d";

const labels: Record<BoardState, string> = {
  working: "Working",
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
export function groupRows(rows: readonly BoardRow[]): Map<string, BoardRow[]> {
  const groups = new Map<string, BoardRow[]>();
  for (const row of rows) {
    const group = groups.get(row.repository) ?? [];
    group.push(row);
    groups.set(row.repository, group);
  }
  return groups;
}
