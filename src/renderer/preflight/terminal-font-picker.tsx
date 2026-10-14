import { useEffect, useState } from "react";
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
  source: Pick<SetupSource, "listTerminalFonts">;
  value: string;
  onChange: (patch: SettingsPatch) => void;
}) {
  const [families, setFamilies] = useState<readonly string[]>([]);
  useEffect(() => {
    let disposed = false;
    const update = (fonts: readonly string[]) => {
      if (disposed) return;
      const next = terminalFontFamilies(fonts);
      setFamilies((previous) =>
        previous.length === next.length && previous.every((family, index) => family === next[index])
          ? previous
          : next,
      );
    };
    void source
      .listTerminalFonts?.()
      .then(async (fonts) => {
        update(fonts);
        if (!disposed) {
          const refreshed = await source.listTerminalFonts?.(true);
          if (refreshed) update(refreshed);
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [source]);
  const selected = isTerminalFont(value) ? value : DEFAULT_TERMINAL_FONT;
  const options = terminalFontFamilies([...families, selected]);
  return (
    <label className="terminal-font-size">
      Terminal font
      <select
        aria-label="Terminal font"
        value={selected}
        onChange={(event) => {
          const family = event.target.value;
          if (isTerminalFont(family)) onChange({ terminalFont: family });
        }}
      >
        <option value={DEFAULT_TERMINAL_FONT}>Hack Nerd Font Mono (bundled)</option>
        {options.map((family) => (
          <option key={family} value={family}>
            {family}
          </option>
        ))}
      </select>
    </label>
  );
}
