import { attachInterfaceTheme } from "./ui/interface-theme";
import { useEffect, useState } from "react";
import type { SetupState } from "../shared/setup";
import { Board } from "./board/board-view";
import { createSampleSource } from "./board/sample-board-source";
import { createAppSource } from "./board/live-board-source";
import { Preflight } from "./preflight/preflight-view";
import { createSetupSource } from "./preflight/setup-source";

/**
 * Preflight runs until setup is complete, and again whenever the board asks for it.
 * Once mounted, the board stays mounted underneath so its shell keeps running.
 */
export function App() {
  const [source] = useState(() =>
    typeof FOOM_SAMPLE_BOARD !== "undefined" && FOOM_SAMPLE_BOARD
      ? createSampleSource()
      : createAppSource(),
  );
  const [setup] = useState(createSetupSource);
  useEffect(() => attachInterfaceTheme(setup), [setup]);
  const [state, setState] = useState<SetupState>();
  const [preflight, setPreflight] = useState(false);
  const [settings, setSettings] = useState(false);
  const [board, setBoard] = useState(false);
  useEffect(() => {
    setup.state().then(
      (initial) => {
        setState(initial);
        if (initial.settings.setupComplete) setBoard(true);
        else setPreflight(true);
      },
      (error: unknown) => {
        // Settings are unreadable: the board still works with defaults.
        console.error("Unable to load setup:", error);
        setBoard(true);
      },
    );
  }, [setup]);
  const reopen = async (showSettings = false) => {
    try {
      setState(await setup.state());
      setPreflight(!showSettings);
      setSettings(showSettings);
    } catch (error) {
      console.error("Unable to load setup:", error);
    }
  };
  return (
    <>
      {preflight && state && (
        <Preflight
          source={setup}
          initial={state}
          onLaunched={(next) => {
            setState(next);
            setPreflight(false);
            setBoard(true);
          }}
          {...(state.settings.setupComplete
            ? {
                onClose: () => {
                  setPreflight(false);
                },
              }
            : {})}
        />
      )}
      {board && (
        <Board
          source={source}
          inactive={preflight}
          onPreflight={() => void reopen()}
          onSettings={() => {
            if (!settings) void reopen(true);
          }}
          onCloseSettings={() => {
            setSettings(false);
          }}
          settingsView={
            settings && state ? (
              <Preflight
                source={setup}
                initial={state}
                settingsMode
                onLaunched={setState}
                onClose={() => {
                  setSettings(false);
                }}
              />
            ) : undefined
          }
        />
      )}
    </>
  );
}
