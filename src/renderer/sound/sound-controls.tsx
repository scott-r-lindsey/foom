import { useEffect, useRef } from "react";
import type { SettingsPatch } from "../../shared/setup";
import type { AudioSink, SoundSettings } from "../../shared/sound";
import { resolveSoundscape, SOUNDSCAPES } from "../../shared/soundscapes";
import { createAudioSink } from "./web-audio";

export function SoundControls({
  settings,
  onChange,
}: {
  settings: SoundSettings;
  onChange: (patch: SettingsPatch) => void;
}) {
  const previewRef = useRef<
    | {
        sink: AudioSink;
        interval?: ReturnType<typeof setInterval>;
        timeout?: ReturnType<typeof setTimeout>;
      }
    | undefined
  >(undefined);
  const stop = () => {
    clearInterval(previewRef.current?.interval);
    clearTimeout(previewRef.current?.timeout);
    previewRef.current?.sink.dispose();
    previewRef.current = undefined;
  };
  useEffect(() => stop, []);
  const play = (kind: "working" | "done" | "needsYou") => {
    stop();
    const sink = createAudioSink();
    const scape = resolveSoundscape(settings.soundscape);
    previewRef.current = { sink };
    if (kind === "working") {
      const tick = () => {
        sink.working(0.6, settings.workingVolume, scape);
      };
      tick();
      previewRef.current.interval = setInterval(tick, 100);
    } else sink.alert(kind, settings.alertVolume, scape);
    previewRef.current.timeout = setTimeout(stop, 2000);
  };
  const change = (patch: Partial<SoundSettings>) => {
    stop();
    onChange({ sound: { ...settings, ...patch } });
  };
  return (
    <div className="sound-controls">
      <label className="preflight-field">
        Soundscape
        <select
          value={typeof settings.soundscape === "string" ? settings.soundscape : "custom"}
          onChange={(event) => {
            const choice = event.target.value;
            if (choice === "drive" || choice === "soft") change({ soundscape: choice });
          }}
        >
          {Object.entries(SOUNDSCAPES).map(([id, scape]) => (
            <option key={id} value={id}>
              {scape.name}
            </option>
          ))}
          {typeof settings.soundscape !== "string" && (
            <option value="custom">{settings.soundscape.name}</option>
          )}
        </select>
      </label>
      <div className="sound-panels">
        <section className="sound-panel" aria-label="Working sound">
          <h3>Working</h3>
          <label>
            <input
              type="checkbox"
              checked={settings.working}
              onChange={(event) => {
                change({ working: event.target.checked });
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
              onChange={(event) => {
                change({ workingVolume: Number(event.target.value) / 100 });
              }}
            />
          </label>
          <button
            type="button"
            onClick={() => {
              play("working");
            }}
          >
            Preview working
          </button>
          <p className="preflight-note">
            Drive chatter follows total output. Quiet terminals are silent. Off by default.
          </p>
        </section>
        <section className="sound-panel" aria-label="Alerts">
          <h3>Alerts</h3>
          <label>
            <input
              type="checkbox"
              checked={settings.alerts}
              onChange={(event) => {
                change({ alerts: event.target.checked });
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
              onChange={(event) => {
                change({ alertVolume: Number(event.target.value) / 100 });
              }}
            />
          </label>
          <div className="sound-previews">
            <button
              type="button"
              onClick={() => {
                play("needsYou");
              }}
            >
              Preview needs you
            </button>
            <button
              type="button"
              onClick={() => {
                play("done");
              }}
            >
              Preview done
            </button>
          </div>
          <p className="preflight-note">
            Needs you repeats every 2 minutes until answered or dismissed. The terminal you are
            looking at does not alert.
          </p>
        </section>
      </div>
      <p className="preflight-note">
        Previews use the selected volume, even when sound is off. Visual status always stays on.
      </p>
    </div>
  );
}
