import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DialogRequest } from "../shared/confirmation";
const stateLabels: Readonly<Record<string, string>> = {
  working: "Working",
  checking: "Checking",
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
    for (const [key, color] of Object.entries(request.theme.colors))
      document.documentElement.style.setProperty(`--${key}`, color);
    document.documentElement.style.setProperty(
      "--highlight",
      request.theme.colors.highlight ?? request.theme.colors.accent,
    );
    document.documentElement.style.setProperty(
      "--highlight-deep",
      request.theme.colors["highlight-deep"] ?? request.theme.colors["accent-deep"],
    );
    document.documentElement.style.colorScheme = request.theme.base;
  }, [request]);
  const requestId = request?.id;
  useEffect(() => {
    if (!requestId) return;
    const focusCancel = () => {
      cancelRef.current?.focus();
    };
    focusCancel();
    // The initial measurement happens hidden. Native activation can choose the
    // first tab stop on macOS, so restore Cancel on this request's first focus.
    window.addEventListener("focus", focusCancel, { once: true });
    return () => {
      window.removeEventListener("focus", focusCancel);
    };
  }, [requestId]);
  useEffect(() => {
    const card = cardRef.current;
    const body = bodyRef.current;
    if (!requestId || !card || !body) return;
    const measure = () => {
      // Keep the natural body height even when its viewport is clamped and scrolling.
      const content = body.parentElement;
      if (!content) return;
      window.confirmation.size({
        width: 440,
        height: card.offsetHeight - content.clientHeight + body.offsetHeight + 12,
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
          const targets = [cancelRef.current, acceptRef.current];
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
        <h1 id="confirmation-title">{request.title}</h1>
        <div className="confirmation-content" tabIndex={0} role="region" aria-label="Details">
          <div ref={bodyRef}>
            {request.detail !== undefined && <p>{request.detail}</p>}
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
            Cancel
          </button>
          <button
            type="button"
            ref={acceptRef}
            className="confirmation-accept"
            onClick={() => {
              answer(true);
            }}
          >
            {request.accept}
          </button>
        </footer>
      </section>
    </main>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<ConfirmationPage />);
