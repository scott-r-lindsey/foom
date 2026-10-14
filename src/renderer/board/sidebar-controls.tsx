import { useEffect, useRef, useState } from "react";
import { SCALES } from "../../shared/config-settings";
import type { SettingsPatch } from "../../shared/setup";
import type { AudioSink } from "../../shared/sound";
import { DEFAULT_SOUND, soundVolume } from "../../shared/sounds";
import type { SetupSource } from "../preflight/setup-source.d";
import { VolumeControl } from "../sound/volume-control";
import { useWheelNotch } from "../wheel-notch";
import { createAudioSink } from "../sound/web-audio";

type FooterSource = Pick<SetupSource, "state" | "subscribe"> & Partial<Pick<SetupSource, "save">>;
export function SidebarControls({ source }: { source: FooterSource | undefined }) {
  const [settings, setSettings] = useState({ interfaceScale: 100, sound: DEFAULT_SOUND });
  const settingsRef = useRef(settings);
  const pendingRef = useRef<SettingsPatch>(undefined);
  const savingRef = useRef(false);
  const sinkRef = useRef<AudioSink>(undefined);
  const sampleTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!source) return;
    let active = true;
    let changed = false;
    const receive = (next: typeof settings) => {
      if (!active) return;
      settingsRef.current = { ...next, ...pendingRef.current };
      setSettings(settingsRef.current);
    };
    const off = source.subscribe(({ settings }) => {
      changed = true;
      receive(settings);
    });
    void source.state().then(
      ({ settings }) => {
        if (!changed) receive(settings);
      },
      () => {},
    );
    return () => {
      active = false;
      off();
    };
  }, [source]);
  useEffect(() => {
    if (!source) return;
    const audio = createAudioSink();
    sinkRef.current = audio;
    return () => {
      clearTimeout(sampleTimerRef.current);
      audio.dispose();
      sinkRef.current = undefined;
    };
  }, [source]);
  useEffect(() => {
    sinkRef.current?.configure(settings.sound.choices);
  }, [settings.sound.choices]);
  useEffect(() => {
    if (settings.sound.muted || settings.sound.volume === 0) sinkRef.current?.silenceAlerts();
  }, [settings.sound.muted, settings.sound.volume]);
  const hasPending = () => Boolean(pendingRef.current);
  const save = async (patch: SettingsPatch) => {
    settingsRef.current = { ...settingsRef.current, ...patch };
    setSettings(settingsRef.current);
    pendingRef.current = { ...pendingRef.current, ...patch };
    if (savingRef.current || !source?.save) return;
    savingRef.current = true;
    while (pendingRef.current) {
      const next: SettingsPatch = pendingRef.current;
      // Retain the optimistic patch through broadcasts from this save.
      try {
        const saved = await source.save(next);
        if (pendingRef.current === next) {
          pendingRef.current = undefined;
          settingsRef.current = saved.settings;
          setSettings(settingsRef.current);
        }
      } catch {
        if (pendingRef.current === next) {
          pendingRef.current = undefined;
          const restored = await source.state().catch(() => undefined);
          if (restored && !hasPending()) {
            settingsRef.current = restored.settings;
            setSettings(settingsRef.current);
          }
        }
      }
    }
    savingRef.current = false;
  };
  const wheelNotch = useWheelNotch();
  const index = SCALES.indexOf(settings.interfaceScale);
  return (
    <>
      <div
        className="footer-zoom"
        role="group"
        aria-label="Zoom"
        onWheel={(event) => {
          const direction = wheelNotch(event);
          if (!direction) return;
          const next = SCALES[SCALES.indexOf(settingsRef.current.interfaceScale) + direction];
          if (next !== undefined) void save({ interfaceScale: next });
        }}
      >
        <button
          className="footer-tool"
          type="button"
          aria-label="Zoom out"
          title="Zoom out"
          disabled={index === 0}
          onClick={() => {
            void save({ interfaceScale: SCALES[index - 1] ?? 80 });
          }}
        >
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 5h6" />
          </svg>
        </button>
        <button
          className="footer-zoom-value"
          type="button"
          data-default={settings.interfaceScale === 100 || undefined}
          aria-label={`Zoom ${String(settings.interfaceScale)}%${settings.interfaceScale === 100 ? "" : ", reset to 100%"}`}
          title={settings.interfaceScale === 100 ? "Zoom" : "Reset zoom"}
          onClick={() => {
            void save({ interfaceScale: 100 });
          }}
        >
          {settings.interfaceScale}%
        </button>
        <button
          className="footer-tool"
          type="button"
          aria-label="Zoom in"
          title="Zoom in"
          disabled={index === SCALES.length - 1}
          onClick={() => {
            void save({ interfaceScale: SCALES[index + 1] ?? 300 });
          }}
        >
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 5h6M5 2v6" />
          </svg>
        </button>
      </div>
      <VolumeControl
        settings={settings.sound}
        onChange={(sound) => {
          void save({ sound });
        }}
        onSample={(sound) => {
          clearTimeout(sampleTimerRef.current);
          sinkRef.current?.configure(sound.choices);
          sinkRef.current?.alert("done", soundVolume(sound, "alert"));
          sampleTimerRef.current = setTimeout(() => {
            sinkRef.current?.silenceAlerts();
          }, 2000);
        }}
      />
    </>
  );
}
