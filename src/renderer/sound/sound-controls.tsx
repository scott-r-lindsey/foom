import { useEffect, useRef, useState } from "react";
import type { SettingsPatch } from "../../shared/setup";
import type {
  AudioSink,
  SoundChoice,
  SoundEntry,
  SoundKind,
  SoundSettings,
} from "../../shared/sound";
import { parseSoundSettings, soundName } from "../../shared/sounds";
import { createAudioSink } from "./web-audio";
const LABELS: Record<SoundKind, string> = {
  working: "Working",
  done: "Done",
  "needs-you": "Needs you",
  refusal: "Refusal",
};
const choiceKey = (choice: SoundChoice) => `${choice.source}:${choice.file}`;
export function SoundControls({
  settings,
  onChange,
}: {
  settings: SoundSettings;
  onChange: (patch: SettingsPatch) => void;
}) {
  const [entries, setEntries] = useState<SoundEntry[]>([]);
  const [reasons, setReasons] = useState<Partial<Record<SoundKind, string | undefined>>>({});
  const [error, setError] = useState("");
  const [credits, setCredits] = useState("");
  const sinkRef = useRef<AudioSink>(undefined);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const stop = () => {
    clearTimeout(timerRef.current);
    sinkRef.current?.silenceAlerts();
    sinkRef.current?.working(0, 0);
  };
  useEffect(() => {
    let active = true;
    sinkRef.current = createAudioSink(undefined, window.desktop.sounds, (kind, reason) => {
      if (active) setReasons((previous) => ({ ...previous, [kind]: reason }));
    });
    void window.desktop.sounds.list().then(
      (list) => {
        if (active) setEntries(list);
      },
      () => {
        if (active) setError("Unable to list sounds");
      },
    );
    return () => {
      active = false;
      stop();
      sinkRef.current?.dispose();
      sinkRef.current = undefined;
    };
  }, []);
  useEffect(() => {
    sinkRef.current?.configure(settings.choices);
  }, [settings.choices]);
  const change = (patch: Partial<SoundSettings>) => {
    stop();
    try {
      const next = parseSoundSettings({ ...settings, ...patch });
      setError("");
      onChange({ sound: next });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Invalid sound choice");
    }
  };
  const play = (kind: SoundKind) => {
    stop();
    if (kind === "working") sinkRef.current?.working(0.6, settings.workingVolume);
    else sinkRef.current?.alert(kind, settings.alertVolume);
    timerRef.current = setTimeout(stop, kind === "working" ? 5000 : 2000);
  };
  const picker = (kind: SoundKind) => {
    const selected = settings.choices[kind];
    const options = entries.filter((entry) => entry.kind === kind);
    if (!options.some((entry) => choiceKey(entry) === choiceKey(selected)))
      options.push({ ...selected, kind, name: soundName(selected.file) });
    return (
      <div className="sound-picker" key={kind}>
        <label className="preflight-field">
          {LABELS[kind]} sound
          <select
            aria-label={`${LABELS[kind]} sound`}
            value={choiceKey(selected)}
            onChange={(event) => {
              const choice = options.find((option) => choiceKey(option) === event.target.value);
              if (choice)
                change({
                  choices: {
                    ...settings.choices,
                    [kind]: { source: choice.source, file: choice.file },
                  },
                });
            }}
          >
            {options.map((option) => (
              <option
                key={choiceKey(option)}
                value={choiceKey(option)}
                disabled={Boolean(option.error)}
              >
                {option.name}
                {option.error ? " (unavailable)" : ""}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => {
            play(kind);
          }}
        >
          Preview {LABELS[kind].toLowerCase()}
        </button>
        {reasons[kind] && (
          <p role="status" className="preflight-note">
            {reasons[kind]}
          </p>
        )}
      </div>
    );
  };
  return (
    <div className="sound-controls">
      <div className="sound-panels">
        <section className="sound-panel" aria-label="Working sound">
          <h3>Working</h3>
          <label>
            <input
              type="checkbox"
              checked={settings.working}
              onChange={(e) => {
                change({ working: e.target.checked });
              }}
            />{" "}
            Working sound on
          </label>
          <label className="preflight-field">
            Working volume · {Math.round(settings.workingVolume * 100)}%
            <input
              aria-label="Working volume"
              type="range"
              min="0"
              max="100"
              value={settings.workingVolume * 100}
              onChange={(e) => {
                change({ workingVolume: Number(e.target.value) / 100 });
              }}
            />
          </label>
          {picker("working")}
          <p className="preflight-note">
            Volume follows total output. Quiet terminals are silent. Off by default.
          </p>
        </section>
        <section className="sound-panel" aria-label="Alerts">
          <h3>Alerts</h3>
          <label>
            <input
              type="checkbox"
              checked={settings.alerts}
              onChange={(e) => {
                change({ alerts: e.target.checked });
              }}
            />{" "}
            Alerts on
          </label>
          <label className="preflight-field">
            Alert volume · {Math.round(settings.alertVolume * 100)}%
            <input
              aria-label="Alert volume"
              type="range"
              min="0"
              max="100"
              value={settings.alertVolume * 100}
              onChange={(e) => {
                change({ alertVolume: Number(e.target.value) / 100 });
              }}
            />
          </label>
          {picker("done")}
          {picker("needs-you")}
          {picker("refusal")}
          <p className="preflight-note">
            Needs you repeats every 2 minutes until answered or dismissed. The terminal you are
            looking at does not alert. Refusal plays when no tile is empty.
          </p>
        </section>
      </div>
      <p className="preflight-note">
        Previews use the selected volume, even when sound is off. Visual status always stays on.
      </p>
      <button
        type="button"
        onClick={() => {
          void window.desktop.sounds.openFolder().catch(() => {
            setError("Unable to open sounds folder");
          });
        }}
      >
        Open sounds folder
      </button>
      <p className="preflight-note">
        Add audio files to working, done, needs-you or refusal, then reopen Sound to refresh the
        choices.
      </p>
      {error && <p role="alert">{error}</p>}
      <details>
        <summary
          onClick={() => {
            if (!credits)
              void window.desktop.sounds.notices().then(setCredits, () => {
                setError("Unable to read sound credits");
              });
          }}
        >
          Sound credits
        </summary>
        <pre className="sound-credits">{credits}</pre>
      </details>
    </div>
  );
}
