import { useEffect, useState } from "react";
import type { ConfigStatus } from "../../shared/foom-config";
import type { SetupSource } from "./setup-source.d";

type ConfigSource = NonNullable<SetupSource["config"]>;

/** Settings → Foom config: the folder, and only what needs the user now. */
export function ConfigControls({ config }: { config: ConfigSource }) {
  const [status, setStatus] = useState<ConfigStatus>();
  const pending = status?.pending;
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
  }, [config]);
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
      {pending && (
        <section className="config-pending" aria-label="Change waiting for approval">
          <div>
            <h3>An agent wants to {pending.action}</h3>
            <small>
              {pending.file} · {pending.detail}
            </small>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              run(() => config.decide("allow", pending.id));
            }}
          >
            Allow
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => {
              run(() => config.decide("keep", pending.id));
            }}
          >
            Keep it on
          </button>
        </section>
      )}
      {status?.rejected.length ? (
        <ul className="config-changes" aria-label="Rejected files">
          {status.rejected.map((entry) => (
            <li key={entry.file} className="config-change">
              <span className="config-change-text">
                {entry.file}
                <small>{entry.reason}</small>
              </span>
              <span className="config-status">
                <span className="config-light" aria-hidden="true" />
                Rejected
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {error && (
        <p className="preflight-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
