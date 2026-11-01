import { CopyValue } from "../ui/copy-value";
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
  "facts-unavailable": "Host daemon needs an update for host facts",
  "libc-too-old": "Unsupported host: glibc 2.28 or newer is required",
  "libc-unsupported": "Unsupported host: glibc is required (musl is unsupported)",
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
  source: Pick<SetupSource, "hosts" | "copyHost">;
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
        if (next.recipeFailure) setError("Recipe unavailable for this host");
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
              placeholder="user@host"
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
            <h3>
              <CopyValue
                value={entry.host}
                label="Copy host alias"
                copy={() =>
                  source.copyHost?.({ kind: "copy-host-alias", host: entry.host }) ??
                  Promise.reject(new Error("Copy unavailable"))
                }
              />
            </h3>
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
          <code>
            <CopyValue
              value={entry.codeFolder}
              label="Copy code folder"
              copy={() =>
                source.copyHost?.({ kind: "copy-host-code-folder", host: entry.host }) ??
                Promise.reject(new Error("Copy unavailable"))
              }
            />
          </code>
          <Result result={entry.result} />
          {entry.foreignWorktrees !== undefined && <p>{entry.foreignWorktrees} other worktrees</p>}
          {entry.foreignSessions !== undefined && (
            <div className="host-facts">
              <span>Other profiles or untagged: {entry.foreignSessions}</span>
              {entry.foreignSessions > 0 && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    void act({ action: "end", host: entry.host });
                  }}
                >
                  End…
                </button>
              )}
            </div>
          )}
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
              {entry.result.facts.requirements && (
                <p>
                  Platform: {entry.result.facts.requirements.distro} · libc:{" "}
                  {entry.result.facts.requirements.libc} · Package manager:{" "}
                  {entry.result.facts.requirements.packageManager}
                </p>
              )}
              {entry.result.facts.requirements?.mac && (
                <p>
                  Command Line Tools:{" "}
                  {entry.result.facts.requirements.mac.commandLineTools
                    ? "Present"
                    : "Do this on the Mac"}{" "}
                  · Sleep:{" "}
                  {entry.result.facts.requirements.mac.staysAwake
                    ? "Disabled"
                    : "May interrupt SSH sessions"}{" "}
                  · Code folder:{" "}
                  {entry.result.facts.requirements.mac.protectedFolder
                    ? "Inside a protected folder"
                    : "Outside protected folders"}
                </p>
              )}
              <h4>Tools and agents</h4>
              <ul className="host-agents">
                {[...(entry.result.facts.tools ?? []), ...entry.result.facts.agents].map(
                  (agent) => (
                    <li key={agent.id}>
                      <span>{agent.id}</span>
                      <span>
                        {agent.state === "ready"
                          ? "Ready"
                          : agent.state === "missing"
                            ? "Not found"
                            : "Unable to check"}
                      </span>
                      {agent.id !== "git" && (
                        <span>
                          {agent.signIn === "signed-in"
                            ? "Signed in"
                            : agent.signIn === "signed-out"
                              ? "Not signed in"
                              : "Sign-in unknown"}
                        </span>
                      )}
                      {agent.state === "missing" &&
                        (entry.recipes?.find((recipe) => recipe.tool === agent.id)?.install ? (
                          <button
                            type="button"
                            disabled={busy}
                            aria-label={`Install ${agent.id}`}
                            onClick={() => {
                              void act({
                                action: "recipe",
                                host: entry.host,
                                tool: agent.id,
                                operation: "install",
                              });
                            }}
                          >
                            Install
                          </button>
                        ) : (
                          <span>Install unavailable: no package-manager recipe</span>
                        ))}
                      {agent.state === "ready" &&
                        agent.signIn !== "signed-in" &&
                        entry.recipes?.find((recipe) => recipe.tool === agent.id)?.signIn && (
                          <button
                            type="button"
                            disabled={busy}
                            aria-label={`Sign in ${agent.id}`}
                            onClick={() => {
                              void act({
                                action: "recipe",
                                host: entry.host,
                                tool: agent.id,
                                operation: "sign-in",
                              });
                            }}
                          >
                            Sign in
                          </button>
                        )}
                    </li>
                  ),
                )}
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
  source: Pick<SetupSource, "hosts" | "copyHost">;
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
  const refresh = async () => {
    setBusy(true);
    setError("");
    try {
      const next = await api?.({ action: "locations" });
      if (next) setState(next);
    } catch {
      setError("Unable to check locations");
    } finally {
      setBusy(false);
    }
  };
  const clone = async (host: string, repository: string) => {
    setBusy(true);
    setError("");
    try {
      const next = await api?.({ action: "clone", host, repository });
      if (next) setState(next);
      if (
        next?.locations.some(
          (entry) =>
            entry.host === host &&
            entry.repository === repository &&
            !entry.result.ok &&
            entry.result.reason === "unreachable",
        )
      )
        await refresh();
    } catch {
      setError("Unable to clone repository");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="repository-hosts" aria-label="Repository locations">
      <h3>Locations</h3>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          void refresh();
        }}
      >
        Refresh locations
      </button>
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
                  <code>
                    <CopyValue
                      value={repo.path}
                      label="Copy checkout path"
                      copy={() =>
                        source.copyHost?.({
                          kind: "copy-checkout-path",
                          host: null,
                          repository: repo.path,
                        }) ?? Promise.reject(new Error("Copy unavailable"))
                      }
                    />
                  </code>
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
                          <code>
                            <CopyValue
                              value={result.checkout.path}
                              label="Copy checkout path"
                              copy={() =>
                                source.copyHost?.({
                                  kind: "copy-checkout-path",
                                  host: host.host,
                                  repository: repo.path,
                                }) ?? Promise.reject(new Error("Copy unavailable"))
                              }
                            />
                          </code>
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
