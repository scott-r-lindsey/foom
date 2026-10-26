import { ForgesSettings } from "./forges-settings";
import { TerminalFontPicker } from "./terminal-font-picker";
import { EnvironmentSettings } from "./environment-settings";
import { InterfaceThemePicker } from "./interface-theme-picker";
import { SoundControls } from "../sound/sound-controls";
import { ConfigControls } from "./config-controls";
import { TerminalThemePicker } from "./terminal-theme-picker";
import { AppearanceControls } from "./appearance-controls";
import { WelcomeStep } from "./welcome-step";
import { AgentsStep } from "./agents-step";
import { RepositoriesStep } from "./repositories-step";
import { WorktreeLocationControls } from "./worktrees-step";
import { ReadinessStep } from "./readiness-step";
import type { ComponentProps, RefObject } from "react";
import type { SetupState } from "../../shared/setup";
import type { SetupSource } from "./setup-source.d";
import type { useSetupSaves } from "./use-setup-saves";
import type { useRepositorySelection } from "./use-repository-selection";
import type { useReadiness } from "./use-readiness";

type SectionProps = Pick<
  ComponentProps<typeof AgentsStep>,
  "report" | "scanning" | "scan" | "changePlugin"
> &
  ReturnType<typeof useSetupSaves> &
  Pick<
    ReturnType<typeof useRepositorySelection>,
    "code" | "repositories" | "codeScanning" | "scanCode" | "selectRepositories"
  > & {
    source: SetupSource;
    state: SetupState;
    step: number;
    settingsMode: boolean;
    headingRef: RefObject<HTMLHeadingElement | null>;
    go: (next: number) => void;
    receiveState: (state: SetupState) => void;
    readiness: ReturnType<typeof useReadiness>;
    setError: (error: string) => void;
  };

export function PreflightSections({
  source,
  state,
  step,
  settingsMode,
  headingRef,
  go,
  receiveState,
  readiness,
  setError,
  report,
  scanning,
  scan,
  changePlugin,
  save,
  saveArguments,
  code,
  repositories,
  codeScanning,
  scanCode,
  selectRepositories,
}: SectionProps) {
  let content;
  if (step === 0) {
    content = <WelcomeStep headingRef={headingRef} go={go} />;
  } else if (step === 1) {
    content = (
      <>
        <AgentsStep
          source={source}
          saveArguments={saveArguments}
          headingRef={headingRef}
          state={state}
          report={report}
          scanning={scanning}
          scan={scan}
          changePlugin={changePlugin}
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
        {navigator.platform.startsWith("Mac") && (
          <label className="check">
            <input
              type="checkbox"
              checked={state.settings.middleClickPaste}
              onChange={(event) => {
                save({ middleClickPaste: event.target.checked });
              }}
            />
            <span>Middle-click pastes selection</span>
          </label>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={state.settings.copyOnSelect}
            onChange={(event) => {
              save({ copyOnSelect: event.target.checked });
            }}
          />
          <span>Copy on select</span>
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
            checked={state.settings.checkForUpdates}
            onChange={(event) => {
              save({ checkForUpdates: event.target.checked });
            }}
          />
          <span>Check for updates</span>
        </label>
        {state.updates?.status === "error" && <p>Could not check for updates.</p>}
        {state.updates?.status === "available" && <p role="status">Update available</p>}
        {state.updates?.status === "downloaded" && (
          <button
            type="button"
            onClick={() => {
              void source.restartToUpdate?.().catch(() => {
                setError("Could not restart Foom.");
              });
            }}
          >
            Restart to update · {state.updates.runningAgents} running{" "}
            {state.updates.runningAgents === 1 ? "agent" : "agents"}
          </button>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={state.settings.showNestedRepositoryNames}
            onChange={(event) => {
              save({ showNestedRepositoryNames: event.target.checked });
            }}
          />
          <span>Show repository paths relative to code folder</span>
        </label>
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
        <label className="check">
          <input
            type="checkbox"
            checked={state.settings.showNewChildren}
            onChange={(event) => {
              save({ showNewChildren: event.target.checked });
            }}
          />
          <span>Show new children on the board</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={state.settings.closeFinishedAgents}
            onChange={(event) => {
              save({ closeFinishedAgents: event.target.checked });
            }}
          />
          <span>Close finished agents</span>
        </label>
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

  return content;
}
