import { expect, test } from "vitest";
import { interfaceThemes } from "../../../src/shared/interface-themes";
import { ansiNames, terminalThemes } from "../../../src/shared/terminal-themes";
import { parseThemeFile } from "../../../src/shared/theme-files";
import { isUserThemeId, ThemeValidationError } from "../../../src/shared/theme-validation";
const valid = () => ({
  kind: "theme",
  name: "Custom",
  base: "dark",
  colors: { ...interfaceThemes["eclipse-dark"].colors },
});
test("built-in interface palettes pass the file gate", () => {
  for (const theme of Object.values(interfaceThemes))
    expect(
      parseThemeFile(
        JSON.stringify({ kind: "theme", name: theme.name, base: theme.base, colors: theme.colors }),
        "theme",
      ),
    ).toEqual({ kind: "theme", theme });
});
test("built-in terminal palettes pass the portable ANSI file gate", () => {
  for (const theme of Object.values(terminalThemes)) {
    const result = parseThemeFile(
      JSON.stringify({
        kind: "terminal-theme",
        name: "Terminal",
        background: theme.background,
        foreground: theme.foreground,
        cursor: theme.cursor,
        ansi: ansiNames.map((key) => theme[key]),
      }),
      "terminal-theme",
    );
    expect(result).toMatchObject({
      kind: "terminal-theme",
      name: "Terminal",
      theme: { background: theme.background, foreground: theme.foreground, red: theme.red },
    });
  }
});
test.each([
  ["broken", "malformed-json", "$"],
  [" ".repeat(65537), "too-large", "$"],
  ["null", "invalid-value", "$"],
  ["[]", "invalid-value", "$"],
  [JSON.stringify({ ...valid(), id: "eclipse-dark" }), "unknown-key", "$"],
  [JSON.stringify({ ...valid(), kind: "terminal-theme" }), "invalid-value", "$.kind"],
  [JSON.stringify({ ...valid(), name: "<script>" }), "invalid-value", "$.name"],
  [JSON.stringify({ ...valid(), name: " " }), "invalid-value", "$.name"],
  [JSON.stringify({ ...valid(), base: "other" }), "invalid-value", "$.base"],
  [JSON.stringify({ ...valid(), base: "light" }), "invalid-value", "$.base"],
  [JSON.stringify({ ...valid(), colors: null }), "invalid-value", "$.colors"],
  [
    JSON.stringify({ ...valid(), colors: { ...valid().colors, extra: "#000000" } }),
    "unknown-key",
    "$.colors",
  ],
  [JSON.stringify({ ...valid(), colors: {} }), "missing-key", "$.colors.bg"],
  ...["var(--bad)", "url(https://example.org)", "#fff; color:red", null, "#fff"].map((color) => [
    JSON.stringify({ ...valid(), colors: { ...valid().colors, accent: color } }),
    "not-a-color",
    "$.colors.accent",
  ]),
  ...["#ffb23e", "#ff2e88"].flatMap((color) =>
    ["accent", "highlight"].map((key) => [
      JSON.stringify({
        ...valid(),
        colors: {
          ...valid().colors,
          highlight: "#9b6bff",
          "highlight-deep": "#7a3cff",
          [key]: color,
        },
      }),
      "reserved-color",
      `$.colors.${key}`,
    ]),
  ),
  [
    JSON.stringify({ ...valid(), colors: { ...valid().colors, ink: "#05040a" } }),
    "contrast",
    "$.colors.ink",
  ],
  [
    JSON.stringify({ ...valid(), colors: { ...valid().colors, highlight: "#9b6bff" } }),
    "missing-key",
    "$.colors.highlight-deep",
  ],
  [
    JSON.stringify({ ...valid(), colors: { ...valid().colors, "highlight-deep": "#7a3cff" } }),
    "missing-key",
    "$.colors.highlight",
  ],
])(
  "rejects hostile interface input with a fixed reason and JSON path (%#)",
  (text, reason, path) => {
    expect(() => parseThemeFile(text, "theme")).toThrow(expect.objectContaining({ reason, path }));
  },
);
test("terminal syntax and exact keys are enforced", () => {
  const theme = terminalThemes["foom-dark"];
  const file = {
    kind: "terminal-theme",
    name: "Terminal",
    background: theme.background,
    foreground: theme.foreground,
    cursor: theme.cursor,
    ansi: ansiNames.map((key) => theme[key]),
  };
  for (const patch of [
    { ansi: [] },
    { ansi: null },
    { ansi: [...file.ansi.slice(0, 15), "url(x)"] },
    { cursor: "#fff" },
    { id: "dracula" },
  ])
    expect(() => parseThemeFile(JSON.stringify({ ...file, ...patch }), "terminal-theme")).toThrow(
      ThemeValidationError,
    );
});
test("user IDs accept only direct bounded JSON filenames", () => {
  expect(isUserThemeId("user:my-theme.json")).toBe(true);
  for (const value of [
    null,
    "eclipse-dark",
    "user:../evil.json",
    "user:.hidden.json",
    "user:a/b.json",
    "user:a\\b.json",
    `user:${"a".repeat(100)}.json`,
  ])
    expect(isUserThemeId(value)).toBe(false);
});
