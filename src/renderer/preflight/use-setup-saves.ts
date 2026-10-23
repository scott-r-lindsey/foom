import { useEffect, useRef } from "react";
import { useBackgroundErrors } from "../board/error-presentation";
import type { SoundSettings } from "../../shared/sound";
import type { SetupState } from "../../shared/setup";
import type { SetupSource } from "./setup-source.d";
import type { useSetupState } from "./use-setup-state";
import { message } from "./message";

/** View-local write ordering; main remains the persisted source of truth. */
export function useSetupSaves(
  source: Pick<SetupSource, "save" | "state">,
  { setState, receiveState, pendingSoundRef }: ReturnType<typeof useSetupState>,
  setError: (error: string) => void,
) {
  const { report: reportFailure, clear } = useBackgroundErrors();
  const argumentSaveRef = useRef<Promise<void>>(Promise.resolve());
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
  const saveArguments = (id: string, args: readonly string[]) => {
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
  };
  return { save, saveArguments };
}
