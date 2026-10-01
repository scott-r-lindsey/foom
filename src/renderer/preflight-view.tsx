import { useCallback, useEffect, useRef, useState } from "react";
import type { SetupState } from "../shared/setup";
import type { AgentReport } from "../shared/workspace";
import type { Repository } from "../shared/worktrees";
import { AppearanceControls } from "./appearance-controls";
import { LaunchSequence } from "./launch-sequence";
import { EvaluatorStep, message } from "./preflight-evaluator";
import {
  AGENTS,
  examplePath,
  found,
  pollRows,
  readyAgents,
  signal,
  signalNote,
  SIGNALS,
  STEPS,
  versionNumber,
} from "./preflight";
import { Tooltip } from "./tooltip";
import { defaultSelection, pending, RepositoryPicker } from "./repository-picker";
import type { CodeSelection, Scanning } from "./repository-picker";
import type { SetupSource } from "./setup-source.d";

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
  const [code, setCode] = useState<CodeSelection>();
  const [codeScanning, setCodeScanning] = useState<Scanning>();
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

  /** Scans a folder (null picks one) and preselects what it finds. */
  const scanCode = (folder: string | null) => {
    setCodeScanning({ folder, folders: 0, repositories: 0 });
    source
      .scan(crypto.randomUUID(), folder, (progress) => {
        setCodeScanning({ folder, ...progress });
      })
      .then(
        (result) => {
          if (result) setCode({ scan: result, selected: defaultSelection(result) });
        },
        (caught: unknown) => {
          setError(message(caught));
        },
      )
      .finally(() => {
        setCodeScanning(undefined);
      });
  };
  const move = (next: number) => {
    setStep(next);
    setReached((current) => Math.max(current, next));
    setError(undefined);
    // Arriving at Repositories with a saved folder shows what's in it now.
    if (next === 2 && !code && !codeScanning && state.settings.codeFolder)
      scanCode(state.settings.codeFolder);
  };
  /** Leaving Repositories saves the selection first; a refusal keeps you there. */
  const go = (next: number) => {
    if (step !== 2 || next === 2 || !code || !pending(code, repositories)) {
      move(next);
      return;
    }
    source.apply([...code.selected]).then(
      (update) => {
        setRepositories(update.repositories);
        if (update.failures.length)
          setError(
            update.failures
              .map((failure) => `${failure.path.split(/[\\/]/).at(-1) ?? ""}: ${failure.message}`)
              .join(". "),
          );
        else move(next);
      },
      (caught: unknown) => {
        setError(message(caught));
      },
    );
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
          {/* The accretion ring: light orbiting the button, like the logo's black hole. */}
          <span className="ignite">
            <button
              type="button"
              className="primary"
              onClick={() => {
                go(1);
              }}
            >
              Start preflight
            </button>
          </span>
          <span>Five checks, about a minute</span>
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
                      <span className="badge-value">
                        {versionNumber(agent.version) ?? "unknown"}
                      </span>
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
            : "No agents ready yet · needed to launch",
          2,
        )}
      </>
    );
  } else if (step === 2) {
    const selected = code
      ? code.scan.repositories
          .filter((repo) => code.selected.has(repo.path))
          .map(({ path, name }) => ({ path, name }))
      : repositories;
    content = (
      <>
        <p className="preflight-eyebrow">T-3 · Repositories</p>
        <h2 ref={headingRef} tabIndex={-1}>
          Where do you keep your code?
        </h2>
        <p className="preflight-intro">
          Foom looks for Git repositories there. Ones you've worked in over the last 30 days start
          checked.
        </p>
        <RepositoryPicker
          source={source}
          selection={code}
          added={repositories}
          progress={codeScanning}
          onScan={scanCode}
          onSelection={setCode}
        />
        <p className="preflight-note">
          Somewhere else?{" "}
          <button type="button" className="link" onClick={() => void addRepository()}>
            Add one repository…
          </button>
        </p>
        {nav(
          1,
          selected.length
            ? `${String(selected.length)} ${selected.length === 1 ? "repository" : "repositories"} selected`
            : "None selected yet · needed to launch",
          3,
        )}
      </>
    );
  } else if (step === 3) {
    content = (
      <>
        <p className="preflight-eyebrow">T-2 · Worktrees</p>
        <h2 ref={headingRef} tabIndex={-1}>
          Where should new worktrees go?
        </h2>
        <p className="preflight-intro">
          Every agent works in its own Git worktree, on its own branch, so agents never touch each
          other's files. Choose where Foom creates them.
        </p>
        <fieldset className="preflight-options preflight-split">
          <legend className="visually-hidden">Where new worktrees go</legend>
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
                In <code>{state.worktreeRoot}</code>. Your code folder stays tidy, and Foom can
                clean up merged worktrees in one place.
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
              <small>
                Beside the repository, as <code>app-feat/search</code>. Easier to find in your
                editor and shell history.
              </small>
            </span>
          </label>
        </fieldset>
        <p className="preflight-note">
          A branch named <code>feat/search</code> would land at{" "}
          <code>{examplePath(state, repositories)}</code>
        </p>
        {nav(2, "You can change this any time from Preflight", 4)}
      </>
    );
  } else if (step === 4) {
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
        {nav(3, "You can change this any time from Preflight", 5)}
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
              go(4);
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
