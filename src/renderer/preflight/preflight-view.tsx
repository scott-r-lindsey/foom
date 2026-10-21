import { useReadiness } from "./use-readiness";
import type { ComponentProps } from "react";
import {
  ActionError,
  ErrorPresentation,
  BackgroundErrorMark,
  useBackgroundErrors,
} from "../board/error-presentation";
import { SettingsFrame } from "./settings-frame";
import { ForgesSettings } from "./forges-settings";
import { TerminalFontPicker } from "./terminal-font-picker";
import { message } from "./message";
import { EnvironmentSettings } from "./environment-settings";
import { InterfaceThemePicker } from "./interface-theme-picker";
import { SoundControls } from "../sound/sound-controls";
import { ConfigControls } from "./config-controls";
import { TerminalThemePicker } from "./terminal-theme-picker";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SetupState } from "../../shared/setup";
import type { SoundSettings } from "../../shared/sound";
import type { AgentReport } from "../../shared/workspace";
import type { Repository } from "../../shared/worktrees";
import { AppearanceControls } from "./appearance-controls";
import { centerStep } from "./center-step";
import { scalePreflight } from "./scale-preflight";
import { LaunchSequence } from "./launch-sequence";

import { STEPS, readyAgents, pollRows } from "./preflight";
import { defaultSelection, pending } from "./repository-picker";
import { Wordmark } from "../ui/wordmark";
import { WelcomeStep } from "./welcome-step";
import { AgentsStep } from "./agents-step";
import { RepositoriesStep } from "./repositories-step";
import { WorktreeLocationControls } from "./worktrees-step";
import { ReadinessStep } from "./readiness-step";
import type { CodeSelection, Scanning } from "./repository-picker";
import type { SetupSource } from "./setup-source.d";

/**
 * Shared setup coordinator for the first-run countdown and Settings. After setup,
 * `onClose` opens every step and lets Escape return without launching again.
 */
