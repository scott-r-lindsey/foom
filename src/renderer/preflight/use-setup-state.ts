import { useSettingsView } from "../data/view-hooks";
import { useCallback, useEffect, useRef, useState, useLayoutEffect } from "react";
import type { SetupState } from "../../shared/setup";
import type { Dispatch, SetStateAction } from "react";
import type { SoundSettings } from "../../shared/sound";
import type { SetupSource } from "./setup-source.d";

/** Main snapshots with only the pending local sound edit overlaid. */
export function useSetupState(
  source: Pick<SetupSource, "subscribe" | "views" | "state">,
  initial: SetupState,
) {
  const query = useSettingsView(source, source.state.bind(source), initial);
  const persisted = query.data ?? initial;
  const [soundDraft, setSoundDraft] = useState<SoundSettings>();
  const state = soundDraft
    ? { ...persisted, settings: { ...persisted.settings, sound: soundDraft } }
    : persisted;
  const persistedRef = useRef(persisted);
  useLayoutEffect(() => {
    persistedRef.current = persisted;
  }, [persisted]);
  const setData = query.setData;
  const setState: Dispatch<SetStateAction<SetupState>> = useCallback(
    (next) => {
      if (source.views) {
        const edited = typeof next === "function" ? next(persistedRef.current) : next;
        if (edited.settings.sound !== persistedRef.current.settings.sound)
          setSoundDraft(edited.settings.sound);
      } else setData((previous) => (typeof next === "function" ? next(previous ?? initial) : next));
    },
    [setData, initial, source.views],
  );
  const pendingSoundRef = useRef<SoundSettings>(undefined);
  const receiveState = useCallback(
    (next: SetupState) => {
      if (source.views) {
        if (!pendingSoundRef.current) setSoundDraft(undefined);
        return;
      }
      // Persisted snapshots may describe an earlier point in the same drag.
      setState({
        ...next,
        settings: { ...next.settings, sound: pendingSoundRef.current ?? next.settings.sound },
      });
    },
    [setState, source.views],
  );
  useEffect(
    () => (source.views ? undefined : source.subscribe(receiveState)),
    [source, receiveState],
  );
  return { state, setState, receiveState, pendingSoundRef, error: query.isError };
}
