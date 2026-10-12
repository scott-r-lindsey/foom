import { expect, test } from "vitest";
import { interfaceThemes } from "../../../src/shared/interface-themes";
import { parseThemeFile } from "../../../src/shared/theme-files";
import { validateConfigJson } from "../../../src/shared/config-files";
import { attentionConflicts, userThemeWarnings } from "../../../src/shared/user-interface-theme";
const base = interfaceThemes["eclipse-dark"];
const theme = () => ({ ...base, version: 2 });
const parse = (value: unknown) => parseThemeFile(JSON.stringify(value), "theme");

test("version 1 and 2 preserve palettes and optional area, state and shape data", () => {
  expect(parse(base)).toEqual({ kind: "theme", theme: base });
  const value = {
    ...theme(),
    areas: { sidebar: { bg: "#010101", highlight: "#ffffff" }, menus: {} },
    states: { selected: "#123456", hover: "#123456", focus: "#123456", scrollbar: "#123456" },
    shape: { radius: 0, "panel-radius": 16, border: 2, shadow: 1 },
  };
  expect(parse(value)).toMatchObject({ kind: "theme", theme: value });
  expect(validateConfigJson(JSON.stringify(value))).toEqual([]);
});

test.each([
  [{ version: 3 }, "$.version", "invalid-value"],
  [{ areas: { secret: {} } }, "$.areas", "unknown-key"],
  [{ areas: { sidebar: { font: "evil" } } }, "$.areas.sidebar", "unknown-key"],
  [{ areas: { sidebar: { bg: "var(--x)" } } }, "$.areas.sidebar.bg", "not-a-color"],
  [{ areas: { sidebar: { bg: "#ffffff" } } }, "$.areas.sidebar.ink", "contrast"],
  [{ areas: { menus: { "badge-fill": "#ffffff" } } }, "$.areas.menus.badge-ink", "contrast"],
  [{ states: { font: "x" } }, "$.states", "unknown-key"],
  [{ states: { focus: "url(x)" } }, "$.states.focus", "not-a-color"],
  [{ shape: { radius: -1 } }, "$.shape.radius", "invalid-value"],
  [{ shape: { radius: 13 } }, "$.shape.radius", "invalid-value"],
  [{ shape: { "panel-radius": 17 } }, "$.shape.panel-radius", "invalid-value"],
  [{ shape: { border: 3 } }, "$.shape.border", "invalid-value"],
  [{ shape: { shadow: 1.1 } }, "$.shape.shadow", "invalid-value"],
  [{ shape: { shadow: "1" } }, "$.shape.shadow", "invalid-value"],
  [{ shape: { other: 1 } }, "$.shape", "unknown-key"],
  [{ shape: null }, "$.shape", "invalid-value"],
])("rejects invalid nested input with a fixed path (%#)", (patch, path, reason) => {
  expect(() => parse({ ...theme(), ...patch })).toThrow(expect.objectContaining({ path, reason }));
});

test("brand deviations warn and contrast still rejects", () => {
  for (const [patch, reason] of [
    [{ base: "light" }, "base-luminance"],
    [
      {
        colors: {
          ...base.colors,
          highlight: base.colors.accent,
          "highlight-deep": base.colors["accent-deep"],
        },
      },
      "color-distance",
    ],
    [{ colors: { ...base.colors, hole: "#010101" } }, "hole-color"],
    [{ colors: { ...base.colors, ink: "#ffb23e" } }, "reserved-color"],
    [{ colors: { ...base.colors, attention: base.colors.ink } }, "attention-distinctness"],
    [{ colors: { ...base.colors, failed: base.colors.accent } }, "color-distance"],
    [{ colors: { ...base.colors, "failed-ink": base.colors.accent } }, "reserved-color"],
    [{ colors: { ...base.colors, "attention-ink": base.colors.accent } }, "attention-distinctness"],
  ] as const) {
    const parsed = parse({ ...theme(), ...patch });
    expect(parsed.kind === "theme" && parsed.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: "warning", reason })]),
    );
  }
  expect(() =>
    parse({
      ...theme(),
      colors: { ...base.colors, highlight: "#05040a", "highlight-deep": "#05040a" },
    }),
  ).toThrow(expect.objectContaining({ reason: "contrast", path: "$.colors.highlight" }));
  const warnings = userThemeWarnings({
    ...base,
    areas: { panels: { attention: base.colors.ink } },
  });
  expect(warnings).toContainEqual(
    expect.objectContaining({ path: "$.areas.panels.attention", reason: "attention-distinctness" }),
  );
});

test("attention conflicts name each pair, and areas list only pairs the palette lacks", () => {
  const colors = { ...base.colors, attention: base.colors.done };
  expect(attentionConflicts({ ...base, colors })).toEqual([
    "colors:attention~done",
    "colors:attention~done-ink",
  ]);
  // An area inheriting the global pair adds nothing; its own new pair is listed.
  expect(
    attentionConflicts({
      ...base,
      colors,
      areas: { sidebar: {}, menus: { muted: base.colors.done } },
    }),
  ).toEqual(["colors:attention~done", "colors:attention~done-ink", "menus:attention~muted"]);
  expect(
    attentionConflicts({
      ...base,
      colors: { ...base.colors, "attention-ink": base.colors["failed-ink"] },
    }),
  ).toContain("colors:attention-ink~failed-ink");
  expect(attentionConflicts(base)).toEqual([]);
});
