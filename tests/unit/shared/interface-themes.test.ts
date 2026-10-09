import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import {
  interfaceColorNames,
  interfaceHighlightNames,
  validateInterfaceColors,
  interfaceThemes,
  parseInterfaceTheme,
  resolveInterfaceTheme,
  interfaceThemeSource,
} from "../../../src/shared/interface-themes";
import { colorDistance, contrast, hueSaturation } from "../../../src/shared/theme-colors";

test.each(Object.entries(interfaceThemes))(
  "%s is complete and passes the user-theme accessibility and brand gate",
  (_id, theme) => {
    expect(Object.keys(theme.colors).sort()).toEqual(
      [...interfaceColorNames, ...(theme.colors.highlight ? interfaceHighlightNames : [])].sort(),
    );
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

test("accepts legacy 19-key colors and the complete optional highlight pair", () => {
  const legacy = interfaceThemes["eclipse-dark"];
  expect(Object.keys(legacy.colors)).toHaveLength(19);
  expect(parseInterfaceTheme(legacy)).toEqual(legacy);
  // Previously valid custom palettes must not acquire a new accent/done distance rule.
  const custom = { ...legacy, colors: { ...legacy.colors, done: legacy.colors.accent } };
  expect(parseInterfaceTheme(custom)).toEqual(custom);
  const theme = {
    ...legacy,
    colors: { ...legacy.colors, highlight: "#aaaaaa", "highlight-deep": "#555555" },
  };
  expect(parseInterfaceTheme(theme)).toEqual(theme);
  expect(() => {
    validateInterfaceColors(theme.colors);
  }).not.toThrow();
});
test("rejects partial, invalid and additional highlight data at the untrusted boundary", () => {
  const theme = interfaceThemes["eclipse-dark"];
  for (const patch of [
    { highlight: "#aaaaaa" },
    { "highlight-deep": "#555555" },
    { highlight: "#aaaaaa", "highlight-deep": undefined },
    { highlight: "#aaaaaa", "highlight-deep": "url(https://example.com)" },
    { highlight: 123, "highlight-deep": "#555555" },
    { highlight: "#aaaaaa", "highlight-deep": "#555555", extra: "#ffffff" },
  ])
    expect(() =>
      parseInterfaceTheme({ ...theme, colors: { ...theme.colors, ...patch } }),
    ).toThrow();
  expect(() => {
    validateInterfaceColors({ ...theme.colors, highlight: "#aaaaaa" });
  }).toThrow();
});
test.each(["highlight", "highlight-deep"] as const)(
  "%s excludes saturated amber and magenta",
  (key) => {
    const theme = interfaceThemes["eclipse-dark"];
    for (const color of ["#ffbb44", "#ff44aa"])
      expect(() =>
        parseInterfaceTheme({
          ...theme,
          colors: {
            ...theme.colors,
            highlight: "#aaaaaa",
            "highlight-deep": "#555555",
            [key]: color,
          },
        }),
      ).toThrow();
  },
);
test("highlight separates decoration from each status, including lookalikes outside the reserved hues", () => {
  const theme = interfaceThemes["eclipse-dark"];
  // These pass the hue gate but remain perceptually too close to a status light.
  for (const [highlight, status] of [
    ["#fff144", "attention"],
    ["#ff4455", "failed"],
    ["#6fe0a3", "done"],
  ] as const) {
    const { hue, saturation } = hueSaturation(highlight);
    expect(saturation <= 0.2 || !((hue >= 20 && hue <= 55) || (hue >= 310 && hue <= 350))).toBe(
      true,
    );
    expect(colorDistance(highlight, theme.colors[status])).toBeLessThan(40);
    expect(() =>
      parseInterfaceTheme({
        ...theme,
        colors: { ...theme.colors, highlight, "highlight-deep": "#555555" },
      }),
    ).toThrow();
  }
});
test("highlight text meets contrast on both surfaces; its deep shade is decorative", () => {
  const theme = interfaceThemes.graphite;
  for (const highlight of ["#18181b", "#838383"]) {
    expect(contrast(highlight, theme.colors.surface)).toBeLessThan(4.5);
    expect(() =>
      parseInterfaceTheme({ ...theme, colors: { ...theme.colors, highlight } }),
    ).toThrow();
  }
  expect(contrast("#838383", theme.colors.bg)).toBeGreaterThanOrEqual(4.5);
  expect(() =>
    parseInterfaceTheme({ ...theme, colors: { ...theme.colors, "highlight-deep": "#000000" } }),
  ).not.toThrow();
});
