import { useCallback, useEffect, useRef, useState } from "react";
import type { SetupState } from "../../shared/setup";
import type { SoundSettings } from "../../shared/sound";
import type { SetupSource } from "./setup-source.d";

/** Main snapshots with only the pending local sound edit overlaid. */
export function useSetupState(source: Pick<SetupSource, "subscribe">, initial: SetupState) {
  const [state, setState] = useState(initial);
  const pendingSoundRef = useRef<SoundSettings>(undefined);
  const receiveState = useCallback((next: SetupState) => {
    // Persisted snapshots may describe an earlier point in the same drag.
    setState({
      ...next,
      settings: { ...next.settings, sound: pendingSoundRef.current ?? next.settings.sound },
    });
  }, []);
  useEffect(() => source.subscribe(receiveState), [source, receiveState]);
  return { state, setState, receiveState, pendingSoundRef };
}
