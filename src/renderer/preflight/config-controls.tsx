import { useCallback, useEffect, useState } from "react";
import type { ConfigChange, ConfigStatus } from "../../shared/foom-config";
import type { SetupSource } from "./setup-source.d";

type ConfigSource = NonNullable<SetupSource["config"]>;

export function shortAgo(now: number, time: number): string {
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${String(hours)}h` : `${String(Math.floor(hours / 24))}d`;
}

const LABELS: Record<ConfigChange["state"], string> = {
  applied: "Applied",
  rejected: "Rejected",
  pending: "Pending",
};

/** Settings → Foom config: the folder, a held change, and recent changes with Revert. */
export function ConfigControls({ config }: { config: ConfigSource }) {
  const [view, setView] = useState<{ status?: ConfigStatus; now: number }>(() => ({
    now: Date.now(),
  }));
  const { status, now } = view;
  const setStatus = useCallback((next: ConfigStatus) => {
    setView({ status: next, now: Date.now() });
  }, []);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void config.status().then(
      (next) => {
        if (active) setStatus(next);
      },
      () => {
        if (active) setError("Foom config is unavailable.");
      },
    );
    const unsubscribe = config.subscribe(setStatus);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [config, setStatus]);
  const run = (work: () => Promise<ConfigStatus | undefined>) => {
    setBusy(true);
    setError("");
    void work()
      .then(
        (next) => {
          if (next) setStatus(next);
        },
        (reason: unknown) => {
          setError(reason instanceof Error ? reason.message : "Unable to update Foom config.");
        },
      )
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <div className="config-controls">
      <div className="config-folder">
        <code>{status?.folder ?? "~/.foom/config"}</code>
        <button
          type="button"
          onClick={() => {
            run(async () => {
              await config.openFolder();
              return undefined;
            });
          }}
        >
          Open folder
        </button>
      </div>
      {status?.error && <p className="config-note">{status.error}</p>}
      {status?.pending && (
        <section className="config-pending" aria-label="Change waiting for approval">
          <div>
            <h3>An agent wants to {status.pending.action}</h3>
            <small>
              {status.pending.file} · {status.pending.detail}
            </small>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              run(() => config.decide("allow"));
            }}
          >
            Allow
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => {
              run(() => config.decide("keep"));
            }}
          >
            Keep it on
          </button>
        </section>
      )}
      <h3>Recent changes</h3>
      {status?.changes.length ? (
        <ul className="config-changes" aria-label="Recent changes">
          {status.changes.map((change) => (
            <li key={change.id} className="config-change" data-state={change.state}>
              <time dateTime={new Date(change.time).toISOString()}>
                {shortAgo(now, change.time)}
              </time>
              <span className="config-change-text">
                {change.summary}
                <small>
                  {change.file}
                  {change.hash ? ` · ${change.hash}` : ""}
                  {change.reason ? ` · ${change.reason}` : ""}
                </small>
              </span>
              <span className="config-status">
                <span className="config-light" aria-hidden="true" />
                {LABELS[change.state]}
              </span>
              {change.state === "applied" && change.commit ? (
                <button
                  type="button"
                  className="config-revert"
                  disabled={busy}
                  aria-label={`Revert ${change.summary}`}
                  onClick={() => {
                    const commit = change.commit;
                    if (commit) run(() => config.revert(commit));
                  }}
                >
                  Revert
                </button>
              ) : (
                <span className="config-revert" />
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="config-note">No changes yet.</p>
      )}
      {error && (
        <p className="preflight-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
