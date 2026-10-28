import { CustomThemeHint } from "./custom-theme-hint";
import { ThemeMenu } from "./theme-menu";
import type { ThemeCatalog } from "../../shared/theme-file";
import { ThemeFilesStatus } from "./theme-files-status";
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import {
  interfaceThemes,
  resolveInterfaceTheme,
  parseInterfaceTheme,
} from "../../shared/interface-themes";
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
  catalog,
  openFolder,
  compact = false,
}: {
  compact?: boolean;
  catalog?: ThemeCatalog | undefined;
  openFolder?: (() => Promise<void>) | undefined;
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
  const selected = settings.interfaceTheme;
  const theme = resolveInterfaceTheme(settings.interfaceTheme, systemDark, catalog);
  const previewColors = {
    ...theme.colors,
    highlight: theme.colors.highlight ?? theme.colors.accent,
    "highlight-deep": theme.colors["highlight-deep"] ?? theme.colors["accent-deep"],
  };
  const style: CSSProperties = {
    colorScheme: theme.base,
    ...Object.fromEntries(Object.entries(previewColors).map(([key, value]) => [`--${key}`, value])),
  };
  return (
    <div className="interface-theme-settings">
      <div className="interface-theme-picker-column">
        <ThemeMenu
          label="Theme"
          selected={typeof selected === "string" ? selected : ""}
          choices={[
            {
              id: "follow",
              name:
                selected === "follow"
                  ? `Default · Eclipse ${systemDark ? "Dark" : "Light"}`
                  : "Default",
            },
            ...choices.map((id) => ({ id, name: interfaceThemes[id].name })),
            ...(catalog?.interface ?? []).map((entry) => ({
              id: entry.id,
              name: entry.theme.name,
              custom: true,
            })),
          ]}
          onChange={(id) => {
            onChange({ interfaceTheme: parseInterfaceTheme(id) });
          }}
        />
        {!compact && <CustomThemeHint />}
        {!compact && <ThemeFilesStatus catalog={catalog} kind="theme" openFolder={openFolder} />}
      </div>
      {!compact && (
        <section
          className="interface-theme-preview"
          aria-label="Interface theme preview"
          style={style}
        >
          <h3>
            {typeof selected === "object"
              ? `${theme.name} · Custom theme`
              : `${theme.name} preview`}
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
      )}
    </div>
  );
}
