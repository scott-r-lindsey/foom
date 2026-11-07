import { AgentReload } from "./agent-reload";
import { useEffect, useState } from "react";
import type { ConfigStatus } from "../../shared/foom-config";
import type { ComponentProps } from "react";
import type { HostRow, HostsAction } from "../../shared/registered-hosts.d";
import { hostDisplayName } from "../../shared/registered-hosts";
import { builtinAgent } from "../../shared/providers/catalog";
import { AgentBadge } from "../board/agent-badge";
import { ActionError } from "../board/error-presentation";
import { AgentsStep } from "./agents-step";
import { AgentArguments } from "./agent-default-arguments";
import { agentChoices } from "./preflight";

function remoteAgent(host: HostRow, id: string) {
  const result = host.result ?? host.observation?.preflight.result;
  const cached = host.observation?.lastAgents?.result;
  const facts = result?.ok ? result.facts : cached?.ok ? cached.facts : undefined;
  return facts?.agents.find((agent) => agent.id === id);
}
function offline(host: HostRow) {
  const result = host.result ?? host.observation?.preflight.result;
  return result?.ok === false;
}
function status(agent: ReturnType<typeof remoteAgent>) {
  if (!agent) return "Not checked";
  if (agent.state === "missing") return "Not found";
  if (agent.state !== "ready") return "Unable to check";
  return agent.signIn === "signed-out"
    ? "Signed out"
    : agent.signIn === "signed-in"
      ? "Ready"
      : "Ready · sign-in unknown";
}
const glyph = (text: string) =>
  text.startsWith("Ready") ? "✓" : text === "Off" ? "—" : text === "Signed out" ? "◐" : "○";

