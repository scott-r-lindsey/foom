import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DialogRequest } from "../shared/confirmation";
const stateLabels: Readonly<Record<string, string>> = {
  working: "Working",
  needs_input: "Needs you",
  done: "Done",
  failed: "Failed",
  quiet_ok: "Quiet",
};
export function ConfirmationPage() {
  const [request, setRequest] = useState<DialogRequest | null>(null);
  const cardRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const acceptRef = useRef<HTMLButtonElement>(null);
  useEffect(() => window.confirmation.render(setRequest), []);
  useEffect(() => {
    if (!request) return;
    const colors = { ...request.theme.colors, ...request.theme.areas?.dialogs };
    for (const [key, color] of Object.entries(colors))
      document.documentElement.style.setProperty(`--${key}`, color);
    document.documentElement.style.setProperty("--highlight", colors.highlight ?? colors.accent);
    document.documentElement.style.setProperty(
      "--highlight-deep",
      colors["highlight-deep"] ?? colors["accent-deep"],
    );
    const style = document.documentElement.style;
    for (const key of ["radius", "panel-radius", "border", "shadow"] as const) {
      const value =
        request.theme.shape?.[key] ??
        (key === "panel-radius" ? request.theme.shape?.radius : undefined);
      if (value === undefined) style.removeProperty(`--shape-${key}`);
      else style.setProperty(`--shape-${key}`, `${String(value)}${key === "shadow" ? "" : "px"}`);
    }
    for (const key of ["selected", "hover", "focus", "scrollbar"] as const) {
      const value = request.theme.states?.[key];
      if (value === undefined) style.removeProperty(`--state-${key}`);
      else style.setProperty(`--state-${key}`, value);
    }
    document.documentElement.style.colorScheme = request.theme.base;
  }, [request]);
  const requestId = request?.id;
  useEffect(() => {
    if (!requestId) return;
    // Native activation can select its own first tab stop after showing the
    // measured window. Keep the safe default until the user's first interaction.
    let initial = true;
    const focusCancel = () => {
      if (initial && document.activeElement !== cancelRef.current) cancelRef.current?.focus();
    };
    const interacted = () => {
      initial = false;
    };
    window.addEventListener("focus", focusCancel);
    document.addEventListener("focusin", focusCancel);
    document.addEventListener("keydown", interacted, true);
    document.addEventListener("pointerdown", interacted, true);
    focusCancel();
    return () => {
      window.removeEventListener("focus", focusCancel);
      document.removeEventListener("focusin", focusCancel);
      document.removeEventListener("keydown", interacted, true);
      document.removeEventListener("pointerdown", interacted, true);
    };
  }, [requestId]);
  useEffect(() => {
    const card = cardRef.current;
    const body = bodyRef.current;
    if (!requestId || !card || !body) return;
    const measure = () => {
      // Keep the natural body height even when its viewport is clamped and scrolling.
      // Fractional heights: rounded ones change with the clamped viewport under zoom,
      // and each new size would resize the window again.
      const content = body.parentElement;
      if (!content) return;
      const height = (element: Element) => element.getBoundingClientRect().height;
      window.confirmation.size({
        width: 440,
        height: height(card) - height(content) + height(body) + 12,
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    observer.observe(body);
    measure();
    return () => {
      observer.disconnect();
    };
  }, [requestId]);
  if (!request) return null;
  const cleanup = request.cleanup;
  const running = cleanup?.stage === "run";
  const finished = running && cleanup.progress.phase === "finished";
  const disabled =
    cleanup?.stage === "checking" ||
    (cleanup?.stage === "ready" && cleanup.progress.total === 0) ||
    (running && cleanup.progress.stopped);
  const answer = (accepted: boolean) => {
    window.confirmation.answer(request.id, accepted);
  };
  return (
    <main
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          answer(false);
        }
        if (event.key === "Tab") {
          event.preventDefault();
          const content = bodyRef.current?.parentElement;
          const targets = [cancelRef.current, acceptRef.current].filter(
            (element) => element && !element.disabled,
          );
          const focusable =
            content && content.scrollHeight > content.clientHeight
              ? [...targets, content]
              : targets;
          const index = focusable.findIndex((element) => element === document.activeElement);
          focusable[
            (index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length
          ]?.focus();
        }
      }}
    >
      <section
        ref={cardRef}
        key={request.id}
        className="confirmation-window"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirmation-title"
      >
        <h1 id="confirmation-title">{running ? "Deleting merged worktrees" : request.title}</h1>
        <div className="confirmation-content" tabIndex={0} role="region" aria-label="Details">
          <div ref={bodyRef}>
            {cleanup && (
              <div aria-live="polite">
                {cleanup.error && <p>{cleanup.error}</p>}
                <p>
                  {cleanup.stage === "checking"
                    ? "Fetching remote and checking worktrees…"
                    : running
                      ? `${String(cleanup.progress.done)}/${String(cleanup.progress.total)} · ${finished ? "Finished" : cleanup.progress.stopped ? "Finishing in-flight removals…" : cleanup.progress.phase === "fetch" ? "Fetching remote…" : "Removing worktrees…"}`
                      : `${String(cleanup.progress.total)} worktrees to delete`}
                </p>
                {running && (
                  <progress
                    aria-label="Cleanup progress"
                    value={cleanup.progress.done}
                    max={Math.max(1, cleanup.progress.total)}
                  />
                )}
                {cleanup.stage === "checking" && <p className="confirmation-location">Checking…</p>}
                <ul aria-label="Cleanup checklist">
                  {cleanup.progress.items.map((item) => (
                    <li key={item.id} data-cleanup={item.state}>
                      <span>{item.branch}</span>
                      <span className="confirmation-location">{item.reason ?? item.state}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {request.detail !== undefined && <p>{request.detail}</p>}
            {request.reply && (
              <>
                <p>Current child context (untrusted)</p>
                <pre aria-label="Current child context">{request.reply.context}</pre>
                <p>Exact proposed reply</p>
                <pre aria-label="Exact proposed reply">{request.reply.text}</pre>
              </>
            )}
            {request.changes !== undefined && (
              <pre aria-label="Uncommitted changes">
                {request.changes.split("\0").filter(Boolean).join("\n")}
              </pre>
            )}
            {request.worktrees && (
              <>
                <ul aria-label="Worktrees to delete">
                  {request.worktrees
                    .filter((item) => !item.reason)
                    .map((item) => (
                      <li key={item.branch}>{item.branch}</li>
                    ))}
                </ul>
                <ul aria-label="Skipped worktrees" className="confirmation-skipped">
                  {request.worktrees
                    .filter((item) => item.reason)
                    .map((item) => (
                      <li key={item.branch}>
                        <span>{item.branch}</span>
                        <span className="confirmation-location">{item.reason}</span>
                      </li>
                    ))}
                </ul>
              </>
            )}
            {request.sessions && (
              <ul>
                {request.sessions.map((item) => (
                  <li key={item.id}>
                    <span
                      className="confirmation-light"
                      data-state={item.state}
                      role="img"
                      aria-label={stateLabels[item.state] ?? "Quiet"}
                    />
                    <span>{item.name}</span>
                    <span className="confirmation-location">{item.location}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <footer>
          <button
            type="button"
            ref={cancelRef}
            onClick={() => {
              answer(false);
            }}
          >
            {finished ? "Done" : running ? "Hide" : "Cancel"}
          </button>
          {!finished && (
            <button
              type="button"
              disabled={disabled}
              ref={acceptRef}
              className="confirmation-accept"
              onClick={() => {
                answer(true);
              }}
            >
              {running
                ? "Stop"
                : cleanup
                  ? `Delete ${String(cleanup.progress.total)}`
                  : request.accept}
            </button>
          )}
        </footer>
      </section>
    </main>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<ConfirmationPage />);
