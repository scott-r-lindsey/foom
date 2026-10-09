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
    cancelRef.current?.focus();
  }, [request]);
  if (!request) return null;
  const answer = (accepted: boolean) => {
    window.confirmation.answer(request.id, accepted);
  };
  return (
    <main
      className="confirmation-scrim"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          answer(false);
        }
        if (event.key === "Tab") {
          event.preventDefault();
          (document.activeElement === cancelRef.current ? acceptRef : cancelRef).current?.focus();
        }
      }}
    >
      <section
        key={request.id}
        className="confirmation-window"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirmation-title"
      >
        <h1 id="confirmation-title">{request.title}</h1>
        <div className="confirmation-content">
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
