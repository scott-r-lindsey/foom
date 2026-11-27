import type { AgentPermissionLevel } from "../../shared/agent-permissions";
import { useEffect, useRef } from "react";
import { useBackgroundErrors } from "../board/error-presentation";
import type { SoundSettings } from "../../shared/sound";
import type { SetupState } from "../../shared/setup";
import type { SetupSource } from "./setup-source.d";
import type { useSetupState } from "./use-setup-state";
import { message } from "./message";

/** View-local write ordering; main remains the persisted source of truth. */
export function useSetupSaves(
  source: Pick<SetupSource, "save" | "state" | "views">,
  { setState, receiveState, pendingSoundRef, previewSettings }: ReturnType<typeof useSetupState>,
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
  const save = (patch: Parameters<SetupSource["save"]>[0], themeDigest?: string) => {
    const soundOnly = patch.sound && Object.keys(patch).length === 1;
    const complete = source.views && !soundOnly ? previewSettings(patch) : undefined;
    if (!complete)
      setState((current) => ({ ...current, settings: { ...current.settings, ...patch } }));
    if (patch.sound && soundOnly) {
      void saveSound(patch.sound);
      return;
    }
    source.save(patch, ...(themeDigest ? [themeDigest] : [])).then(
      (next) => {
        complete?.();
        receiveState(next);
      },
      (caught: unknown) => {
        complete?.();
        setError(message(caught));
        source.state().then(receiveState, () => undefined);
      },
    );
  };
  const saveArguments = (id: string, args: readonly string[]) => {
    const saving = argumentSaveRef.current
      .catch(() => undefined)
      .then(async () => {
        receiveState(await source.save({ agentArguments: { [id]: args } }));
      });
    argumentSaveRef.current = saving;
    return saving;
  };
  const savePermission = async (
    scope: string,
    agent: string,
    level: AgentPermissionLevel | null,
  ) => {
    receiveState(
      await source.save({ agentPermissions: { [scope]: { [agent]: level ? { level } : null } } }),
    );
  };
  return { save, saveArguments, savePermission };
}
