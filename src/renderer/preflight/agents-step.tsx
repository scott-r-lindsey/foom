import { useEffect, useEffectEvent, useState } from "react";
import { builtinAgent } from "../../shared/providers/catalog";
import type { AgyPluginAction } from "../../shared/agy-plugin";
import type { SetupState } from "../../shared/setup";
import type { AgentReport } from "../../shared/workspace";
import type { ConfigStatus } from "../../shared/foom-config";
import type { StepHeading, StepActions } from "./preflight-step.d";
import type { SetupSource } from "./setup-source.d";
import { AgentBadge } from "../board/agent-badge";
import { AgyPluginControl } from "./agy-plugin-control";
import { AgentArguments } from "./agent-default-arguments";
import { EnvironmentSettings } from "./environment-settings";
import { agentChoices, signal, versionNumber } from "./preflight";
import { message } from "./message";

export function AgentsStep({
  headingRef,
  state,
  report,
  scanning,
  scan,
  save,
  changePlugin,
  source,
  saveArguments,
}: StepHeading &
  StepActions & {
    changePlugin: (action: AgyPluginAction) => Promise<void>;
    state: SetupState;
    report: AgentReport | undefined;
    scanning: boolean;
    scan: (refresh: boolean) => Promise<void>;
    source?: SetupSource | undefined;
    saveArguments: (id: string, args: readonly string[]) => Promise<void>;
  }) {
  const [config, setConfig] = useState<ConfigStatus>();
  const [error, setError] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const configSource = source?.config;
  const configChanged = useEffectEvent((next: ConfigStatus) => {
    setConfig(next);
    void scan(false);
  });
  useEffect(() => {
    if (!configSource) return;
    let active = true;
    const receive = (next: ConfigStatus) => {
      if (active) configChanged(next);
    };
    void configSource.status().then(receive, (caught: unknown) => {
      if (active) setError(message(caught));
    });
    const dispose = configSource.subscribe(receive);
    return () => {
      active = false;
      dispose();
    };
  }, [configSource]);
  const held = config?.agentPlugins ?? [];
  const choices = [
    ...agentChoices(report),
    ...held.filter((plugin) => !agentChoices(report).some((agent) => agent.id === plugin.id)),
  ];
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
        <button
          type="button"
          disabled={scanning}
          onClick={() => {
            void scan(true);
          }}
        >
          {scanning ? "Scanning…" : "Scan again"}
        </button>
      </header>
      {report?.warning && <p className="preflight-warning">{report.warning}</p>}
      {error && (
        <p className="preflight-error" role="alert">
          {error}
        </p>
      )}
      <div className="agent-cards">
        {choices.map(({ id, name, command }) => {
          const agent = report?.agents.find((entry) => entry.id === id);
          const plugin = held.find((entry) => entry.id === id);
          const installed = Boolean(agent?.path);
          const blocked = Boolean(plugin);
          const missing = !installed && !blocked;
          const policy = builtinAgent(id);
          const supportsHooks = agent?.hooks || Boolean(policy?.pluginSetup && agent?.agyPlugin);
          const hooks = state.settings.hooks && state.settings.agentHooks?.[id] !== false;
          const how = agent && signal(agent, hooks);
          return (
            <section
              key={id}
              className={`agent-card${missing ? " missing" : ""}`}
              aria-label={name}
            >
              <div className="agent-card-head">
                <AgentBadge
                  mark={agent?.mark ?? plugin?.mark ?? policy?.mark ?? id.slice(0, 2).toUpperCase()}
                />
                <h3>{name}</h3>
                <span className="agent-version">
                  {versionNumber(agent?.version ?? null) ??
                    (missing
                      ? scanning || !report
                        ? "Looking…"
                        : "Not found"
                      : blocked
                        ? "Launch blocked"
                        : "Version unknown")}
                </span>
                {!missing && (
                  <label className="agent-toggle">
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={name}
                      checked={!blocked && state.settings.agents[id] !== false}
                      disabled={blocked}
                      onChange={(event) => {
                        save({ agents: { ...state.settings.agents, [id]: event.target.checked } });
                      }}
                    />
                    {!blocked && state.settings.agents[id] !== false ? "On" : "Off"}
                  </label>
                )}
                <code className="agent-path">{agent?.path ?? command}</code>
              </div>
              {!missing && (
                <>
                  <div className="agent-setting">
                    <span className="agent-label">Attention</span>
                    <div className="agent-inline">
                      {supportsHooks ? (
                        <div className="agent-signals" aria-label={`${name} attention`}>
                          {([true, false] as const).map((enabled) => (
                            <button
                              key={String(enabled)}
                              type="button"
                              aria-pressed={(state.settings.agentHooks?.[id] !== false) === enabled}
                              onClick={() => {
                                save({
                                  agentHooks: { ...state.settings.agentHooks, [id]: enabled },
                                });
                              }}
                            >
                              {enabled ? "Hooks" : "Screen rules"}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <span>Screen rules</span>
                      )}
                      {supportsHooks && how !== "hooks" && (
                        <span>
                          {how === "notify"
                            ? "Notify + screen rules active"
                            : "Screen rules active"}
                          {!state.settings.hooks ? " · hooks off" : ""}
                        </span>
                      )}
                      {agent?.codexHookState && (
                        <>
                          <span
                            className={
                              agent.codexHookState === "not-reviewed" ||
                              agent.codexHookState === "outdated"
                                ? "agent-needs"
                                : undefined
                            }
                          >
                            {agent.codexHookState === "trusted"
                              ? "Trusted · observed working"
                              : agent.codexHookState === "not-reviewed"
                                ? "Trust review pending"
                                : agent.codexHookState === "outdated"
                                  ? "Outdated · review needed"
                                  : "Declined · Notify fallback"}
                          </span>
                          <code>/hooks in Codex</code>
                        </>
                      )}
                      {installed &&
                        policy?.pluginSetup &&
                        agent?.agyPlugin?.state === "not-installed" &&
                        !state.settings.agyPluginOfferAnswered && <span>Plugin available</span>}
                      {agent?.agyPlugin && (
                        <AgyPluginControl
                          status={agent.agyPlugin}
                          busy={scanning}
                          change={changePlugin}
                        />
                      )}
                    </div>
                  </div>
                  <div className="agent-setting">
                    <span className="agent-label">Capabilities</span>
                    <dl className="agent-facts">
                      {[
                        ["MCP", agent?.mcp],
                        ["Resume", agent?.resume ?? Boolean(policy)],
                        ["Inline", agent?.inline],
                      ].map(([label, available]) => (
                        <div key={String(label)}>
                          <dt>{label}</dt>
                          <dd>{available ? "Available" : "Unavailable"}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                  {!blocked && (
                    <>
                      <div className="agent-setting">
                        <span className="agent-label">Default arguments</span>
                        <AgentArguments
                          id={id}
                          name={name}
                          value={state.settings.agentArguments[id] ?? []}
                          bypass={agent?.bypassArguments ?? []}
                          save={async (args) => {
                            await saveArguments(id, args);
                          }}
                        />
                      </div>
                      {source?.environment && (
                        <div className="agent-setting">
                          <span className="agent-label">Environment</span>
                          <div>
                            <EnvironmentSettings
                              source={source.environment}
                              scope={id}
                              label={name}
                            />
                          </div>
                        </div>
                      )}
                    </>
                  )}
                  <div className="agent-setting">
                    <span className="agent-label">Plugin source</span>
                    <div className="agent-inline">
                      {plugin || agent?.source ? (
                        <>
                          <span>
                            Foom config · <code>{plugin?.file ?? agent?.source}</code>
                          </span>
                          <span
                            className={
                              plugin?.state === "pending"
                                ? "agent-needs"
                                : plugin?.state === "rejected"
                                  ? "preflight-error"
                                  : undefined
                            }
                          >
                            {plugin?.state === "pending"
                              ? "Approval pending · launch blocked"
                              : plugin?.state === "rejected"
                                ? "Rejected · launch blocked"
                                : "Approved"}
                          </span>
                          {plugin?.reason && (
                            <span className="preflight-error">{plugin.reason}</span>
                          )}
                          {plugin?.decisionId && configSource && (
                            <button
                              type="button"
                              disabled={reviewing}
                              onClick={() => {
                                setReviewing(true);
                                setError("");
                                void configSource
                                  .decide("allow", plugin.decisionId ?? "")
                                  .then(
                                    async (next) => {
                                      setConfig(next);
                                      await scan(true);
                                    },
                                    (caught: unknown) => {
                                      setError(message(caught));
                                    },
                                  )
                                  .finally(() => {
                                    setReviewing(false);
                                  });
                              }}
                            >
                              Review…
                            </button>
                          )}
                        </>
                      ) : (
                        <span>Built-in</span>
                      )}
                    </div>
                  </div>
                </>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
