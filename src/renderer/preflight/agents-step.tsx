import { PluginSourceIcon } from "./plugin-source-icon";
import { ActionError, useBackgroundErrors } from "../board/error-presentation";
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
  const { report: reportFailure, clear } = useBackgroundErrors();
  const [config, setConfig] = useState<ConfigStatus>();
  const [error, setError] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const configSource = source?.config;
  const configChanged = useEffectEvent((next: ConfigStatus) => {
    setConfig(next);
    clear("agent-catalog");
    void scan(true);
  });
  const refresh = useEffectEvent(() => {
    void scan(true);
  });
  useEffect(() => {
    refresh();
    if (!configSource) return;
    let active = true;
    const receive = (next: ConfigStatus) => {
      if (active) configChanged(next);
    };
    void configSource.status().then(
      (next) => {
        if (active) {
          setConfig(next);
          clear("agent-catalog");
        }
      },
      () => {
        if (active) reportFailure("agent-catalog", "Unable to load agent settings.");
      },
    );
    const dispose = configSource.subscribe(receive);
    return () => {
      active = false;
      dispose();
    };
  }, [configSource, clear, reportFailure]);
  const rejected = (config?.agentPlugins ?? []).filter((plugin) => !builtinAgent(plugin.id));
  const choices = [
    ...agentChoices(report),
    ...rejected.filter((plugin) => !agentChoices(report).some((agent) => agent.id === plugin.id)),
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
        <ActionError
          message={error}
          close={() => {
            setError("");
          }}
        />
      )}
      <div className="agent-cards">
        {choices.map(({ id, name, command }) => {
          const agent = report?.agents.find((entry) => entry.id === id);
          const plugin = rejected.find((entry) => entry.id === id);
          const installed = Boolean(agent?.path);
          const blocked = Boolean(plugin);
          const missing = !installed && !blocked;
          const enabled = installed && !blocked && state.settings.agents[id] !== false;
          const policy = builtinAgent(id);
          const sourceFile = plugin?.file ?? agent?.source;
          const supportsHooks =
            agent?.hooks ||
            Boolean(agent?.setup) ||
            Boolean(policy?.pluginSetup && agent?.agyPlugin);
          const hooks = state.settings.hooks && state.settings.agentHooks?.[id] !== false;
          const how = agent && signal(agent, hooks);
          return (
            <section
              key={id}
              id={`agent-card-${id}`}
              tabIndex={-1}
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
                        : state.settings.agents[id] === false
                          ? "Turned off"
                          : "Version unknown")}
                </span>
                <label className="agent-toggle">
                  {sourceFile && <PluginSourceIcon file={sourceFile} />}
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={name}
                    checked={enabled}
                    disabled={!installed || blocked}
                    onChange={(event) => {
                      save({ agents: { ...state.settings.agents, [id]: event.target.checked } });
                    }}
                  />
                  {enabled ? "On" : "Off"}
                </label>
                <code className="agent-path">{agent?.path ?? command}</code>
              </div>
              {!missing && (
                <>
                  <div className="agent-setting">
                    <span className="agent-label">Attention</span>
                    <div className="agent-inline">
                      {agent?.attentionSignal === false ? (
                        <span>No attention signal</span>
                      ) : (
                        <>
                          {supportsHooks ? (
                            <div className="agent-signals" aria-label={`${name} attention`}>
                              {([true, false] as const).map((enabled) => (
                                <button
                                  key={String(enabled)}
                                  type="button"
                                  aria-pressed={
                                    (state.settings.agentHooks?.[id] !== false) === enabled
                                  }
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
                          {agent?.hookState && (
                            <>
                              <span
                                className={
                                  agent.hookState === "not-reviewed" ||
                                  agent.hookState === "outdated"
                                    ? "agent-needs"
                                    : undefined
                                }
                              >
                                {agent.hookState === "trusted"
                                  ? "Trusted · observed working"
                                  : agent.hookState === "not-reviewed"
                                    ? "Trust review pending"
                                    : agent.hookState === "outdated"
                                      ? "Outdated · review needed"
                                      : "Declined · Notify fallback"}
                              </span>
                              <code>{agent.healthInstructions}</code>
                            </>
                          )}
                        </>
                      )}
                      {installed &&
                        policy?.pluginSetup &&
                        agent?.agyPlugin?.state === "not-installed" &&
                        !state.settings.agyPluginOfferAnswered && <span>Plugin available</span>}
                      {installed && agent?.setup && source?.changeAgentSetup && (
                        <>
                          <span>Plugin · {agent.setup.state}</span>
                          {agent.setup.offer && <span>{agent.setup.offer}</span>}
                          {agent.setup.actions.map((action) => (
                            <button
                              type="button"
                              key={action.id}
                              disabled={reviewing || scanning}
                              onClick={() => {
                                setReviewing(true);
                                setError("");
                                void source
                                  .changeAgentSetup?.(id, action.id)
                                  .then(
                                    async () => {
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
                              {action.label}
                            </button>
                          ))}
                        </>
                      )}
                      {agent?.agyPlugin && (
                        <AgyPluginControl
                          status={agent.agyPlugin}
                          busy={scanning}
                          change={changePlugin}
                        />
                      )}
                    </div>
                  </div>
                  {!blocked && (
                    <div className="agent-setting">
                      <span className="agent-label">Capabilities</span>
                      <div className="agent-capabilities">
                        {[
                          {
                            label: "MCP",
                            available: agent?.mcp,
                            hint: "Foom can orchestrate this agent",
                          },
                          {
                            label: "Resume",
                            available: agent?.resume ?? Boolean(policy),
                            hint: "Reopen past conversations",
                          },
                          {
                            label: "Inline",
                            available: agent?.inline,
                            hint: "Runs in scrollback; wheel scrolls history",
                          },
                        ]
                          .filter((capability) => capability.available)
                          .map(({ label, hint }) => (
                            <span
                              key={label}
                              className="agent-capability"
                              role="group"
                              title={hint}
                              aria-label={hint}
                            >
                              {label}
                            </span>
                          ))}
                      </div>
                    </div>
                  )}
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

                  {plugin && (
                    <p className="preflight-error">
                      <span>Rejected · launch blocked</span>
                      {plugin.reason && (
                        <>
                          {" "}
                          · <span>{plugin.reason}</span>
                        </>
                      )}
                    </p>
                  )}
                </>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
