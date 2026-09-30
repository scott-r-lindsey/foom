import { useCallback, useEffect, useRef, useState } from "react";
import type { SetupState } from "../shared/setup";
import type { AgentReport } from "../shared/workspace";
import type { Repository } from "../shared/worktrees";
import { AppearanceControls } from "./appearance-controls";
import { LaunchSequence } from "./launch-sequence";
import { EvaluatorStep, message } from "./preflight-evaluator";
import { AGENTS, examplePath, found, pollRows, readyAgents, signal, STEPS } from "./preflight";
import type { SetupSource } from "./setup-source.d";

const SIGNAL_LABEL = { hooks: "Hooks", notify: "Notify", evaluator: "Evaluator" } as const;

function Wordmark() {
  return (
    <span className="wordmark" role="img" aria-label="foom">
      <span aria-hidden="true">
        fo
        <span className="wordmark-hole" />m
      </span>
    </span>
  );
}

/**
 * The first-run countdown. `onClose` is present when setup already ran once: every
 * step is then open, and Esc returns to the board without launching again.
 */
export function Preflight({
  source,
  initial,
  onLaunched,
  onClose,
}: {
  source: SetupSource;
  initial: SetupState;
  onLaunched: (state: SetupState) => void;
  onClose?: () => void;
}) {
  const [state, setState] = useState(initial);
  const [step, setStep] = useState(0);
  const [reached, setReached] = useState(onClose ? STEPS.length - 1 : 0);
  const [report, setReport] = useState<AgentReport>();
  const [scanning, setScanning] = useState(false);
  const [repositories, setRepositories] = useState<readonly Repository[]>([]);
  const [error, setError] = useState<string>();
  const [launching, setLaunching] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const scan = useCallback(
    async (refresh: boolean) => {
      setScanning(true);
      try {
        setReport(await source.scanAgents(refresh));
      } catch (caught) {
        setError(message(caught));
      } finally {
        setScanning(false);
      }
    },
    [source],
  );
  useEffect(() => {
    // Until the first scan answers, every agent shows as "Looking…".
    let live = true;
    const failed = (caught: unknown) => {
      if (live) setError(message(caught));
    };
    source.scanAgents(false).then((next) => {
      if (live) setReport(next);
    }, failed);
    source.repositories().then((next) => {
      if (live) setRepositories(next);
    }, failed);
    return () => {
      live = false;
    };
  }, [source]);
  // A zoom shortcut changes settings in main; keep the controls in step.
  useEffect(() => source.subscribe(setState), [source]);
  useEffect(() => {
    // Each step starts at its heading, including the first, so keys reach preflight.
    headingRef.current?.focus();
  }, [step]);

  const go = (next: number) => {
    setStep(next);
    setReached((current) => Math.max(current, next));
    setError(undefined);
  };
  /** Shows the change at once; if main refuses it, shows main's settings again. */
  const save = (patch: Parameters<SetupSource["save"]>[0]) => {
    setState((current) => ({ ...current, settings: { ...current.settings, ...patch } }));
    source.save(patch).then(setState, (caught: unknown) => {
      setError(message(caught));
      source.state().then(setState, () => undefined);
    });
  };
  const addRepository = async () => {
    try {
      const added = await source.addRepository();
      if (added) setRepositories(await source.repositories());
    } catch (caught) {
      setError(message(caught));
    }
  };
  const launch = async () => {
    try {
      setState(await source.save({ setupComplete: true }));
      setLaunching(true);
    } catch (caught) {
      setError(message(caught));
    }
  };

  const ready = readyAgents(report, state);
  const rows = pollRows(state, report, repositories);
  const allGo = rows.every((row) => row.go);
  const nav = (back: number | undefined, why: string, next?: number) => (
    <div className="preflight-nav">
      {back === undefined ? (
        <span />
      ) : (
        <button
          type="button"
          onClick={() => {
            go(back);
          }}
        >
          Back
        </button>
      )}
      <span className="preflight-why">{why}</span>
      {next !== undefined && (
        <button
          type="button"
          className="primary"
          onClick={() => {
            go(next);
          }}
        >
          Continue
        </button>
      )}
    </div>
  );

  let content;
  if (step === 0) {
    content = (
      <div className="preflight-welcome">
        <h1 ref={headingRef} tabIndex={-1}>
          <Wordmark />
        </h1>
        <p className="preflight-lede">Run ten agents. Hear only from the ones that need you.</p>
        <p>
          Every agent gets its own worktree and its own terminal. Terminals stay hidden behind a
          light. When one goes quiet, Foom works out whether it's done, stuck, or asking you
          something.
        </p>
        <div className="preflight-cta">
          <button
            type="button"
            className="primary"
            onClick={() => {
              go(1);
            }}
          >
            Start preflight
          </button>
          <span>Four checks, about a minute</span>
        </div>
        <dl className="preflight-facts">
          <div>
            <dt>Worktrees, not branches</dt>
            <dd>Agents never step on each other's files.</dd>
          </div>
          <div>
            <dt>Lights, not tabs</dt>
            <dd>Brightness follows output. Amber means you're needed.</dd>
          </div>
          <div>
            <dt>Hooks first</dt>
            <dd>Agents that can report their own state do. The evaluator covers the rest.</dd>
          </div>
        </dl>
      </div>
    );
  } else if (step === 1) {
    content = (
      <>
        <p className="preflight-eyebrow">T-3 · Agents</p>
        <h2 ref={headingRef} tabIndex={-1}>
          Which agents do you run?
        </h2>
        <p className="preflight-intro">
          Foom checks your PATH and picks the most reliable way each agent can tell you it needs
          attention.
        </p>
        {report?.warning && <p className="preflight-warning">{report.warning}</p>}
        <ul className="preflight-list">
          {AGENTS.map(({ id, name, command, signal: detail }) => {
            const agent = found(report, id);
            const how = agent && signal(agent, state.settings.hooks);
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
                <label htmlFor={`agent-${id}`} className="preflight-name">
                  {name} <code>{command}</code>
                </label>
                <span
                  className="preflight-found"
                  data-found={agent ? "yes" : report ? "no" : "scanning"}
                >
                  {agent ? "Found" : scanning || !report ? "Looking…" : "Not found"}
                </span>
                <p className="preflight-sub">
                  {agent ? (
                    <>
                      <code>{agent.version ?? "unknown version"}</code> at <code>{agent.path}</code>
                    </>
                  ) : report && !scanning ? (
                    <>
                      <code>{command}</code> isn't on your PATH. Install it, then scan again.
                    </>
                  ) : (
                    <>
                      Checking your PATH for <code>{command}</code>
                    </>
                  )}
                </p>
                {agent && how && (
                  <p className="preflight-signal">
                    <span className="preflight-tag">{SIGNAL_LABEL[how]}</span>
                    {how === "evaluator" && state.settings.hooks ? agent.reason : detail}
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
              Passed per launch (<code>claude --settings</code>, <code>codex -c notify=…</code>).
              Your own config files are never edited. Turn this off and every agent falls back to
              the evaluator.
            </small>
          </span>
        </label>
        {nav(
          0,
          ready.length
            ? `${String(ready.length)} ${ready.length === 1 ? "agent" : "agents"} ready`
            : "No agents ready yet",
          2,
        )}
      </>
    );
  } else if (step === 2) {
    content = (
      <>
        <p className="preflight-eyebrow">T-2 · Repositories</p>
        <h2 ref={headingRef} tabIndex={-1}>
          Where do your repos live?
        </h2>
        <p className="preflight-intro">
          Add the repositories you'll start agents in. You can add more any time.
        </p>
        <ul className="preflight-list">
          {repositories.map((repository) => (
            <li key={repository.path} className="preflight-item plain">
              <span className="preflight-name mono">{repository.name}</span>
              <p className="preflight-sub">
                <code>{repository.path}</code>
              </p>
            </li>
          ))}
          {repositories.length === 0 && <li className="preflight-empty">No repositories yet.</li>}
        </ul>
        <button type="button" onClick={() => void addRepository()}>
          Add repository…
        </button>
        <fieldset className="preflight-options">
          <legend>Where new worktrees go</legend>
          <label className="preflight-option">
            <input
              type="radio"
              name="worktrees"
              checked={state.settings.worktreeLocation === "root"}
              onChange={() => {
                save({ worktreeLocation: "root" });
              }}
            />
            <span>
              <b>
                Keep worktrees in Foom's folder <span className="preflight-rec">Recommended</span>
              </b>
              <small>
                Your code folder stays tidy, and Foom can clean up merged worktrees in one place.
              </small>
            </span>
          </label>
          <label className="preflight-option">
            <input
              type="radio"
              name="worktrees"
              checked={state.settings.worktreeLocation === "adjacent"}
              onChange={() => {
                save({ worktreeLocation: "adjacent" });
              }}
            />
            <span>
              <b>Put them next to each repository</b>
              <small>Easier to find in your editor and shell history.</small>
            </span>
          </label>
        </fieldset>
        <p className="preflight-note">
          A branch named <code>feat/search</code> would land at{" "}
          <code>{examplePath(state, repositories)}</code>
        </p>
        {nav(
          1,
          repositories.length
            ? `${String(repositories.length)} ${repositories.length === 1 ? "repository" : "repositories"}`
            : "Add at least one repository",
          3,
        )}
      </>
    );
  } else if (step === 3) {
    content = (
      <>
        <p className="preflight-eyebrow">T-1 · Evaluator</p>
        <h2 ref={headingRef} tabIndex={-1}>
          How should Foom read a terminal that goes quiet?
        </h2>
        <p className="preflight-intro">
          Hooks and simple rules handle most cases. When output is ambiguous, like an agent asking a
          question in plain prose, Foom can ask a model. Pick where that model runs.
        </p>
        <EvaluatorStep state={state} source={source} onState={setState} />
        {nav(2, "You can change this any time from Preflight", 4)}
      </>
    );
  } else {
    content = (
      <>
        <p className="preflight-eyebrow">T-0 · Go / no-go</p>
        <h2 ref={headingRef} tabIndex={-1}>
          {allGo ? "All stations go." : "Hold. Something needs fixing."}
        </h2>
        <p className="preflight-intro">
          {allGo
            ? "Everything checks out. Launch to open your board."
            : "Fix the no-go items below. Each one links back to its step."}
        </p>
        <ul className="preflight-poll">
          {rows.map((row) => (
            <li key={row.system} data-go={row.go}>
              <span className="preflight-system">{row.system}</span>
              <span className="preflight-detail">
                {row.detail}
                {!row.go && (
                  <>
                    {" · "}
                    <button
                      type="button"
                      className="link"
                      onClick={() => {
                        go(row.step);
                      }}
                    >
                      Fix
                    </button>
                  </>
                )}
              </span>
              <span className="preflight-pill">{row.go ? "GO" : "NO-GO"}</span>
            </li>
          ))}
        </ul>
        <div className="preflight-nav">
          <button
            type="button"
            onClick={() => {
              go(3);
            }}
          >
            Back
          </button>
          <span />
          <button type="button" className="primary" disabled={!allGo} onClick={() => void launch()}>
            Launch
          </button>
        </div>
      </>
    );
  }

  return (
    <div
      className="preflight"
      onKeyDown={(event) => {
        if (event.key === "Escape" && onClose && !launching) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <nav className="preflight-rail" aria-label="Preflight steps">
        <p className="preflight-brand">
          <Wordmark />
        </p>
        <ol>
          {STEPS.map((entry, index) => (
            <li key={entry.label}>
              <button
                type="button"
                aria-current={index === step ? "step" : undefined}
                data-done={index < reached && index !== step}
                disabled={index > reached}
                onClick={() => {
                  go(index);
                }}
              >
                <span className="preflight-t">{entry.t}</span>
                <span>{entry.label}</span>
                <span className="preflight-tick" aria-hidden="true">
                  {index < reached && index !== step ? "✓" : ""}
                </span>
              </button>
            </li>
          ))}
        </ol>
        <div className="preflight-rail-foot">
          <AppearanceControls settings={state.settings} onChange={save} />
          {onClose && (
            <button type="button" className="preflight-close" onClick={onClose}>
              Back to board · Esc
            </button>
          )}
        </div>
      </nav>
      <main className="preflight-stage" aria-label="Preflight">
        <div className="preflight-inner">
          {content}
          {error && (
            <p className="preflight-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </main>
      {launching && (
        <LaunchSequence
          onDone={() => {
            onLaunched(state);
          }}
        />
      )}
    </div>
  );
}
