import { useSetupState } from "./use-setup-state";
import { useSetupSaves } from "./use-setup-saves";
import { useRepositorySelection } from "./use-repository-selection";
import { usePreflightNavigation } from "./use-preflight-navigation";
import { PreflightSections } from "./preflight-sections";
import { useReadiness } from "./use-readiness";
import type { ComponentProps } from "react";
import {
  ActionError,
  ErrorPresentation,
  BackgroundErrorMark,
  useBackgroundErrors,
} from "../board/error-presentation";
import { SettingsFrame } from "./settings-frame";
import { message } from "./message";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SetupState } from "../../shared/setup";
import type { AgentReport } from "../../shared/workspace";
import { AppearanceControls } from "./appearance-controls";
import { centerStep } from "./center-step";
import { scalePreflight } from "./scale-preflight";
import { LaunchSequence } from "./launch-sequence";

import { STEPS, readyAgents, pollRows } from "./preflight";
import { Wordmark } from "../ui/wordmark";
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
  const setup = useSetupState(source, initial);
  const { state, receiveState } = setup;

  const [report, setReport] = useState<AgentReport>();
  const [scanning, setScanning] = useState(false);
  const { report: reportFailure, clear } = useBackgroundErrors();
  const [error, setError] = useState<string>();
  const [launching, setLaunching] = useState(false);
  const saves = useSetupSaves(source, setup, setError);
  const { save } = saves;
  const selection = useRepositorySelection(source, settingsMode, setError);
  const { repositories, code, applying } = selection;
  const { step, reached, go } = usePreflightNavigation(
    settingsMode,
    initialSection,
    !!onClose,
    state.settings.codeFolder,
    selection,
    setError,
  );
  const readiness = useReadiness(
    source,
    step === 3 || step === 12,
    JSON.stringify([state.settings.forges, state.settings.forgeHosts, repositories]),
  );

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
    return () => {
      live = false;
    };
  }, [source, reportFailure, clear]);
  useEffect(() => {
    // Each step starts at its heading, including the first, so keys reach preflight.
    headingRef.current?.focus();
  }, [step]);

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

  const content = (
    <PreflightSections
      source={source}
      state={state}
      step={step}
      settingsMode={settingsMode}
      headingRef={headingRef}
      go={go}
      receiveState={receiveState}
      readiness={readiness}
      setError={setError}
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
      {...saves}
      {...selection}
    />
  );

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
