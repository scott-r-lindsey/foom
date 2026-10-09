import type { ThemeCatalog } from "../../shared/theme-file";
import { ThemeFilesStatus } from "./theme-files-status";
import { useEffect, useState } from "react";
import {
  ansiNames,
  resolveTerminalTheme,
  terminalThemeOptions,
} from "../../shared/terminal-themes";
import type { Settings, SettingsPatch } from "../../shared/setup";

export function TerminalThemePicker({
  settings,
  onChange,
  catalog,
  openFolder,
}: {
  catalog?: ThemeCatalog | undefined;
  openFolder?: (() => Promise<void>) | undefined;
  settings: Settings;
  onChange: (patch: SettingsPatch) => void;
}) {
  const [media] = useState(() => matchMedia("(prefers-color-scheme: dark)"));
  const [dark, setDark] = useState(media.matches);
  useEffect(() => {
    const changed = () => {
      setDark(media.matches);
    };
    media.addEventListener("change", changed);
    return () => {
      media.removeEventListener("change", changed);
    };
  }, [media]);
  const theme = resolveTerminalTheme(settings.terminalTheme, dark, catalog);
  return (
    <div className="terminal-theme-settings">
      <div className="terminal-theme-choices" role="group" aria-label="Terminal colors">
        {[...terminalThemeOptions, ...(catalog?.terminal ?? [])].map((option) => {
          const palette = resolveTerminalTheme(option.id, dark, catalog);
          return (
            <button
              type="button"
              key={option.id}
              aria-pressed={settings.terminalTheme === option.id}
              onClick={() => {
                onChange({ terminalTheme: option.id });
              }}
            >
              {option.name}
              <span className="terminal-theme-strip" aria-hidden="true">
                <i style={{ backgroundColor: palette.background }} />
                {ansiNames.slice(1, 8).map((name) => (
                  <i key={name} style={{ backgroundColor: palette[name] }} />
                ))}
              </span>
            </button>
          );
        })}
        {typeof settings.terminalTheme !== "string" && <p>Custom theme</p>}
      </div>
      <ThemeFilesStatus catalog={catalog} kind="terminal-theme" openFolder={openFolder} />
      <pre
        className="settings-terminal-preview"
        aria-label="Terminal theme preview"
        style={{
          fontSize: settings.terminalFontSize,
          color: theme.foreground,
          backgroundColor: theme.background,
        }}
      >
        {"Hack Nerd Font Mono · Aa Bb 0123456789\n\n"}
        <span style={{ color: theme.blue }}>{"~/code/foom"}</span>
        {" $ npm test\n"}
        <b>Bold text</b>
        {" · "}
        <span style={{ opacity: 0.5 }}>Dim text</span>
        {"\n"}
        <span style={{ backgroundColor: theme.selectionBackground }}>Selected text</span>
        {"\n\n"}
        {ansiNames.map((name, index) => (
          <span
            key={name}
            style={{ backgroundColor: theme[name], color: theme.background }}
            title={name}
          >
            {` ${String(index).padStart(2, "0")} `}
            {index === 7 ? "\n" : ""}
          </span>
        ))}
        {"\n\n$ Ready when you are. "}
        <span style={{ backgroundColor: theme.cursor, color: theme.background }}> </span>
      </pre>
    </div>
  );
}
