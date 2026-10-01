import { useEffect, useState } from "react";
import type { SetupState } from "../shared/setup";
import { Board } from "./board-view";
import { createSampleSource } from "./board-source";
import { createAppSource } from "./app-source";
import { Preflight } from "./preflight-view";
import { createSetupSource } from "./setup-source";

/**
 * Preflight runs until setup is complete, and again whenever the board asks for it.
 * Once mounted, the board stays mounted underneath so its shell keeps running.
 */
export function Shell() {
  const [source] = useState(() =>
    typeof FOOM_SAMPLE_BOARD !== "undefined" && FOOM_SAMPLE_BOARD
      ? createSampleSource()
      : createAppSource(),
  );
  const [setup] = useState(createSetupSource);
  const [state, setState] = useState<SetupState>();
  const [preflight, setPreflight] = useState(false);
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
  const reopen = async () => {
    try {
      setState(await setup.state());
      setPreflight(true);
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
      {board && <Board source={source} inactive={preflight} onPreflight={() => void reopen()} />}
    </>
  );
}
