import type { SetupState } from "../../shared/setup";
import type { AgentReport } from "../../shared/workspace";
import type { StepHeading, StepActions } from "./preflight-step.d";
import { Tooltip } from "../ui/tooltip";
import {
  AGENTS,
  found,
  readyAgents,
  signal,
  signalNote,
  SIGNALS,
  versionNumber,
} from "./preflight";

const SIGNAL_LABEL = { hooks: "Hooks", notify: "Notify", evaluator: "Evaluator" } as const;

/** A path that wraps after a separator, not mid-name. */
function Path({ path }: { path: string }) {
  // Each part is keyed by the path up to its end, which is unique even when names repeat.
  const parts = path
    .split(/(?<=[\\/])/)
    .map((part, index, all) => ({ part, key: all.slice(0, index + 1).join("") }));
  return (
    <code>
      {parts.map(({ part, key }) => (
        <span key={key}>
          {part}
          <wbr />
        </span>
      ))}
    </code>
  );
}

/** An agent's command as you'd type it. */
function Command({ command }: { command: string }) {
  return (
    <code className="agent-command">
      <span aria-hidden="true">$ </span>
      {command}
    </code>
  );
}

export function AgentsStep({
  headingRef,
  state,
  report,
  scanning,
  scan,
  save,
  nav,
}: StepHeading &
  StepActions & {
    state: SetupState;
    report: AgentReport | undefined;
    scanning: boolean;
    scan: (refresh: boolean) => Promise<void>;
  }) {
  const ready = readyAgents(report, state);

  return (
    <>
      <p className="preflight-eyebrow">T-4 · Agents</p>
      <h2 ref={headingRef} tabIndex={-1}>
        Which agents do you run?
      </h2>
      <p className="preflight-intro">
        Foom checks your PATH and picks the most reliable way each agent can tell you it needs
        attention.
      </p>
      {report?.warning && <p className="preflight-warning">{report.warning}</p>}
      <ul className="preflight-list agent-grid">
        {AGENTS.map(({ id, name, command }) => {
          const agent = found(report, id);
          const how = agent && signal(agent, state.settings.hooks);
          const note = agent && signalNote(agent, state.settings.hooks);
          return (
            <li key={id} className="preflight-item">
              <input
                type="checkbox"
                id={`agent-${id}`}
                checked={Boolean(agent) && state.settings.agents[id]}
                disabled={!agent}
                onChange={(event) => {
                  save({ agents: { ...state.settings.agents, [id]: event.target.checked } });
                }}
              />
              <span className="agent-title">
                <label htmlFor={`agent-${id}`} className="preflight-name">
                  {name}
                </label>
                {agent ? (
                  <Tooltip className="chip" label={<Command command={command} />}>
                    <span className="tip-path">
                      Found at <Path path={agent.path} />
                    </span>
                    {agent.version && (
                      <span className="tip-path">
                        Reports <code>{agent.version}</code>
                      </span>
                    )}
                  </Tooltip>
                ) : (
                  <Command command={command} />
                )}
              </span>
              <span
                className="preflight-found"
                data-found={agent ? "yes" : report ? "no" : "scanning"}
              >
                {agent ? "Found" : scanning || !report ? "Looking…" : "Not found"}
              </span>
              {agent && how ? (
                <div className="agent-meta">
                  <span className="badge" data-known={String(Boolean(agent.version))}>
                    <span className="badge-label">Version</span>
                    <span className="badge-value">{versionNumber(agent.version) ?? "unknown"}</span>
                  </span>
                  <Tooltip className="chip chip-signal" label={SIGNAL_LABEL[how]}>
                    {SIGNALS[how]}
                    {note && <span>{note}</span>}
                  </Tooltip>
                </div>
              ) : (
                <p className="preflight-sub">
                  {report && !scanning ? "Not on your PATH." : "Checking your PATH…"}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        disabled={scanning}
        onClick={() => {
          void scan(true);
        }}
      >
        {scanning ? "Scanning…" : "Scan again"}
      </button>
      <label className="preflight-check">
        <input
          type="checkbox"
          checked={state.settings.hooks}
          onChange={(event) => {
            save({ hooks: event.target.checked });
          }}
        />
        <span>
          <b>Attach Foom's hooks when it launches an agent</b>
          <small>
            Passed per launch (<code>claude --settings</code>, <code>codex -c notify=…</code>). Your
            own config files are never edited. Turn this off and every agent falls back to the
            evaluator.
          </small>
        </span>
      </label>
      {nav(
        0,
        ready.length
          ? `${String(ready.length)} ${ready.length === 1 ? "agent" : "agents"} ready`
          : "No agents ready yet · needed to launch",
        2,
      )}
    </>
  );
}
