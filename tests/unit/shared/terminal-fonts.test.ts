import { expect, test } from "vitest";
import {
  DEFAULT_TERMINAL_FONT,
  isTerminalFont,
  terminalFontStack,
  terminalFontFamilies,
  TERMINAL_FONT_FALLBACK,
} from "../../../src/shared/terminal-fonts";
import { parseSettingsPatch } from "../../../src/main/setup/settings";
import { parseConfigSettings } from "../../../src/shared/config-settings";

test("family names are bounded text, never CSS syntax", () => {
  for (const name of [
    DEFAULT_TERMINAL_FONT,
    "Noto Sans Mono",
    "ＭＳ ゴシック",
    "Font_1.0 (Mono)+",
    "a".repeat(128),
  ]) {
    expect(isTerminalFont(name)).toBe(true);
    expect(parseSettingsPatch({ terminalFont: name })).toEqual({ terminalFont: name });
    expect(parseConfigSettings({ terminalFont: name })).toEqual({ terminalFont: name });
  }
  for (const name of [
    null,
    {},
    [],
    4,
    "",
    "a".repeat(129),
    " Mono",
    "Mono ",
    "Mono\n",
    'x", serif',
    "x; color:red",
    "a\\b",
    "a\0b",
    "a\tb",
    "a\u202eb",
    "-font",
  ]) {
    expect(isTerminalFont(name)).toBe(false);
    expect(terminalFontStack(name)).toBe(TERMINAL_FONT_FALLBACK);
    expect(() => parseSettingsPatch({ terminalFont: name })).toThrow();
  }
});

test("the unchanged default and missing custom fonts always retain bundled fallbacks", () => {
  expect(terminalFontStack(DEFAULT_TERMINAL_FONT)).toBe(TERMINAL_FONT_FALLBACK);
  expect(terminalFontStack("Missing Mono")).toBe(`"Missing Mono", ${TERMINAL_FONT_FALLBACK}`);
});

test("untrusted font catalogs are filtered, sorted, deduplicated and bounded", () => {
  expect(
    terminalFontFamilies(["Zed", "Alpha", "Alpha", DEFAULT_TERMINAL_FONT, 'bad"', null]),
  ).toEqual(["Alpha", "Zed"]);
  expect(terminalFontFamilies(null)).toEqual([]);
  expect(terminalFontFamilies(Array.from({ length: 10001 }, () => "Mono"))).toEqual([]);
});
