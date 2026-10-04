import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { interfaceThemes, resolveInterfaceTheme } from "../../shared/interface-themes";
import type { InterfaceThemeId } from "../../shared/interface-theme";
import type { Settings, SettingsPatch } from "../../shared/setup";

const choices: readonly InterfaceThemeId[] = [
  "eclipse-light",
  "eclipse-dark",
  "high-contrast",
  "deep-field",
  "moonlight",
  "graphite",
  "midnight-indigo",
];
const states = [
  { state: "working", label: "Working", reason: "Output is arriving", ink: "accent" },
  { state: "checking", label: "Checking", reason: "Evaluating quiet output", ink: "accent" },
  {
    state: "needs_input",
    label: "Needs you",
    reason: "Waiting for your approval",
    ink: "attention-ink",
  },
  { state: "done", label: "Done", reason: "Finished successfully", ink: "done-ink" },
  { state: "failed", label: "Failed", reason: "Exited with an error", ink: "failed-ink" },
  { state: "quiet_ok", label: "Quiet", reason: "Quiet but fine", ink: "muted" },
] as const;
export function InterfaceThemePicker({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (patch: SettingsPatch) => void;
}) {
  const [media] = useState(() => matchMedia("(prefers-color-scheme: dark)"));
  const [systemDark, setSystemDark] = useState(media.matches);
  useEffect(() => {
    const changed = () => {
      setSystemDark(media.matches);
    };
    media.addEventListener("change", changed);
    return () => {
      media.removeEventListener("change", changed);
    };
  }, [media]);
  const selected =
    settings.interfaceTheme === "follow"
      ? settings.colorMode === "system"
        ? "system"
        : `eclipse-${settings.colorMode}`
      : settings.interfaceTheme;
  const theme = resolveInterfaceTheme(
    settings.interfaceTheme,
    settings.colorMode === "system" ? systemDark : settings.colorMode === "dark",
  );
  const style: CSSProperties = {
    colorScheme: theme.base,
    ...Object.fromEntries(Object.entries(theme.colors).map(([key, value]) => [`--${key}`, value])),
  };
  return (
    <div className="interface-theme-settings">
      <div className="interface-theme-choices" role="group" aria-label="Interface themes">
        <button
          type="button"
          aria-pressed={selected === "system"}
          onClick={() => {
            onChange({ interfaceTheme: "follow", colorMode: "system" });
          }}
        >
          System
          <span className="theme-description">Follow your system’s light or dark appearance</span>
        </button>
        {choices.map((id) => {
          const candidate = interfaceThemes[id];
          return (
            <button
              type="button"
              key={id}
              aria-pressed={selected === id}
              onClick={() => {
                onChange({ interfaceTheme: id });
              }}
            >
              {candidate.name}
              <span className="interface-theme-swatches" aria-hidden="true">
                {(["bg", "surface", "accent", "attention", "done", "failed"] as const).map(
                  (key) => (
                    <i key={key} style={{ backgroundColor: candidate.colors[key] }} />
                  ),
                )}
              </span>
            </button>
          );
        })}
      </div>
      <section
        className="interface-theme-preview"
        aria-label="Interface theme preview"
        style={style}
      >
        <h3>
          {typeof selected === "object" ? `${theme.name} · Custom theme` : `${theme.name} preview`}
        </h3>
        <div role="list" aria-label="Terminal status previews">
          {states.map(({ state, label, reason, ink }) => (
            <div
              role="listitem"
              key={state}
              className="board-row theme-preview-row"
              data-state={state}
            >
              <span className="board-light" aria-hidden="true" />
              <span style={{ color: theme.colors[ink] }}>{label}</span>
              <span className="theme-preview-reason">{reason}</span>
            </div>
          ))}
        </div>
      </section>
      <p className="preflight-note">
        Amber always means Needs you. Magenta always means Failed. Labels and light shapes stay the
        same in every theme.
      </p>
    </div>
  );
}
