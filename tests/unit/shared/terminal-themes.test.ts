import { expect, test } from "vitest";
import {
  isTerminalTheme,
  parseTerminalThemeChoice,
  resolveTerminalTheme,
  terminalThemeOptions,
  terminalThemes,
} from "../../../src/shared/terminal-themes";
import { parseSettingsPatch } from "../../../src/main/setup/settings";

test("every built-in resolves to a complete portable palette and follow tracks the interface", () => {
  for (const option of terminalThemeOptions) {
    expect(parseTerminalThemeChoice(option.id)).toBe(option.id);
    for (const dark of [false, true])
      expect(isTerminalTheme(resolveTerminalTheme(option.id, dark))).toBe(true);
  }
  expect(resolveTerminalTheme("follow", true)).toEqual(terminalThemes["foom-dark"]);
  expect(resolveTerminalTheme("follow", false)).toEqual(terminalThemes["foom-light"]);
  const custom = { ...terminalThemes.dracula, background: "#ABCDEF" };
  expect(parseSettingsPatch({ terminalTheme: custom })).toEqual({ terminalTheme: custom });
  expect(parseTerminalThemeChoice(custom)).not.toBe(custom);
  expect(resolveTerminalTheme(custom, false)).toEqual(custom);
});
test("main rejects missing keys, unknown keys and malformed colors from IPC or files", () => {
  const theme = terminalThemes.dracula;
  for (const invalid of [null, [], 42, "unknown", "toString", {}, { ...theme, extra: "#ffffff" }]) {
    expect(() => parseSettingsPatch({ terminalTheme: invalid })).toThrow("Invalid terminal theme");
  }
  for (const key of Object.keys(theme)) {
    const missing = Object.fromEntries(Object.entries(theme).filter(([name]) => name !== key));
    expect(isTerminalTheme(missing)).toBe(false);
    for (const color of [
      "red",
      "#123",
      "#12345678",
      "#gggggg",
      "url(x)",
      "rgb:ff/ff/ff",
      "",
      42,
      null,
    ]) {
      expect(() => parseSettingsPatch({ terminalTheme: { ...theme, [key]: color } })).toThrow();
    }
  }
});
