import { resolveInterfaceTheme } from "../../shared/interface-themes";
import { CustomThemeHint } from "./custom-theme-hint";
import { ThemeMenu } from "./theme-menu";
import {
  DEFAULT_TERMINAL_FONT,
  isTerminalFont,
  terminalFontStack,
} from "../../shared/terminal-fonts";
import type { ThemeCatalog } from "../../shared/theme-file";
import { ThemeFilesStatus } from "./theme-files-status";
import { useEffect, useState } from "react";
import {
  parseTerminalThemeChoice,
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
  const interfaceDark =
    resolveInterfaceTheme(settings.interfaceTheme, dark, catalog).base === "dark";
  const theme = resolveTerminalTheme(settings.terminalTheme, interfaceDark, catalog);
  return (
    <div className="terminal-theme-settings">
      <div className="terminal-theme-picker-column">
        <ThemeMenu
          label="Colors"
          selected={typeof settings.terminalTheme === "string" ? settings.terminalTheme : ""}
          choices={[
            ...terminalThemeOptions.map((entry) =>
              entry.id === "follow"
                ? { ...entry, name: `Default · Foom ${interfaceDark ? "Dark" : "Light"}` }
                : entry,
            ),
            ...(catalog?.terminal ?? []).map((entry) => ({
              id: entry.id,
              name: entry.name,
              custom: true,
            })),
          ]}
          onChange={(id) => {
            onChange({ terminalTheme: parseTerminalThemeChoice(id) });
          }}
        />
        <CustomThemeHint />
        <ThemeFilesStatus catalog={catalog} kind="terminal-theme" openFolder={openFolder} />
      </div>
      <pre
        className="settings-terminal-preview"
        aria-label="Terminal theme preview"
        style={{
          fontSize: settings.terminalFontSize,
          fontFamily: terminalFontStack(settings.terminalFont),
          color: theme.foreground,
          backgroundColor: theme.background,
        }}
      >
        {`${isTerminalFont(settings.terminalFont) ? settings.terminalFont : DEFAULT_TERMINAL_FONT} · Aa Bb 0123456789\n\n`}
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
