import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import {
  interfaceColorNames,
  interfaceThemes,
  parseInterfaceTheme,
  resolveInterfaceTheme,
  interfaceThemeSource,
} from "../../../src/shared/interface-themes";
import { colorDistance, contrast, hueSaturation } from "../../../src/shared/theme-colors";

test.each(Object.entries(interfaceThemes))(
  "%s is complete and passes the user-theme accessibility and brand gate",
  (_id, theme) => {
    expect(Object.keys(theme.colors).sort()).toEqual([...interfaceColorNames].sort());
    expect(parseInterfaceTheme(theme)).toEqual(theme);
    expect(parseInterfaceTheme(theme)).not.toBe(theme);
    for (const bg of ["bg", "surface"] as const)
      for (const ink of [
        "attention-ink",
        "failed-ink",
        "done-ink",
        "accent",
        "ink",
        "muted",
      ] as const)
        expect(
          contrast(theme.colors[ink], theme.colors[bg]),
          `${ink} on ${bg}`,
        ).toBeGreaterThanOrEqual(4.5);
    for (const [a, b] of [
      ["attention", "failed"],
      ["attention", "accent"],
      ["failed", "accent"],
    ] as const)
      expect(colorDistance(theme.colors[a], theme.colors[b]), `${a}/${b}`).toBeGreaterThanOrEqual(
        40,
      );
  },
);
test("theme data includes every CSS color token and preserves the initial Eclipse fallback", async () => {
  const css = await readFile("src/renderer/styles/tokens.css", "utf8");
  const blocks = css.split(":root {").slice(1);
  for (const [index, theme] of [
    interfaceThemes["eclipse-light"],
    interfaceThemes["eclipse-dark"],
  ].entries()) {
    const values: Record<string, string> = {};
    for (const match of String(blocks[index]).matchAll(/--([\w-]+):\s*(#[\da-f]{6});/gi)) {
      const [, key, value] = match;
      if (key && value) values[key] = value;
    }
    // space-ink is shared by both CSS modes.
    if (index === 1) values["space-ink"] = "#f4efff";
    expect(values).toEqual(theme.colors);
  }
});
test("high contrast exceeds 7:1 for all readable text and 3:1 for boundaries", () => {
  const c = interfaceThemes["high-contrast"].colors;
  for (const bg of ["bg", "surface"] as const) {
    for (const ink of [
      "ink",
      "muted",
      "accent",
      "attention-ink",
      "failed-ink",
      "done-ink",
    ] as const)
      expect(contrast(c[ink], c[bg]), `${ink}/${bg}`).toBeGreaterThanOrEqual(7);
    expect(contrast(c.line, c[bg])).toBeGreaterThanOrEqual(3);
  }
});
test("rejects incomplete data, extra tokens, CSS injection, wrong status meanings and unreadable colors", () => {
  const theme = interfaceThemes["eclipse-dark"];
  for (const value of [
    null,
    [],
    3,
    "toString",
    "other",
    {},
    { ...theme, version: 2 },
    { ...theme, base: "sepia" },
    { ...theme, base: "light" },
    { ...theme, name: 2 },
    { ...theme, name: "<b>bad</b>" },
    { ...theme, extra: true },
    { ...theme, colors: [] },
    { ...theme, colors: { ...theme.colors, bg: "url(https://example.com)" } },
    { ...theme, colors: { ...theme.colors, newToken: "#000000" } },
    ...[
      { hole: "#000000" },
      { "attention-ink": theme.colors.accent },
      { failed: theme.colors.attention },
      { "badge-fill": theme.colors.attention },
      { ink: "#111111" },
      { "badge-ink": theme.colors["badge-fill"] },
      { "space-ink": theme.colors.hole },
      { accent: "#cccccc" },
      { muted: "#ee88ba" },
      { accent: "#a18bba" },
      { accent: "#f3e5ff", failed: "#ffe5f2", "failed-ink": "#ffe5f2" },
    ].map((patch) => ({ ...theme, colors: { ...theme.colors, ...patch } })),
  ])
    expect(() => parseInterfaceTheme(value), JSON.stringify(value)).toThrow();
});
test("resolves fixed, custom and legacy System/Light/Dark choices", () => {
  expect(parseInterfaceTheme("follow")).toBe("follow");
  for (const id of Object.keys(interfaceThemes)) expect(parseInterfaceTheme(id)).toBe(id);
  expect(resolveInterfaceTheme("follow", true)).toBe(interfaceThemes["eclipse-dark"]);
  expect(resolveInterfaceTheme("follow", false)).toBe(interfaceThemes["eclipse-light"]);
  expect(resolveInterfaceTheme("moonlight", true)).toBe(interfaceThemes.moonlight);
  expect(resolveInterfaceTheme(interfaceThemes.moonlight, true)).toBe(interfaceThemes.moonlight);
  expect(interfaceThemeSource("follow", "system")).toBe("system");
  expect(interfaceThemeSource("deep-field", "light")).toBe("dark");
  expect(interfaceThemeSource(interfaceThemes.moonlight, "dark")).toBe("light");
});
test("color math agrees with reference values and handles neutral colors", () => {
  expect(contrast("#ffffff", "#000000")).toBe(21);
  expect(contrast("#000000", "#ffffff")).toBe(21);
  expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.478, 3);
  expect(colorDistance("#000000", "#ffffff")).toBeCloseTo(100, 3);
  expect(colorDistance("#ff0000", "#00ff00")).toBeCloseTo(170.565, 3);
  expect(colorDistance("#777777", "#777777")).toBe(0);
  expect(hueSaturation("#888888")).toEqual({ hue: 0, saturation: 0 });
  expect(hueSaturation("#00ff00")).toEqual({ hue: 120, saturation: 1 });
});
