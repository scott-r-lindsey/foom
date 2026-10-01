import { useEffect, useState } from "react";
import type { ProbeEvent, ProbeResult, ProbeUpdate } from "../shared/inference";

/** One Run check as the renderer sees it: live steps, the streamed reply, the result. */
export interface CheckRun {
  id: string;
  startedAt: number;
  limitMs: number;
  steps: readonly ProbeEvent[];
  thinking: number;
  reply: string;
  result?: ProbeResult;
  error?: string;
}

export function startRun(id: string, limitMs: number, now: number): CheckRun {
  return { id, startedAt: now, limitMs, steps: [], thinking: 0, reply: "" };
}

/** Each step keeps its first position; later events for it replace its line. */
export function applyUpdate(run: CheckRun, update: ProbeUpdate): CheckRun {
  if (update.kind === "stream") return { ...run, thinking: update.thinking, reply: update.reply };
  const index = run.steps.findIndex((event) => event.step === update.event.step);
  const steps =
    index === -1
      ? [...run.steps, update.event]
      : run.steps.map((event, position) => (position === index ? update.event : event));
  return { ...run, steps };
}

const ICON = { running: "●", ok: "✓", failed: "✗", skipped: "–" } as const;
const milliseconds = (value: number) =>
  value < 1000 ? `${String(value)} ms` : `${(value / 1000).toFixed(1)} s`;

/** The inline flight log under Run check. */
export function CheckPanel({ run, onCancel }: { run: CheckRun; onCancel: () => void }) {
  const running = !run.result && !run.error;
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      setNow(performance.now());
    }, 100);
    return () => {
      window.clearInterval(timer);
    };
  }, [running]);
  const elapsed = Math.min(Math.max(0, now - run.startedAt), run.limitMs);
  const latest = run.steps.at(-1);
  const result = run.result;
  const tone = run.error || (result && !result.ok) ? "error" : result ? "ok" : "running";
  return (
    <div className="check" data-tone={tone}>
      <ol className="check-steps" aria-label="Check steps">
        {run.steps.map((event) => (
          <li key={event.step} data-status={event.status}>
            <span className="check-icon" aria-hidden="true">
              {ICON[event.status]}
            </span>
            <span className="check-label">
              <span className="visually-hidden">{event.status}: </span>
              {event.label}
            </span>
            <span className="check-time">
              {event.durationMs !== undefined && milliseconds(event.durationMs)}
            </span>
          </li>
        ))}
      </ol>
      {(run.thinking > 0 || run.reply) && (
        <div className="check-stream">
          {run.thinking > 0 && (
            <p>
              Thinking: {run.thinking} {run.thinking === 1 ? "chunk" : "chunks"}
            </p>
          )}
          {run.reply && <pre aria-label="Reply so far">{run.reply}</pre>}
        </div>
      )}
      {running ? (
        <div className="check-progress">
          <div
            className="check-meter"
            role="progressbar"
            aria-label="Time limit"
            aria-valuemin={0}
            aria-valuemax={run.limitMs}
            aria-valuenow={Math.round(elapsed)}
            aria-valuetext={`${(elapsed / 1000).toFixed(1)} of ${(run.limitMs / 1000).toFixed(1)} seconds`}
          >
            <span style={{ width: `${String((elapsed / run.limitMs) * 100)}%` }} />
          </div>
          <span className="check-clock">
            {(elapsed / 1000).toFixed(1)}s of {(run.limitMs / 1000).toFixed(1)}s
          </span>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      ) : (
        <p className="check-result" role="status">
          {run.error ?? result?.message}
          {result?.ok && ". Foom will use this source."}
        </p>
      )}
      {result && (
        <>
          <p className="check-timings">
            {result.timings.connectMs !== undefined &&
              `Connect ${milliseconds(result.timings.connectMs)} · `}
            {result.timings.firstTokenMs !== undefined &&
              `First token ${milliseconds(result.timings.firstTokenMs)} · `}
            Total {milliseconds(result.timings.totalMs)}
          </p>
          <details className="check-details">
            <summary>Details</summary>
            <p>
              <b>Request</b> <code>POST {result.request.url}</code>
            </p>
            <pre>{JSON.stringify(result.request.parameters, null, 2)}</pre>
            <p>
              <b>Prompt</b> (the fixed sample; no terminal output is sent during a check)
            </p>
            <pre>{result.request.prompt}</pre>
            <p>
              <b>Reply</b>
              {result.thinking > 0 && ` after ${String(result.thinking)} thinking chunks`}
            </p>
            <pre>{result.reply || "(none)"}</pre>
          </details>
        </>
      )}
      {/* Screen readers hear each step change, not every tick or token. */}
      <p className="visually-hidden" aria-live="polite">
        {latest && `${latest.label}${latest.status === "failed" ? " failed" : ""}`}
      </p>
    </div>
  );
}
