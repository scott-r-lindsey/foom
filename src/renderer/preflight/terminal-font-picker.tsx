import { useFontsView } from "../data/view-hooks";
import { ThemeMenu } from "./theme-menu";
import { useEffect } from "react";
import {
  DEFAULT_TERMINAL_FONT,
  isTerminalFont,
  terminalFontFamilies,
} from "../../shared/terminal-fonts";
import type { SettingsPatch } from "../../shared/setup";
import type { SetupSource } from "./setup-source.d";

export function TerminalFontPicker({
  source,
  value,
  onChange,
}: {
  source: Pick<SetupSource, "listTerminalFonts" | "views">;
  value: string;
  onChange: (patch: SettingsPatch) => void;
}) {
  const query = useFontsView(source, () => source.listTerminalFonts?.() ?? Promise.resolve([]));
  const families = query.data ?? [];
  const setFonts = query.setData;
  useEffect(() => {
    void source
      .listTerminalFonts?.(true)
      .then(setFonts)
      .catch(() => undefined);
  }, [source, setFonts]);
  const selected = isTerminalFont(value) ? value : DEFAULT_TERMINAL_FONT;
  const options = terminalFontFamilies([...families, selected]);
  return (
    <ThemeMenu
      label="Terminal font"
      selected={selected}
      choices={[
        { id: DEFAULT_TERMINAL_FONT, name: "Hack Nerd Font Mono (bundled)" },
        ...options.map((family) => ({ id: family, name: family })),
      ]}
      onChange={(family) => {
        if (isTerminalFont(family)) onChange({ terminalFont: family });
      }}
    />
  );
}
