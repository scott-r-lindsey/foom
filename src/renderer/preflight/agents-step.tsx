import { AgentStatus } from "./agent-status";
import { AgentReload } from "./agent-reload";
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
  machine = false,
  actionsDisabled = false,
  receiptEpoch = 0,
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
    machine?: boolean;
    actionsDisabled?: boolean;
    receiptEpoch?: number;
    changePlugin: (action: AgyPluginAction) => Promise<void>;
    state: SetupState;
    report: AgentReport | undefined;
    scanning: boolean;
    scan: (refresh: boolean, agent?: string) => Promise<void>;
    source?: SetupSource | undefined;
    saveArguments: (id: string, args: readonly string[]) => Promise<void>;
  }) {
  const { report: reportFailure, clear } = useBackgroundErrors();
  const [config, setConfig] = useState<ConfigStatus>();
  const [error, setError] = useState("");
  const [results, setResults] = useState<Readonly<Record<string, { text: string; epoch: number }>>>(
    {},
  );
  const [reviewing, setReviewing] = useState(false);
  const configSource = source?.config;
  const configChanged = useEffectEvent((next: ConfigStatus) => {
    setConfig(next);
    clear("agent-catalog");
    if (!machine) void scan(true);
  });
  useEffect(() => {
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
      {!machine && (
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
      )}
      {!machine && (
        <div className="agent-scope-bar">
          <span>
            {report?.checkedAt
              ? `Last checked ${new Date(report.checkedAt).toLocaleString()}`
              : "Not checked"}
          </span>
          <AgentReload
            name="This computer"
            busy={scanning}
            reload={() => {
              setResults({});
              void scan(true);
            }}
          />
        </div>
      )}
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
        {choices
          .filter(({ id }) => !machine || state.settings.agents[id] !== false)
          .map(({ id, name, command }) => {
            const receipt = results[id];
            const setupResult = receipt?.epoch === receiptEpoch ? receipt.text : undefined;
            const agent = report?.agents.find((entry) => entry.id === id);
            const plugin = rejected.find((entry) => entry.id === id);
            const installed = Boolean(agent?.path);
            const blocked = Boolean(plugin);
            const missing = !installed && !blocked;
            const enabled = installed && !blocked && state.settings.agents[id] !== false;
            const policy = builtinAgent(id);
            const sourceFile = plugin?.file ?? agent?.source;
            const capabilities = [
              { label: "MCP", available: agent?.mcp, hint: "Foom can orchestrate this agent" },
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
            ].filter((capability) => capability.available);
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
                    mark={
                      agent?.mark ?? plugin?.mark ?? policy?.mark ?? id.slice(0, 2).toUpperCase()
                    }
                  />
                  <h3>{name}</h3>
                  <span
                    className={`agent-version${machine && missing ? " agent-missing-status" : ""}`}
                  >
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
                  <AgentReload
                    name={name}
                    busy={scanning}
                    disabled={actionsDisabled}
                    reload={() => {
                      setResults((current) =>
                        Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)),
                      );
                      void scan(true, id);
                    }}
                  />
                  <div className="agent-card-controls">
                    {sourceFile && <PluginSourceIcon file={sourceFile} />}
                    {!machine && (
                      <label className="agent-toggle">
                        <input
                          type="checkbox"
                          role="switch"
                          aria-label={name}
                          checked={enabled}
                          disabled={!installed || blocked}
                          onChange={(event) => {
                            save({
                              agents: { ...state.settings.agents, [id]: event.target.checked },
                            });
                          }}
                        />
                        {enabled ? "On" : "Off"}
                      </label>
                    )}
                  </div>
                  <code className="agent-path">{agent?.path ?? command}</code>
                </div>
                {machine && installed && (
                  <div className="agent-setting">
                    <span className="agent-label">Sign-in</span>
                    <AgentStatus text="Sign-in unknown" />
                  </div>
                )}
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
                            <span>
                              Plugin ·{" "}
                              {agent.setup.state === "unavailable"
                                ? "Status unavailable"
                                : agent.setup.state}
                            </span>
                            {agent.setup.state === "unavailable" && (
                              <button
                                type="button"
                                disabled={actionsDisabled || reviewing || scanning}
                                onClick={() => {
                                  setResults({});
                                  void scan(true);
                                }}
                              >
                                Retry status
                              </button>
                            )}
                            {setupResult && (
                              <span
                                className="agent-setup-result"
                                role="status"
                                title={setupResult}
                              >
                                {setupResult}
                              </span>
                            )}
                            {agent.setup.offer && <span>{agent.setup.offer}</span>}
                            {agent.setup.actions.map((action) => (
                              <button
                                type="button"
                                key={action.id}
                                disabled={actionsDisabled || reviewing || scanning}
                                onClick={() => {
                                  setReviewing(true);
                                  setError("");
                                  void source
                                    .changeAgentSetup?.(id, action.id)
                                    .then(
                                      async (updated) => {
                                        const result = updated.agents.find(
                                          (agent) => agent.id === id,
                                        )?.setup?.result;
                                        if (result)
                                          setResults((current) => ({
                                            ...current,
                                            [id]: { text: result, epoch: receiptEpoch },
                                          }));
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
                            busy={actionsDisabled || scanning}
                            change={changePlugin}
                          />
                        )}
                      </div>
                    </div>
                    {!blocked && capabilities.length > 0 && (
                      <div className="agent-setting">
                        <span className="agent-label">Capabilities</span>
                        <div className="agent-capabilities">
                          {capabilities.map(({ label, hint }) => (
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
                    {!machine && (
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
                      </>
                    )}

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
