import { movingLight, agentOutputLevel, shellOutputLevel } from "./light-activity";
import type { BoardRow, BoardState } from "./board.d";

const labels: Record<BoardState, string> = {
  working: "Working",
  waiting: "Waiting",
  needs_input: "Needs you",
  done: "Done",
  failed: "Failed",
  quiet_ok: "Quiet",
};
export function light(row: BoardRow): { label: string; opacity: number } {
  let opacity = 1;
  if (movingLight(row))
    opacity =
      0.5 + 0.5 * (row.kind === "agent" ? agentOutputLevel(row.rate) : shellOutputLevel(row.rate));
  if (row.state === "quiet_ok" || ((row.state === "done" || row.state === "failed") && row.seen))
    opacity = 0.4;
  if (row.kind === "shell") opacity = 1;
  if (row.exited) opacity = 0.85;
  return {
    label: row.exited
      ? `Exited · ${row.kind === "shell" ? "Shell" : labels[row.state]}`
      : row.kind === "shell" && row.state !== "needs_input"
        ? "Running"
        : row.state === "waiting"
          ? `Waiting on ${String(row.waitingOn ?? 0)}`
          : labels[row.state],
    opacity,
  };
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
