import { expect, test } from "vitest";
import {
  configJson,
  parseSettingsFile,
  validateConfigJson,
} from "../../../src/shared/config-files";
import { parseConfigSettings } from "../../../src/shared/config-settings";
import { DEFAULT_SOUND } from "../../../src/shared/sounds";
import { interfaceThemes } from "../../../src/shared/interface-themes";
import { ansiNames, terminalThemes } from "../../../src/shared/terminal-themes";
import { parseSettingsPatch } from "../../../src/main/setup/settings";
const allowed = {
  colorMode: "dark",
  panelColor: "plain",
  interfaceTheme: "user:custom.json",
  interfaceScale: 120,
  terminalFontSize: 16,
  terminalTheme: "user:terminal.json",
  sound: DEFAULT_SOUND,
  agents: { claude: false, codex: true, agy: false },
  hooks: false,
};
test("settings is an optional allowlisted patch with exactly main's value rules", () => {
  expect(parseSettingsFile('{"kind":"settings"}')).toEqual({});
  expect(parseSettingsFile(JSON.stringify({ kind: "settings", ...allowed }))).toEqual(allowed);
  expect(parseSettingsPatch(allowed)).toEqual(allowed);
  for (const colorMode of ["system", "light", "dark"])
    expect(parseConfigSettings({ colorMode })).toEqual({ colorMode });
  for (const panelColor of ["vivid", "subtle", "plain"])
    expect(parseConfigSettings({ panelColor })).toEqual({ panelColor });
  for (const interfaceScale of [80, 90, 100, 110, 120, 130, 140, 150])
    expect(parseConfigSettings({ interfaceScale })).toEqual({ interfaceScale });
  expect(
    parseSettingsFile('{"kind":"settings","interfaceTheme":"follow","terminalTheme":"dracula"}'),
  ).toEqual({ interfaceTheme: "follow", terminalTheme: "dracula" });
});
test.each([
  "agentArguments",
  "agentBypassAcknowledged",
  "codexNotifierAcknowledged",
  "setupComplete",
  "codeFolder",
  "worktreeLocation",
  "environment",
])("rejects excluded %s with a fixed field-specific reason", (key) => {
  expect(() => parseSettingsFile(JSON.stringify({ kind: "settings", [key]: null }))).toThrow(
    expect.objectContaining({ path: `$.${key}`, reason: "unknown-key" }),
  );
});
test.each([
  ["colorMode", "auto"],
  ["panelColor", "red"],
  ["hooks", 0],
  ["agents", null],
  ["agents", { claude: true }],
  ["agents", { claude: true, codex: true, agy: 1 }],
  ["agents", { claude: true, codex: true, agy: true, evil: true }],
  ["interfaceScale", 101],
  ["interfaceScale", "100"],
  ["terminalFontSize", 9],
  ["terminalFontSize", 33],
  ["terminalFontSize", 12.5],
  ["terminalFontSize", "14"],
  ["sound", {}],
  ["interfaceTheme", "unknown"],
  ["terminalTheme", "user:../escape.json"],
  ["interfaceTheme", {}],
  ["terminalTheme", {}],
])("rejects invalid %s in file and main patches", (key, value) => {
  expect(() => parseSettingsFile(JSON.stringify({ kind: "settings", [key]: value }))).toThrow();
  expect(() => parseSettingsPatch({ [key]: value })).toThrow();
});
test("does not expose arbitrary property text, and rejects malformed, oversized and unknown kinds", () => {
  expect(() => parseConfigSettings({ "secret\nkey": true })).toThrow(
    expect.objectContaining({ path: "$", reason: "unknown-key" }),
  );
  expect(() => parseSettingsFile('{"kind":"theme"}')).toThrow(
    expect.objectContaining({ path: "$.kind" }),
  );
  expect(() => parseSettingsFile("{}")).toThrow(expect.objectContaining({ reason: "missing-key" }));
  expect(() => configJson("x")).toThrow(expect.objectContaining({ reason: "malformed-json" }));
  expect(() => configJson(" ".repeat(65537))).toThrow(
    expect.objectContaining({ reason: "too-large" }),
  );
  expect(() => configJson("null")).toThrow(expect.objectContaining({ reason: "invalid-value" }));
  expect(() => {
    validateConfigJson("{}");
  }).toThrow(expect.objectContaining({ path: "$.kind" }));
});
test("dispatches each kind to its shared parser and refuses folder mismatches", () => {
  const terminal = terminalThemes.dracula;
  const theme = interfaceThemes["eclipse-dark"];
  for (const value of [
    { kind: "settings", ...allowed },
    { kind: "theme", name: theme.name, base: theme.base, colors: theme.colors },
    {
      kind: "terminal-theme",
      name: "Terminal",
      background: terminal.background,
      foreground: terminal.foreground,
      cursor: terminal.cursor,
      ansi: ansiNames.map((key) => terminal[key]),
    },
  ]) {
    expect(() => {
      validateConfigJson(JSON.stringify(value));
    }).not.toThrow();
    expect(() => {
      validateConfigJson(JSON.stringify(value), value.kind === "settings" ? "theme" : "settings");
    }).toThrow(expect.objectContaining({ path: "$.kind", reason: "invalid-value" }));
  }
});

test.each(["inference", "inferenceTimeoutMs"])(
  "removed %s is rejected as an unknown key",
  (key) => {
    expect(() => parseSettingsFile(JSON.stringify({ kind: "settings", [key]: null }))).toThrow(
      expect.objectContaining({ path: "$", reason: "unknown-key" }),
    );
  },
);
