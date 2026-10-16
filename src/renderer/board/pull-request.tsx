import type { BoardPullRequest } from "../../shared/forge";

export function PullRequestMark({ pr, open }: { pr: BoardPullRequest; open: () => Promise<void> }) {
  const status =
    pr.state !== "OPEN"
      ? pr.state.toLowerCase()
      : !pr.checks
        ? "unknown"
        : pr.checks.pending > 0
          ? "running"
          : pr.checks.failed > 0
            ? "failed"
            : pr.checks.passed > 0
              ? "passed"
              : "no checks";
  const glyph = { running: "◷", failed: "■", passed: "✓", unknown: "?", "no checks": "−" };
  const mark =
    status === "running" ||
    status === "failed" ||
    status === "passed" ||
    status === "unknown" ||
    status === "no checks"
      ? glyph[status]
      : "";
  return (
    <button
      type="button"
      className="pull-request"
      data-status={status}
      title={`Pull request #${String(pr.number)} · ${status}`}
      aria-label={`Pull request #${String(pr.number)} · ${status}`}
      onClick={(event) => {
        event.stopPropagation();
        void open().catch(() => {});
      }}
    >
      #{pr.number} <span aria-hidden="true">{mark}</span>
    </button>
  );
}