export function Preflight(props: ComponentProps<typeof PreflightContents>) {
  return (
    <ErrorPresentation>
      <PreflightContents {...props} />
    </ErrorPresentation>
  );
}
function PreflightContents({
  source,
  initial,
  onLaunched,
  onClose,
  settingsMode = false,
  initialSection,
}: {
  source: SetupSource;
  initial: SetupState;
  onLaunched: (state: SetupState) => void;
  onClose?: () => void;
  settingsMode?: boolean;
  initialSection?: "config";
}) {
  const [state, setState] = useState(initial);
  const [step, setStep] = useState(settingsMode ? (initialSection === "config" ? 9 : 1) : 0);
  const [reached, setReached] = useState(onClose ? STEPS.length - 1 : 0);
  const [report, setReport] = useState<AgentReport>();
  const [scanning, setScanning] = useState(false);
  const [repositories, setRepositories] = useState<readonly Repository[]>([]);
  const readiness = useReadiness(
    source,
    step === 3 || step === 12,
    JSON.stringify([state.settings.forges, state.settings.forgeHosts, repositories]),
  );
  const [code, setCode] = useState<CodeSelection>();
  const [codeScanning, setCodeScanning] = useState<Scanning>();
  const { report: reportFailure, clear } = useBackgroundErrors();
  const [error, setError] = useState<string>();
  const [applying, setApplying] = useState(false);
  const [launching, setLaunching] = useState(false);
  const argumentSaveRef = useRef<Promise<void>>(Promise.resolve());
  const pendingSoundRef = useRef<SoundSettings>(undefined);
  const queuedSoundRef = useRef<SoundSettings>(undefined);
  const savingSoundRef = useRef(false);
  useEffect(
    () => () => {
      // Submit the last edit before a reopened Settings view can save newer edits.
      const sound = queuedSoundRef.current;
      queuedSoundRef.current = undefined;
      if (sound) void source.save({ sound }).catch(() => undefined);
    },
    [source],
  );
  const receiveState = useCallback((next: SetupState) => {
    // Persisted snapshots may describe an earlier point in the same drag.
    setState({
      ...next,
      settings: { ...next.settings, sound: pendingSoundRef.current ?? next.settings.sound },
    });
  }, []);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    const stage = stageRef.current;
    const inner = innerRef.current;
    if (viewport && content && stage && inner)
      return scalePreflight(viewport, content, stage, inner);
  }, [settingsMode]);
  useEffect(() => {
    const stage = stageRef.current;
    const inner = innerRef.current;
    if (stage && inner) return centerStep(stage, inner);
  }, [step]);
  useEffect(() => {
    if (!settingsMode) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Native-modal dialogs own Escape until they close.
      if (event.target instanceof Element && event.target.closest("dialog")) return;
      event.preventDefault();
      if (!applying) onClose?.();
    };
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("keydown", escape);
    };
  }, [settingsMode, applying, onClose]);

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
    source.scanAgents(false).then(
      (next) => {
        if (live) {
          setReport(next);
          clear("setup-agents");
        }
      },
      () => {
        if (live) reportFailure("setup-agents", "Unable to load agent settings.");
      },
    );
    source.repositories().then(
      (next) => {
        if (live) {
          setRepositories(next);
          clear("setup-repositories");
        }
      },
      () => {
        if (live) reportFailure("setup-repositories", "Unable to load repositories.");
      },
    );
    return () => {
      live = false;
    };
  }, [source, reportFailure, clear]);
  // A zoom shortcut changes settings in main; keep the controls in step.
  useEffect(() => source.subscribe(receiveState), [source, receiveState]);
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
          if (result)
            setCode({
              scan: result,
              selected: settingsMode
                ? new Set(result.repositories.filter((repo) => repo.added).map((repo) => repo.path))
                : defaultSelection(result),
            });
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
    void applySelection(code).then((ok) => {
      if (ok) move(next);
    });
  };
  const applySelection = async (selection: CodeSelection) => {
    setApplying(true);
    setError(undefined);
    const restoreSelection = (added: readonly Repository[]) => {
      if (settingsMode)
        setCode({
          ...selection,
          selected: new Set(
            selection.scan.repositories
              .filter((repo) => added.some((entry) => entry.path === repo.path))
              .map((repo) => repo.path),
          ),
        });
    };
    try {
      const update = await source.apply([...selection.selected]);
      setRepositories(update.repositories);
      if (update.failures.length) {
        setError(
          update.failures.some(
            (failure) =>
              failure.message === "Git is unavailable. Install Git and recheck on Go / no-go.",
          )
            ? "Git is unavailable. Install Git and recheck on Go / no-go."
            : "Unable to update repositories.",
        );
        restoreSelection(update.repositories);
        return update.failures.every(
          (failure) =>
            failure.message === "Git is unavailable. Install Git and recheck on Go / no-go.",
        );
      }
      return true;
    } catch (caught) {
      setError(message(caught));
      restoreSelection(repositories);
      return false;
    } finally {
      setApplying(false);
    }
  };
  const selectRepositories = (selection: CodeSelection) => {
    setCode(selection);
    if (settingsMode) void applySelection(selection);
  };

  // Keep at most one sound save in flight and one latest edit behind it. The
  // queue drains even when Settings closes, so the final drag position is saved.
  const saveSound = async (sound: SoundSettings) => {
    pendingSoundRef.current = sound;
    queuedSoundRef.current = sound;
    if (savingSoundRef.current) return;
    savingSoundRef.current = true;
    const takeQueued = () => {
      const next = queuedSoundRef.current;
      queuedSoundRef.current = undefined;
      return next;
    };
    let nextSound = takeQueued();
    while (nextSound) {
      let saved: SetupState | undefined;
      try {
        saved = await source.save({ sound: nextSound });
        clear("sound-preferences");
      } catch {
        reportFailure("sound-preferences", "Unable to save sound preferences.");
        saved = await source.state().catch(() => undefined);
      }
      nextSound = takeQueued();
      if (!nextSound) pendingSoundRef.current = undefined;
      if (saved) receiveState(saved);
    }
    savingSoundRef.current = false;
  };

  /** Shows the change at once; if main refuses it, shows main's settings again. */
  const save = (patch: Parameters<SetupSource["save"]>[0]) => {
    setState((current) => ({ ...current, settings: { ...current.settings, ...patch } }));
    if (patch.sound && Object.keys(patch).length === 1) {
      void saveSound(patch.sound);
      return;
    }
    source.save(patch).then(receiveState, (caught: unknown) => {
      setError(message(caught));
      source.state().then(receiveState, () => undefined);
    });
  };
  const launch = async () => {
    try {
      receiveState(
        await source.save({
          setupComplete: true,
          showPullRequests:
            state.settings.showPullRequests ??
            readiness.report?.forges.some((forge) => forge.status === "ready") ??
            false,
        }),
      );
      setLaunching(true);
    } catch (caught) {
      setError(message(caught));
    }
  };

  const nav = (back: number | undefined, why: string, next?: number) =>
    settingsMode ? null : (
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
    content = <WelcomeStep headingRef={headingRef} go={go} />;
  } else if (step === 1) {
    content = (
      <>
        <AgentsStep
          source={source}
          saveArguments={(id, args) => {
            const saving = argumentSaveRef.current
              .catch(() => undefined)
              .then(async () => {
                const latest = await source.state();
                receiveState(
                  await source.save({
                    agentArguments: { ...latest.settings.agentArguments, [id]: args },
                  }),
                );
              });
            argumentSaveRef.current = saving;
            return saving;
          }}
          headingRef={headingRef}
          state={state}
          report={report}
          scanning={scanning}
          scan={scan}
          changePlugin={async (action) => {
            setScanning(true);
            setError("");
            try {
              setReport(await source.changeAgyPlugin(action));
              receiveState(await source.state());
            } catch (caught) {
              setError(message(caught));
            } finally {
              setScanning(false);
            }
          }}
          save={save}
        />
      </>
    );
  } else if (step === 2) {
    content = (
      <>
        <RepositoriesStep
          headingRef={headingRef}
          source={source}
          recentDays={state.settings.recentRepositoryDays}
          onRecentDays={(recentRepositoryDays) => {
            save({ recentRepositoryDays });
          }}
          immediate={settingsMode}
          code={code}
          repositories={repositories}
          codeScanning={codeScanning}
          scanCode={scanCode}
          setCode={selectRepositories}
        />
      </>
    );
  } else if (step === 5) {
    content = (
      <>
        <h2 ref={headingRef} tabIndex={-1}>
          Appearance
        </h2>
        <p className="preflight-intro">
          Choose the light or dark appearance and the size of the interface.
        </p>
        <AppearanceControls settings={state.settings} catalog={state.themes} onChange={save} />
      </>
    );
  } else if (step === 6) {
    content = (
      <>
        <h2 ref={headingRef} tabIndex={-1}>
          Terminal
        </h2>
        <p className="preflight-intro">
          Text size applies to every terminal, independently of interface size.
        </p>
        <TerminalFontPicker source={source} value={state.settings.terminalFont} onChange={save} />
        <label className="terminal-font-size">
          Terminal font size
          <select
            value={state.settings.terminalFontSize}
            onChange={(event) => {
              save({ terminalFontSize: Number(event.target.value) });
            }}
          >
            {Array.from({ length: 23 }, (_, index) => index + 10).map((size) => (
              <option key={size} value={size}>
                {size} px
              </option>
            ))}
          </select>
        </label>
      </>
    );
  } else if (step === 7) {
    content = (
      <>
        <h2 ref={headingRef} tabIndex={-1}>
          Themes
        </h2>
        <h3>Interface theme</h3>
        <InterfaceThemePicker
          settings={state.settings}
          catalog={state.themes}
          openFolder={() => source.openThemesFolder("theme")}
          onChange={save}
        />
        <h3>Terminal theme</h3>
        <TerminalThemePicker
          settings={state.settings}
          catalog={state.themes}
          openFolder={() => source.openThemesFolder("terminal-theme")}
          onChange={save}
        />
      </>
    );
  } else if (step === 10 && settingsMode && source.environment) {
    content = (
      <EnvironmentSettings
        source={source.environment}
        headingRef={headingRef}
        onAgents={() => {
          go(1);
        }}
      />
    );
  } else if (step === 9 && source.config) {
    content = (
      <>
        <h2 ref={headingRef} tabIndex={-1}>
          Foom config
        </h2>
        <p className="preflight-intro">
          The Foom config folder contains plain files that Foom watches and validates. Edit them
          yourself, or launch an agent from the sidebar’s Foom config entry and ask it for changes.
          Invalid files are rejected and the last good version stays.
        </p>
        <ConfigControls config={source.config} />
      </>
    );
  } else if (step === 12) {
    content = (
      <ForgesSettings
        headingRef={headingRef}
        settings={state.settings}
        source={source}
        readiness={readiness}
        save={async (patch) => {
          receiveState(await source.save(patch));
        }}
      />
    );
  } else if (step === 11) {
    content = (
      <>
        <h2 ref={headingRef} tabIndex={-1}>
          General
        </h2>
        <WorktreeLocationControls state={state} repositories={repositories} save={save} />
        <label className="check">
          <input
            type="checkbox"
            checked={state.settings.restoreSessions}
            onChange={(event) => {
              save({ restoreSessions: event.target.checked });
            }}
          />
          <span>Restore sessions on launch</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={state.settings.autoRemoveMergedWorktrees}
            onChange={(event) => {
              save({ autoRemoveMergedWorktrees: event.target.checked });
            }}
          />
          <span>Auto-remove merged worktrees</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={state.settings.showPullRequests ?? false}
            onChange={(event) => {
              save({ showPullRequests: event.target.checked });
            }}
          />
          <span>Show pull requests and checks</span>
        </label>
        <p>
          Foom uses your selected forge CLI and its existing login to read PR or merge request and
          CI metadata. It sends repository/project, branch and PR/MR identifiers in read-only status
          requests. Foom does not send terminal content, store forge tokens, change CLI
          login/configuration, or write to the forge.
        </p>
        <label className="concurrent-children">
          Concurrent children per orchestrator
          <input
            type="number"
            min={1}
            max={16}
            step={1}
            value={state.settings.concurrentChildren}
            onChange={(event) => {
              if (event.target.validity.valid && event.target.value !== "")
                save({ concurrentChildren: Number(event.target.value) });
            }}
          />
        </label>
        <label className="concurrent-children">
          Unread child reminder (minutes; 0 turns off)
          <input
            type="number"
            min={0}
            max={1440}
            step={1}
            value={state.settings.unreadChildMinutes}
            onChange={(event) => {
              if (event.target.validity.valid && event.target.value !== "")
                save({ unreadChildMinutes: Number(event.target.value) });
            }}
          />
        </label>
      </>
    );
  } else if (step === 8) {
    content = (
      <>
        <h2 ref={headingRef} tabIndex={-1}>
          Sound
        </h2>
        <SoundControls settings={state.settings.sound} onChange={save} />
      </>
    );
  } else {
    content = (
      <ReadinessStep
        headingRef={headingRef}
        state={state}
        report={report}
        repositories={repositories}
        go={go}
        readiness={readiness}
      />
    );
  }

  const ready = readyAgents(report, state).length;
  const selected = code
    ? code.scan.repositories.filter((repo) => code.selected.has(repo.path)).length
    : repositories.length;
  const navigation =
    step === 1 ? (
      nav(
        0,
        ready
          ? `${String(ready)} ${ready === 1 ? "agent" : "agents"} ready`
          : "No agents ready yet · needed to launch",
        2,
      )
    ) : step === 2 ? (
      nav(
        1,
        selected
          ? `${String(selected)} ${selected === 1 ? "repository" : "repositories"} selected`
          : "None selected yet · needed to launch",
        3,
      )
    ) : step === 3 ? (
      <div className="preflight-nav">
        <button
          type="button"
          onClick={() => {
            go(2);
          }}
        >
          Back
        </button>
        <span />
        <button
          type="button"
          className="primary"
          disabled={
            !pollRows(state, report, repositories).every((row) => row.go) ||
            readiness.report?.git !== "ready" ||
            readiness.busy
          }
          onClick={() => void launch()}
        >
          Launch
        </button>
      </div>
    ) : step === 12 && !settingsMode ? (
      <div className="preflight-nav">
        <button
          type="button"
          onClick={() => {
            go(3);
          }}
        >
          Back to Go / no-go
        </button>
      </div>
    ) : null;

  if (settingsMode)
    return (
      <SettingsFrame
        source={source}
        step={step}
        applying={applying}
        onClose={onClose}
        go={go}
        error={error}
        dismissError={() => {
          setError(undefined);
        }}
      >
        {content}
      </SettingsFrame>
    );

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
                aria-label={`${entry.t} ${entry.label}`}
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
          <BackgroundErrorMark />
          <AppearanceControls settings={state.settings} catalog={state.themes} onChange={save} />
          {onClose && (
            <button type="button" className="preflight-close" onClick={onClose}>
              Back to board · Esc
            </button>
          )}
        </div>
      </nav>
      <main className="preflight-viewport" aria-label="Preflight" ref={viewportRef}>
        <div className="preflight-content" ref={contentRef}>
          <div className="preflight-stage" ref={stageRef}>
            <div className="preflight-inner" ref={innerRef}>
              {content}
              {error && (
                <ActionError
                  message={error}
                  close={() => {
                    setError(undefined);
                  }}
                />
              )}
            </div>
          </div>
          {navigation && <footer className="preflight-footer">{navigation}</footer>}
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
