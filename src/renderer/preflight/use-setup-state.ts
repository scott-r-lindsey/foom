import { useSettingsView } from "../data/view-hooks";
import { useCallback, useEffect, useRef, useState, useLayoutEffect } from "react";
import type { SetupState, SettingsPatch } from "../../shared/setup";
import type { Dispatch, SetStateAction } from "react";
import type { SoundSettings } from "../../shared/sound";
import type { SetupSource } from "./setup-source.d";

/** Ordered main snapshots with pending local edits overlaid until their commands settle. */
export function useSetupState(
  source: Pick<SetupSource, "subscribe" | "views" | "state">,
  initial: SetupState,
) {
  const query = useSettingsView(source, source.state.bind(source), initial);
  const persisted = query.data ?? initial;
  const [soundDraft, setSoundDraft] = useState<SoundSettings>();
  const [edits, setEdits] = useState<readonly { patch: SettingsPatch; complete: boolean }[]>([]);
  const previewSettings = useCallback((patch: SettingsPatch) => {
    const edit = { patch, complete: false };
    setEdits((current) => [...current, edit]);
    return () => {
      setEdits((current) => {
        const next = current.map((entry) =>
          entry === edit ? { ...entry, complete: true } : entry,
        );
        // Keep the latest intent visible when concurrent commands finish out of order.
        return next.every((entry) => entry.complete) ? [] : next;
      });
    };
  }, []);
  const editedSettings = edits.reduce(
    (settings, edit) => ({ ...settings, ...edit.patch }),
    persisted.settings,
  );
  const state =
    soundDraft || edits.length
      ? {
          ...persisted,
          settings: { ...editedSettings, ...(soundDraft ? { sound: soundDraft } : {}) },
        }
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
  return { state, setState, receiveState, pendingSoundRef, previewSettings, error: query.isError };
}
