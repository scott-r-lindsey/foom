import type { SoundSettings } from "../../shared/sound";

export function VolumeControl({
  settings,
  onChange,
  onSample,
}: {
  settings: SoundSettings;
  onChange: (settings: SoundSettings) => void;
  onSample: (settings: SoundSettings) => void;
}) {
  const percent = Math.round(settings.volume * 100);
  const label = settings.muted
    ? `Volume, muted (${String(percent)}%)`
    : `Volume ${String(percent)}%`;
  return (
    <div
      className="master-volume"
      role="group"
      aria-label="Volume"
      data-muted={settings.muted || undefined}
    >
      <button
        className="footer-tool"
        type="button"
        aria-label={settings.muted ? "Unmute" : "Mute"}
        title={label}
        aria-pressed={settings.muted}
        onClick={() => {
          const next = { ...settings, muted: !settings.muted };
          onChange(next);
          if (!next.muted) onSample(next);
        }}
      >
        <svg viewBox="0 0 14 14" aria-hidden="true">
          <path d="M2 5.5h2.2L7.5 3v8L4.2 8.5H2z" />
          {settings.muted || percent === 0 ? (
            <path d="M9.5 5.5l3 3M12.5 5.5l-3 3" />
          ) : (
            <>
              <path d="M9.4 5.4a2.3 2.3 0 0 1 0 3.2" />
              {percent > 50 && <path d="M11 3.8a4.6 4.6 0 0 1 0 6.4" />}
            </>
          )}
        </svg>
      </button>
      <input
        type="range"
        min="0"
        max="100"
        step="5"
        value={percent}
        aria-label="Volume"
        aria-valuetext={settings.muted ? "Muted" : `${String(percent)}%`}
        title={label}
        onChange={(event) => {
          onChange({ ...settings, volume: Number(event.target.value) / 100, muted: false });
        }}
        onPointerUp={(event) => {
          onSample({ ...settings, volume: Number(event.currentTarget.value) / 100 });
        }}
        onKeyUp={(event) => {
          if (
            [
              "ArrowLeft",
              "ArrowRight",
              "ArrowUp",
              "ArrowDown",
              "Home",
              "End",
              "PageUp",
              "PageDown",
            ].includes(event.key)
          )
            onSample({
              ...settings,
              volume: Number(event.currentTarget.value) / 100,
            });
        }}
      />
    </div>
  );
}
