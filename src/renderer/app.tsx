import { attachInterfaceTheme } from "./ui/interface-theme";
import { useEffect, useState } from "react";
import type { SetupState } from "../shared/setup";
import { Board } from "./board/board-view";
import { createSampleSource } from "./board/sample-board-source";
import { createAppSource } from "./board/live-board-source";
import { Preflight } from "./preflight/preflight-view";
import { createSetupSource } from "./preflight/setup-source";

/**
 * Preflight runs until setup is complete; later changes live in Settings.
 * Once mounted, the board stays mounted underneath so its shell keeps running.
 */
export function App() {
  const [source] = useState(() =>
    typeof FOOM_SAMPLE_BOARD !== "undefined" && FOOM_SAMPLE_BOARD
      ? createSampleSource()
      : createAppSource(),
  );
  const [scrim, setScrim] = useState(false);
  useEffect(() => source.confirmations?.onScrim?.(setScrim), [source]);
  const [setup] = useState(createSetupSource);
  useEffect(() => attachInterfaceTheme(setup), [setup]);
  const [state, setState] = useState<SetupState>();
  const [preflight, setPreflight] = useState(false);
  const [settings, setSettings] = useState(false);
  const [section, setSection] = useState<{ name?: "config"; version: number }>({ version: 0 });
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
  const reopen = async (name?: "config") => {
    setSection((current) => ({ ...(name ? { name } : {}), version: current.version + 1 }));
    try {
      setState(await setup.state());
      setSettings(true);
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
        />
      )}
      {board && (
        <Board
          source={source}
          soundSetup={setup}
          inactive={preflight}
          onSettings={(name) => {
            if (!settings || name) void reopen(name);
          }}
          onCloseSettings={() => {
            setSettings(false);
          }}
          settingsView={
            settings && state ? (
              <Preflight
                key={section.version}
                source={setup}
                initial={state}
                settingsMode
                {...(section.name ? { initialSection: section.name } : {})}
                onLaunched={setState}
                onClose={() => {
                  setSettings(false);
                }}
              />
            ) : undefined
          }
        />
      )}
      {scrim && (
        <div
          className="board-confirmation-scrim"
          aria-hidden="true"
          popover="manual"
          ref={(element) => {
            element?.showPopover();
          }}
        />
      )}
    </>
  );
}
