import { useEffect, useState, useRef } from "react";
import type { GithubSignInState } from "../../shared/registered-hosts.d";
import type { SetupSource } from "./setup-source.d";
import { HostTerminal } from "./host-terminal";

/** Presentation only. Main binds the code and all effects to this window's recipe. */
export function GithubSignInPanel({
  id,
  source,
  finished,
  installing,
  retry,
}: {
  retry?: () => void;
  installing: boolean;
  id: string;
  source: Pick<SetupSource, "githubSignIn" | "hostTerminal">;
  finished: (id: string, succeeded?: boolean) => void | Promise<void>;
}) {
  const [state, setState] = useState<GithubSignInState>({
    phase: "starting",
    copied: false,
    opened: false,
  });
  const [terminal, setTerminal] = useState(installing);
  const [error, setError] = useState(false);
  const codeSeenRef = useRef(false);
  const api = source.githubSignIn;
  useEffect(() => {
    let active = true;
    const isActive = () => active;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const next = await api?.(id, "read");
        if (!active || !next) return;
        if (next.code && !codeSeenRef.current) {
          codeSeenRef.current = true;
          if (installing) setTerminal(false);
        }
        if (
          next.phase === "done" ||
          next.phase === "cancelled" ||
          next.phase === "failed" ||
          next.phase === "expired"
        ) {
          if (next.phase === "failed" || next.phase === "expired") setTerminal(true);
          await finished(id, next.phase === "done" || next.phase === "cancelled");
          if (isActive()) setState(next);
        } else {
          setState(next);
          timer = setTimeout(() => {
            void read();
          }, 250);
        }
      } catch {
        if (active) {
          setError(true);
          setTerminal(true);
        }
      }
    };
    void read();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, id, finished, installing]);
  const action = async (command: "copy" | "open" | "cancel") => {
    try {
      const next = await api?.(id, command);
      if (next) setState(next);
    } catch {
      setError(true);
    }
  };
  if (state.phase === "done" || state.phase === "cancelled") return null;
  const failed = state.phase === "failed" || state.phase === "expired";
  return (
    <section className="github-sign-in" aria-label="GitHub sign-in">
      <div className="host-check-row">
        <span className="host-check-name">
          GitHub CLI sign-in <span className="host-tag">PRs</span>
        </span>
        <span
          role="status"
          className={`host-status host-${failed || error ? "fail" : state.phase === "waiting" ? "need" : "work"}`}
        >
          <span className="host-symbol" aria-hidden="true" />
          <span>
            {error
              ? "Unable to check sign-in"
              : state.phase === "expired"
                ? "Failed · Code expired"
                : failed
                  ? `Failed · Exit ${String(state.exitCode ?? "unknown")}`
                  : state.phase === "waiting"
                    ? "Needs you · Authorize on GitHub"
                    : state.phase === "finishing"
                      ? "Finishing…"
                      : installing
                        ? "Installing…"
                        : "Starting…"}
          </span>
        </span>
        <span className="host-check-action">
          {failed && retry && (
            <button type="button" onClick={retry}>
              Try again
            </button>
          )}
          {!failed && (
            <button
              type="button"
              onClick={() => {
                void action("cancel");
              }}
            >
              Cancel
            </button>
          )}
        </span>
      </div>
      {state.code && (
        <>
          <div className="github-code-line">
            <code className="github-device-code">{state.code}</code>
            <span className="host-tag">{state.copied ? "✓ Copied" : "Not copied"}</span>
            <span className="host-tag">
              {state.opened ? "✓ Browser opened" : "Browser not opened"}
            </span>
          </div>
          <div className="host-actions">
            <button
              type="button"
              onClick={() => {
                void action("copy");
              }}
            >
              Copy code
            </button>
            <button
              type="button"
              onClick={() => {
                void action("open");
              }}
            >
              Open GitHub
            </button>
          </div>
        </>
      )}
      <button
        className="github-terminal-toggle"
        type="button"
        aria-expanded={terminal}
        onClick={() => {
          setTerminal(!terminal);
        }}
      >
        {terminal ? "▾" : "▸"} Terminal
      </button>
      {terminal && source.hostTerminal && (
        <HostTerminal
          id={id}
          source={source.hostTerminal}
          finished={() => {}}
          label="Sign-in terminal"
          activeLabel={state.phase === "starting" && installing ? "Installing…" : "Signing in…"}
        />
      )}
    </section>
  );
}
