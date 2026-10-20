import { ActionError, useBackgroundErrors } from "../board/error-presentation";
import { useEffect, useState } from "react";
import type { ConfigStatus } from "../../shared/foom-config";
import type { Settings, SettingsPatch } from "../../shared/setup";
import type { StepHeading } from "./preflight-step.d";
import type { SetupSource } from "./setup-source.d";
import { AgentBadge } from "../board/agent-badge";
import { message } from "./message";

export function ForgesSettings({
  headingRef,
  settings,
  source,
  save,
}: StepHeading & {
  settings: Settings;
  source: SetupSource;
  save: (patch: SettingsPatch) => Promise<void>;
}) {
  const { report: reportFailure, clear } = useBackgroundErrors();
  const [catalog, setCatalog] = useState<ConfigStatus>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [hosts, setHosts] = useState<ReadonlyMap<string, string>>(() => new Map());
  useEffect(() => {
    const config = source.config;
    if (!config) return;
    let active = true;
    const receive = (next: ConfigStatus) => {
      if (active) {
        setCatalog(next);
        clear("forge-catalog");
      }
    };
    void config.status().then(receive, () => {
      if (active) reportFailure("forge-catalog", "Unable to load forge settings.");
    });
    const dispose = config.subscribe(receive);
    return () => {
      active = false;
      dispose();
    };
  }, [source, clear, reportFailure]);
  const persist = async (patch: SettingsPatch) => {
    setBusy(true);
    setError("");
    try {
      await save(patch);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="agents-page">
      <header className="agents-head">
        <h2 ref={headingRef} tabIndex={-1}>
          Forges
        </h2>
      </header>
      {error && (
        <ActionError
          message={error}
          close={() => {
            setError("");
          }}
        />
      )}
      <div className="agent-cards">
        {(catalog?.forgePlugins ?? []).map((forge) => {
          const enabled = settings.forges[forge.id] === true;
          const assigned = forge.reason
            ? []
            : Object.entries(settings.forgeHosts).filter(([, id]) => id === forge.id);
          return (
            <section key={forge.file ?? forge.id} className="agent-card" aria-label={forge.name}>
              <div className="agent-card-head">
                <AgentBadge mark={forge.badge} />
                <h3>{forge.name}</h3>
                <span className="agent-version">
                  {forge.reason ? "Rejected" : enabled ? "Not checked" : "Turned off"}
                </span>
                <label className="agent-toggle">
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={forge.name}
                    checked={!forge.reason && enabled}
                    disabled={busy || Boolean(forge.reason)}
                    onChange={(event) => {
                      void persist({
                        forges: { ...settings.forges, [forge.id]: event.target.checked },
                      });
                    }}
                  />
                  {!forge.reason && enabled ? "On" : "Off"}
                </label>
                <code className="agent-path">{forge.executables.join(", ")}</code>
              </div>
              <div className="agent-setting">
                <span className="agent-label">Plugin source</span>
                <span>
                  {forge.file ? (
                    <>
                      Foom config · <code>{forge.file}</code>
                    </>
                  ) : (
                    "Built-in"
                  )}
                </span>
              </div>
              {forge.reason && <p className="preflight-error">{forge.reason}</p>}
              <div className="agent-setting">
                <span className="agent-label">Hosts</span>
                <div>
                  {assigned.map(([host]) => (
                    <div className="agent-inline" key={host}>
                      <code>{host}</code>
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={`Remove ${host}`}
                        onClick={() => {
                          void persist({
                            forgeHosts: Object.fromEntries(
                              Object.entries(settings.forgeHosts).filter(([key]) => key !== host),
                            ),
                          });
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  <form
                    className="agent-inline"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void persist({
                        forgeHosts: {
                          ...settings.forgeHosts,
                          [hosts.get(forge.id) ?? ""]: forge.id,
                        },
                      });
                    }}
                  >
                    <input
                      aria-label={`${forge.name} hostname`}
                      placeholder="git.example.org"
                      value={hosts.get(forge.id) ?? ""}
                      disabled={busy || !enabled || Boolean(forge.reason)}
                      onChange={(event) => {
                        setHosts(new Map(hosts).set(forge.id, event.target.value));
                      }}
                    />
                    <button type="submit" disabled={busy || !enabled || Boolean(forge.reason)}>
                      Assign host
                    </button>
                  </form>
                </div>
              </div>
            </section>
          );
        })}
        {Object.entries(settings.forgeHosts)
          .filter(
            ([, id]) =>
              !(catalog?.forgePlugins ?? []).some((forge) => forge.id === id && !forge.reason),
          )
          .map(([host, id]) => (
            <div className="agent-inline" key={host}>
              <code>{host}</code>
              <span>{id} · Unavailable</span>
              <button
                type="button"
                disabled={busy}
                aria-label={`Remove ${host}`}
                onClick={() => {
                  void persist({
                    forgeHosts: Object.fromEntries(
                      Object.entries(settings.forgeHosts).filter(([key]) => key !== host),
                    ),
                  });
                }}
              >
                Remove
              </button>
            </div>
          ))}
      </div>
    </div>
  );
}
