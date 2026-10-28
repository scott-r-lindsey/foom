import { useEffect, useState } from "react";
import type { RefObject } from "react";
import type {
  HostFailure,
  HostResult,
  HostsAction,
  HostsState,
} from "../../shared/registered-hosts.d";
import type { SetupSource } from "./setup-source.d";
import type { Repository } from "../../shared/worktrees";
const reasons: Record<HostFailure, string> = {
  unreachable: "Host unreachable",
  unsupported: "Unsupported host platform",
  "artifact-unavailable": "Remote host artifact unavailable in this local build",
  "folder-refused": "Code folder unavailable",
  "unsafe-folder": "Code folder ownership or permissions are unsafe",
  "origin-unavailable": "Repository origin unavailable",
  "clone-failed": "Could not clone from origin",
  "checkout-refused": "Checkout unavailable",
};
function Result({ result }: { result: HostResult | undefined }) {
  return (
    <span role="status" className={result && !result.ok ? "hosts-failure" : ""}>
      {result
        ? result.ok
          ? "Connection ready · Code folder checked"
          : reasons[result.reason]
        : "Not checked"}
    </span>
  );
}
function memory(bytes: number) {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}
export function HostsSettings({
  source,
  headingRef,
}: {
  source: Pick<SetupSource, "hosts">;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const [state, setState] = useState<HostsState>({ hosts: [], locations: [] });
  const [adding, setAdding] = useState(false);
  const [host, setHost] = useState("");
  const [folder, setFolder] = useState("~/foom");
  const [tested, setTested] = useState<HostResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const api = source.hosts;
  useEffect(() => {
    let active = true;
    void api?.({ action: "list" }).then(
      (next) => {
        if (active) setState(next);
      },
      () => {
        if (active) setError("Unable to load hosts");
      },
    );
    return () => {
      active = false;
    };
  }, [api]);
  const act = async (action: HostsAction) => {
    setBusy(true);
    setError("");
    try {
      const next = await api?.(action);
      if (next) {
        setState(next);
        if (action.action === "test" || action.action === "add") setTested(next.result);
        if (action.action === "add" && next.result?.ok) {
          setAdding(false);
          setHost("");
          setFolder("~/foom");
          setTested(undefined);
        }
      }
    } catch {
      setError("Unable to update hosts");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="hosts-page">
      <header className="hosts-heading">
        <h2 ref={headingRef} tabIndex={-1}>
          Hosts
        </h2>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setAdding(true);
          }}
        >
          Add host
        </button>
      </header>
      {error && (
        <p role="alert" className="hosts-failure">
          {error}
        </p>
      )}
      {adding && (
        <fieldset disabled={busy} className="host-card">
          <legend>Add host</legend>
          <label>
            SSH host
            <input
              value={host}
              onChange={(event) => {
                setHost(event.target.value);
                setTested(undefined);
              }}
            />
          </label>
          <label>
            Code folder
            <input
              value={folder}
              onChange={(event) => {
                setFolder(event.target.value);
                setTested(undefined);
              }}
            />
          </label>
          <div className="host-actions">
            <button
              type="button"
              onClick={() => {
                void act({ action: "test", host, codeFolder: folder });
              }}
            >
              Test connection
            </button>
            <button
              type="button"
              onClick={() => {
                void act({ action: "test", host, codeFolder: folder });
              }}
            >
              Check folder
            </button>
            <button
              type="button"
              disabled={!tested?.ok}
              onClick={() => {
                void act({ action: "add", host, codeFolder: folder });
              }}
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setTested(undefined);
              }}
            >
              Cancel
            </button>
          </div>
          <Result result={tested} />
        </fieldset>
      )}
      {!state.hosts.length && !adding && <p>No hosts</p>}
      {state.hosts.map((entry) => (
        <section className="host-card" key={entry.host} aria-label={entry.host}>
          <header className="hosts-heading">
            <h3>{entry.host}</h3>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void act({ action: "refresh", host: entry.host });
              }}
            >
              Refresh
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void act({ action: "remove", host: entry.host });
              }}
            >
              Remove
            </button>
          </header>
          <code>{entry.codeFolder}</code>
          <Result result={entry.result} />
          {entry.result?.ok && (
            <>
              <dl className="host-facts">
                <div>
                  <dt>Daemon</dt>
                  <dd>{entry.result.facts.version}</dd>
                </div>
                <div>
                  <dt>Live sessions</dt>
                  <dd>{entry.result.facts.sessions}</dd>
                </div>
                <div>
                  <dt>CPU cores</dt>
                  <dd>{entry.result.facts.cores}</dd>
                </div>
                <div>
                  <dt>Load average</dt>
                  <dd>{entry.result.facts.load.map((value) => value.toFixed(2)).join(" · ")}</dd>
                </div>
                <div>
                  <dt>Memory total</dt>
                  <dd>{memory(entry.result.facts.memoryTotal)}</dd>
                </div>
                <div>
                  <dt>Memory available</dt>
                  <dd>{memory(entry.result.facts.memoryAvailable)}</dd>
                </div>
              </dl>
              <h4>Agents</h4>
              <ul className="host-agents">
                {entry.result.facts.agents.map((agent) => (
                  <li key={agent.id}>
                    <span>{agent.id}</span>
                    <span>
                      {agent.state === "ready"
                        ? "Ready"
                        : agent.state === "missing"
                          ? "Not found"
                          : "Unable to check"}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      ))}
      {busy && <p role="status">Checking…</p>}
    </div>
  );
}
export function RepositoryHosts({
  source,
  repositories,
}: {
  source: Pick<SetupSource, "hosts">;
  repositories: readonly Repository[];
}) {
  const [state, setState] = useState<HostsState>({ hosts: [], locations: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const api = source.hosts;
  useEffect(() => {
    let active = true;
    void api?.({ action: "locations" }).then(
      (next) => {
        if (active) setState(next);
      },
      () => {
        if (active) setError("Unable to check locations");
      },
    );
    return () => {
      active = false;
    };
  }, [api, repositories]);
  const clone = async (host: string, repository: string) => {
    setBusy(true);
    setError("");
    try {
      const next = await api?.({ action: "clone", host, repository });
      if (next) setState(next);
    } catch {
      setError("Unable to clone repository");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="repository-hosts" aria-label="Repository locations">
      <h3>Locations</h3>
      {error && (
        <p role="alert" className="hosts-failure">
          {error}
        </p>
      )}
      <div className="host-table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Repository</th>
              <th scope="col">Local</th>
              {state.hosts.map((host) => (
                <th scope="col" key={host.host}>
                  {host.host}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {repositories.map((repo) => (
              <tr key={repo.path}>
                <th scope="row">{repo.name}</th>
                <td>
                  <code>{repo.path}</code>
                  <span>Checked out</span>
                </td>
                {state.hosts.map((host) => {
                  const result = state.locations.find(
                    (entry) => entry.host === host.host && entry.repository === repo.path,
                  )?.result;
                  return (
                    <td key={host.host}>
                      {result?.ok && result.checkout ? (
                        <>
                          <code>{result.checkout.path}</code>
                          {result.checkout.state === "absent" ? (
                            <>
                              <span>Not checked out</span>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => {
                                  void clone(host.host, repo.path);
                                }}
                              >
                                Clone here
                              </button>
                            </>
                          ) : (
                            <span>{result.checkout.state === "clean" ? "Clean" : "Changes"}</span>
                          )}
                        </>
                      ) : (
                        <>
                          <Result result={result} />
                          {result && !result.ok && result.reason === "clone-failed" && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                void clone(host.host, repo.path);
                              }}
                            >
                              Clone here
                            </button>
                          )}
                        </>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
