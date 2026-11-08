import { AgentStatus } from "./agent-status";
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
/** Scope changes read observations only; all remote work belongs to explicit actions. */
export function AgentsScopes(
  props: ComponentProps<typeof AgentsStep> & {
    scope: string;
    selectScope: (scope: string) => void;
  },
) {
  const { scope: requestedScope, selectScope, headingRef, ...cardProps } = props;
  const { state, report, source, scanning, scan, save, saveArguments } = cardProps;
  const [lastMachine, setLastMachine] = useState("local");
  const registrations = state.settings.registeredHosts;
  const api = source?.hosts;
  const [hostList, setHostList] = useState<{
    registrations: typeof registrations;
    api: typeof api;
    rows: readonly HostRow[];
  }>();
  const hostsReady =
    !api || (!!hostList && hostList.registrations === registrations && hostList.api === api);
  const hosts = (hostList?.rows ?? []).filter((row) =>
    registrations?.some((registration) => registration.host === row.host),
  );
  const scope =
    requestedScope === "global" ||
    requestedScope === "local" ||
    (registrations?.some((entry) => `host:${entry.host}` === requestedScope) &&
      (!hostsReady || hosts.some((entry) => `host:${entry.host}` === requestedScope)))
      ? requestedScope
      : "local";
  useEffect(() => {
    if (scope !== requestedScope) selectScope(scope);
  }, [scope, requestedScope, selectScope]);
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
  useEffect(() => {
    let active = true;
    if (api)
      void api({ action: "list" }).then(
        (next) => {
          if (active) setHostList({ registrations, api, rows: next.hosts });
        },
        () => {
          if (active) setError("Unable to load hosts");
        },
      );
    return () => {
      active = false;
    };
  }, [api, registrations]);
  const act = async (request: HostsAction | readonly HostsAction[], key: string) => {
    if (!hostsReady) return;
    setPending((previous) => new Set(previous).add(key));
    setError("");
    try {
      for (const action of "action" in request ? [request] : request) {
        const next = await api?.(action);
        if (next) {
          setHostList(
            (previous) =>
              previous && {
                ...previous,
                rows: previous.rows.map((entry) =>
                  "host" in action && entry.host === action.host
                    ? (next.hosts.find((row) => row.host === entry.host) ?? entry)
                    : entry,
                ),
              },
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
  const choices = [
    ...agentChoices(report),
    ...(config?.agentPlugins ?? []).filter(
      (plugin) =>
        !builtinAgent(plugin.id) && !agentChoices(report).some((agent) => agent.id === plugin.id),
    ),
  ];
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
  return (
    <div className="agents-page agents-scoped">
      <header className="agents-head">
        <h2 ref={headingRef} tabIndex={-1}>
          Agents
        </h2>
        {scope === "global" && (
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
        )}
      </header>
      <div className="agent-scopes" role="tablist" aria-label="Agents scope">
        {[
          { id: "global", name: "Global" },
          { id: "machines", name: "Machines" },
        ].map((view) => (
          <button
            type="button"
            role="tab"
            key={view.id}
            tabIndex={(view.id === "global") === (scope === "global") ? 0 : -1}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const target = event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(
                'button[aria-selected="false"]',
              );
              target?.click();
              target?.focus();
            }}
            aria-selected={view.id === "global" ? scope === "global" : scope !== "global"}
            onClick={() => {
              if (view.id === "global") {
                if (scope !== "global") setLastMachine(scope);
                selectScope("global");
              } else if (scope === "global") selectScope(lastMachine);
            }}
          >
            {view.name}
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
      <div className="agents-panel">
        {scope === "global" ? (
          <>
            <div className="agent-global-head">
              <span>Agent</span>
              <span>Default arguments</span>
            </div>
            <div className="agent-global-list">
              {choices.map((choice) => {
                const plugin = config?.agentPlugins?.find((entry) => entry.id === choice.id);
                const agent = report?.agents.find((entry) => entry.id === choice.id);
                const file = plugin?.file ?? agent?.source;
                return (
                  <div
                    className={`agent-global-row${state.settings.agents[choice.id] === false ? " agent-off" : ""}`}
                    key={choice.id}
                  >
                    <label className="agent-global-identity">
                      <input
                        type="checkbox"
                        aria-label={`Enable ${choice.name}`}
                        checked={state.settings.agents[choice.id] !== false}
                        onChange={(event) => {
                          save({
                            agents: { ...state.settings.agents, [choice.id]: event.target.checked },
                          });
                        }}
                      />
                      <AgentBadge
                        mark={
                          agent?.mark ??
                          plugin?.mark ??
                          builtinAgent(choice.id)?.mark ??
                          choice.id.slice(0, 2).toUpperCase()
                        }
                      />
                      <span>
                        <strong>{choice.name}</strong>
                        {file && <code className="agent-manifest">{file}</code>}
                        {plugin?.state === "rejected" && (
                          <span className="preflight-error">
                            Rejected · launch blocked · {plugin.reason}
                          </span>
                        )}
                      </span>
                    </label>
                    <AgentArguments
                      id={choice.id}
                      name={choice.name}
                      value={state.settings.agentArguments[choice.id] ?? []}
                      bypass={agent?.bypassArguments ?? []}
                      save={async (args) => {
                        await saveArguments(choice.id, args);
                      }}
                    />
                  </div>
                );
              })}
            </div>
            {source?.config && (
              <div className="agent-global-footer">
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
        ) : (
          <>
            <select
              className="agent-machine-picker"
              aria-label="Machine"
              value={scope}
              onChange={(event) => {
                selectScope(event.target.value);
              }}
            >
              {!machines.some((machine) => machine.id === scope) && (
                <option value={scope}>Host no longer registered</option>
              )}
              {machines.map((machine) => (
                <option key={machine.id} value={machine.id}>
                  {machine.name}
                  {machine.host && offline(machine.host) ? " · Offline" : ""}
                </option>
              ))}
            </select>
            {scope === "local" ? (
              <>
                <div className="agent-scope-bar">
                  <span>
                    {report?.checkedAt
                      ? `Last checked ${new Date(report.checkedAt).toLocaleString()}`
                      : "Not checked"}
                  </span>
                  <AgentReload
                    name="This computer"
                    busy={scanning}
                    disabled={!hostsReady}
                    reload={reloadLocal}
                  />
                </div>
                <AgentsStep
                  {...cardProps}
                  receiptEpoch={localRevision}
                  headingRef={headingRef}
                  machine
                  actionsDisabled={!hostsReady}
                />
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
                    disabled={!hostsReady || offline(selected)}
                    reload={() => {
                      reloadHost(selected);
                    }}
                  />
                </div>
                <div
                  className={`agent-cards${offline(selected) ? " agent-stale" : ""}`}
                  tabIndex={0}
                  role="region"
                  aria-label="Machine agents"
                >
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
                              mark={
                                builtinAgent(choice.id)?.mark ?? choice.id.slice(0, 2).toUpperCase()
                              }
                            />
                            <h3>{choice.name}</h3>
                            {agent?.details && (
                              <span className="agent-version">
                                {agent.details.version || "Version unknown"}
                              </span>
                            )}
                            <AgentReload
                              name={choice.name}
                              busy={busy}
                              disabled={!hostsReady || offline(selected)}
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
                            <code className="agent-path agent-remote-path">
                              {agent.details.path}
                            </code>
                          )}
                          {agent?.state === "ready" ? (
                            <div className="agent-setting agent-machine-fact">
                              <span className="agent-label">Sign-in</span>
                              <AgentStatus
                                text={
                                  agent.signIn === "signed-in"
                                    ? "Signed in"
                                    : agent.signIn === "signed-out"
                                      ? "Signed out"
                                      : "Sign-in unknown"
                                }
                              />
                            </div>
                          ) : (
                            <div className="agent-setting agent-machine-fact">
                              <span className="agent-label">Installed</span>
                              <AgentStatus text={status(agent)} />
                            </div>
                          )}
                          {agent?.details && (
                            <div className="agent-setting agent-machine-fact">
                              <span className="agent-label">Capabilities</span>
                              <div className="agent-capabilities">
                                {agent.details.capabilities.map((capability) => (
                                  <span className="agent-capability" key={capability}>
                                    {capability}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                          {choice.id === "agy" && agent?.state === "ready" && (
                            <div className="agent-setting agent-machine-fact">
                              <span>Foom plugin</span>
                              <AgentStatus
                                text={
                                  agent.details?.plugin === "present"
                                    ? "Present · use agy to manage"
                                    : agent.details?.plugin === "not-installed"
                                      ? "Not installed · screen rules"
                                      : "Status unavailable"
                                }
                              />
                              <div>
                                {agent.details?.plugin === "not-installed" &&
                                  (recipe?.pluginInstall || offline(selected)) && (
                                    <button
                                      type="button"
                                      disabled={!hostsReady || busy || offline(selected)}
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
                              disabled={!hostsReady || busy || offline(selected)}
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
                          {agent?.state === "ready" &&
                            agent.signIn !== "signed-in" &&
                            recipe?.signIn && (
                              <button
                                type="button"
                                disabled={!hostsReady || busy || offline(selected)}
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
          </>
        )}
      </div>
    </div>
  );
}