/** Scope changes read observations only; all remote work belongs to explicit actions. */
export function AgentsScopes(
  props: ComponentProps<typeof AgentsStep> & {
    scope: string;
    selectScope: (scope: string) => void;
  },
) {
  const { scope, selectScope, headingRef, ...cardProps } = props;
  const { state, report, source, scanning, scan, save, saveArguments } = cardProps;
  const [hosts, setHosts] = useState<readonly HostRow[]>([]);
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState("");
  const [localRevision, setLocalRevision] = useState(0);
  const [config, setConfig] = useState<ConfigStatus>();
  const configSource = source?.config;
  useEffect(() => {
    let active = true;
    if (!configSource) return;
    void configSource.status().then(
      (next) => {
        if (active) setConfig(next);
      },
      () => {
        if (active) setError("Unable to load agent settings");
      },
    );
    const dispose = configSource.subscribe((next) => {
      if (active) {
        setConfig(next);
        void scan(true);
      }
    });
    return () => {
      active = false;
      dispose();
    };
  }, [configSource, scan]);
  const api = source?.hosts;
  useEffect(() => {
    let active = true;
    if (api)
      void api({ action: "list" }).then(
        (next) => {
          if (active) setHosts(next.hosts);
        },
        () => {
          if (active) setError("Unable to load hosts");
        },
      );
    return () => {
      active = false;
    };
  }, [api, state.settings.registeredHosts]);
  const act = async (request: HostsAction | readonly HostsAction[], key: string) => {
    setPending((previous) => new Set(previous).add(key));
    setError("");
    try {
      for (const action of "action" in request ? [request] : request) {
        const next = await api?.(action);
        if (next) {
          setHosts((previous) =>
            previous.map((entry) =>
              "host" in action && entry.host === action.host
                ? (next.hosts.find((row) => row.host === entry.host) ?? entry)
                : entry,
            ),
          );
          if (next.recipeFailure) setError("Recipe unavailable for this host");
        }
      }
    } catch {
      setError("Unable to check agent settings");
    } finally {
      setPending((previous) => {
        const next = new Set(previous);
        next.delete(key);
        return next;
      });
    }
  };
  const choices = agentChoices(report);
  const machines: { id: string; name: string; host?: HostRow }[] = [
    { id: "local", name: "This computer" },
    ...hosts.map((host) => ({ id: `host:${host.host}`, name: hostDisplayName(host), host })),
  ];
  const selected = hosts.find((host) => `host:${host.host}` === scope);
  const reloadHost = (host: HostRow) => {
    void act({ action: "preflight", host: host.host, codeFolder: host.codeFolder }, host.host);
  };
  const reloadLocal = () => {
    setLocalRevision((revision) => revision + 1);
    void scan(true);
  };
  const localStatus = (id: string) => {
    const agent = report?.agents.find((entry) => entry.id === id);
    return !report ? "Not checked" : agent?.path ? "Ready · sign-in unknown" : "Not found";
  };
  return (
    <div className="agents-page">
      <header className="agents-head">
        <h2 ref={headingRef} tabIndex={-1}>
          Agents
        </h2>
        <label>
          <input
            type="checkbox"
            checked={state.settings.hooks}
            onChange={(event) => {
              save({ hooks: event.target.checked });
            }}
          />{" "}
          Attach hooks
        </label>
      </header>
      <div className="agent-scopes" role="tablist" aria-label="Agents scope">
        {[{ id: "global", name: "Global" }, ...machines].map((machine) => (
          <button
            type="button"
            role="tab"
            key={machine.id}
            aria-selected={scope === machine.id}
            onClick={() => {
              selectScope(machine.id);
            }}
          >
            {machine.name}
          </button>
        ))}
      </div>
      {error && (
        <ActionError
          message={error}
          close={() => {
            setError("");
          }}
        />
      )}
      {scope === "global" ? (
        <>
          <div className="agent-matrix-wrap">
            <table className="agent-matrix">
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  {machines.map((machine) => (
                    <th scope="col" key={machine.id}>
                      <div className="agent-column-head">
                        <button
                          type="button"
                          onClick={() => {
                            selectScope(machine.id);
                          }}
                        >
                          {machine.name}
                        </button>
                        <AgentReload
                          name={machine.name}
                          busy={
                            machine.id === "local"
                              ? scanning
                              : pending.has(machine.host?.host ?? machine.id)
                          }
                          disabled={machine.host ? offline(machine.host) : false}
                          reload={() => {
                            const host = machine.host;
                            if (host) reloadHost(host);
                            else reloadLocal();
                          }}
                        />
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {choices.map((choice) => (
                  <tr
                    key={choice.id}
                    className={state.settings.agents[choice.id] === false ? "agent-off" : undefined}
                  >
                    <th scope="row">
                      <label>
                        <input
                          type="checkbox"
                          aria-label={`Enable ${choice.name}`}
                          checked={state.settings.agents[choice.id] !== false}
                          onChange={(event) => {
                            save({
                              agents: {
                                ...state.settings.agents,
                                [choice.id]: event.target.checked,
                              },
                            });
                          }}
                        />
                        <AgentBadge
                          mark={
                            builtinAgent(choice.id)?.mark ?? choice.id.slice(0, 2).toUpperCase()
                          }
                        />
                        {choice.name}
                      </label>
                    </th>
                    {machines.map((machine) => {
                      const host = machine.host;
                      const text =
                        state.settings.agents[choice.id] === false
                          ? "Off"
                          : host
                            ? status(remoteAgent(host, choice.id))
                            : localStatus(choice.id);
                      return (
                        <td key={machine.id}>
                          <button
                            type="button"
                            aria-label={`${choice.name} on ${machine.name}: ${text}`}
                            title={text}
                            onClick={() => {
                              selectScope(machine.id);
                            }}
                          >
                            <span aria-hidden="true">{glyph(text)}</span> {text}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="agent-legend">
            <span>✓ Ready</span>
            <span>◐ Signed out</span>
            <span>○ Not found</span>
            <span>— Off</span>
          </p>
          <h3>Default arguments</h3>
          <div className="agent-defaults">
            {choices
              .filter((choice) => state.settings.agents[choice.id] !== false)
              .map((choice) => (
                <div className="agent-setting agent-card" key={choice.id}>
                  <span>{choice.name}</span>
                  <AgentArguments
                    id={choice.id}
                    name={choice.name}
                    value={state.settings.agentArguments[choice.id] ?? []}
                    bypass={
                      report?.agents.find((agent) => agent.id === choice.id)?.bypassArguments ?? []
                    }
                    save={async (args) => {
                      await saveArguments(choice.id, args);
                    }}
                  />
                </div>
              ))}
          </div>
          {source?.config && (
            <div className="agent-manifests">
              <h3>Custom agents</h3>
              {config?.agentPlugins
                ?.filter((plugin) => !builtinAgent(plugin.id))
                .map((plugin) => (
                  <p key={plugin.file}>
                    {plugin.name} · {plugin.file} · {plugin.state}
                    {plugin.reason ? ` · ${plugin.reason}` : ""}
                  </p>
                ))}
              <p>Agent manifests live in the Foom config folder.</p>
              <button
                type="button"
                onClick={() => {
                  void source.config?.openFolder().catch(() => {
                    setError("Unable to open config folder");
                  });
                }}
              >
                Open config folder
              </button>
            </div>
          )}
        </>
      ) : scope === "local" ? (
        <>
          <div className="agent-scope-bar">
            <span>
              {report?.checkedAt
                ? `Last checked ${new Date(report.checkedAt).toLocaleString()}`
                : "Not checked"}
            </span>
            <AgentReload name="This computer" busy={scanning} reload={reloadLocal} />
          </div>
          <AgentsStep {...cardProps} receiptEpoch={localRevision} headingRef={headingRef} machine />
        </>
      ) : selected ? (
        <>
          <div className="agent-scope-bar">
            <code>{selected.host}</code>
            <span>
              {offline(selected) ? "Offline · " : ""}
              {selected.observation
                ? `Last checked ${new Date(selected.observation.lastAgents?.checkedAt ?? selected.observation.checkedAt).toLocaleString()}`
                : "Not checked"}
            </span>
            <AgentReload
              name={hostDisplayName(selected)}
              busy={pending.has(selected.host)}
              disabled={offline(selected)}
              reload={() => {
                reloadHost(selected);
              }}
            />
          </div>
          <div className={`agent-cards${offline(selected) ? " agent-stale" : ""}`}>
            {choices
              .filter((choice) => state.settings.agents[choice.id] !== false)
              .map((choice) => {
                const agent = remoteAgent(selected, choice.id);
                const recipe = selected.recipes?.find((recipe) => recipe.tool === choice.id);
                const busy =
                  pending.has(selected.host) || pending.has(`${selected.host}:${choice.id}`);
                return (
                  <section className="agent-card" aria-label={choice.name} key={choice.id}>
                    <div className="agent-card-head">
                      <AgentBadge
                        mark={builtinAgent(choice.id)?.mark ?? choice.id.slice(0, 2).toUpperCase()}
                      />
                      <h3>{choice.name}</h3>
                      <AgentReload
                        name={choice.name}
                        busy={busy}
                        disabled={offline(selected)}
                        reload={() => {
                          void act(
                            [
                              {
                                action: "reload",
                                host: selected.host,
                                target: { kind: "tool", tool: choice.id },
                              },
                              {
                                action: "reload",
                                host: selected.host,
                                target: { kind: "sign-in", tool: choice.id },
                              },
                            ],
                            `${selected.host}:${choice.id}`,
                          );
                        }}
                      />
                    </div>
                    {agent?.details && (
                      <>
                        <span className="agent-version">
                          {agent.details.version || "Version unknown"}
                        </span>
                        <code className="agent-path">{agent.details.path}</code>
                      </>
                    )}
                    {agent?.state === "ready" ? (
                      <div className="agent-setting">
                        <span className="agent-label">Sign-in</span>
                        <span>
                          {agent.signIn === "signed-in"
                            ? "Signed in"
                            : agent.signIn === "signed-out"
                              ? "Signed out"
                              : "Sign-in unknown"}
                        </span>
                      </div>
                    ) : (
                      <p>{status(agent)}</p>
                    )}
                    {agent?.details && (
                      <div className="agent-capabilities">
                        {agent.details.capabilities.map((capability) => (
                          <span className="agent-capability" key={capability}>
                            {capability}
                          </span>
                        ))}
                      </div>
                    )}
                    {choice.id === "agy" && agent?.state === "ready" && (
                      <div className="agent-setting">
                        <span>Foom plugin</span>
                        <span>
                          {agent.details?.plugin === "present"
                            ? "Present · use agy to manage"
                            : agent.details?.plugin === "not-installed"
                              ? "Not installed · screen rules"
                              : "Status unavailable"}
                        </span>
                        <div>
                          <p>
                            Install the bundled lifecycle plugin on this host. This runs foom-host
                            --stage-plugin agy, then agy plugin install with its printed directory.
                            Without it, Foom uses screen rules.
                          </p>
                          {agent.details?.plugin === "not-installed" && recipe?.pluginInstall && (
                            <button
                              type="button"
                              disabled={busy || offline(selected)}
                              onClick={() => {
                                void act(
                                  {
                                    action: "recipe",
                                    host: selected.host,
                                    tool: "agy",
                                    operation: "install-plugin",
                                  },
                                  `${selected.host}:agy`,
                                );
                              }}
                            >
                              Install plugin
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                    {agent?.state === "missing" && recipe?.install && (
                      <button
                        type="button"
                        disabled={busy || offline(selected)}
                        onClick={() => {
                          void act(
                            {
                              action: "recipe",
                              host: selected.host,
                              tool: choice.id,
                              operation: "install",
                            },
                            `${selected.host}:${choice.id}`,
                          );
                        }}
                      >
                        Install
                      </button>
                    )}
                    {agent?.state === "ready" && agent.signIn !== "signed-in" && recipe?.signIn && (
                      <button
                        type="button"
                        disabled={busy || offline(selected)}
                        onClick={() => {
                          void act(
                            {
                              action: "recipe",
                              host: selected.host,
                              tool: choice.id,
                              operation: "sign-in",
                            },
                            `${selected.host}:${choice.id}`,
                          );
                        }}
                      >
                        Sign in
                      </button>
                    )}
                  </section>
                );
              })}
          </div>
        </>
      ) : (
        <p>Host no longer registered.</p>
      )}
      {scope !== "global" &&
        choices.some((choice) => state.settings.agents[choice.id] === false) && (
          <p className="agent-disabled-summary">
            Off:{" "}
            {choices
              .filter((choice) => state.settings.agents[choice.id] === false)
              .map((choice) => choice.name)
              .join(", ")}{" "}
            <button
              type="button"
              onClick={() => {
                selectScope("global");
              }}
            >
              Global
            </button>
          </p>
        )}
    </div>
  );
}
