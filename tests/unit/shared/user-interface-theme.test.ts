import darkGradientSample from "../../fixtures/themes/gradient-dark.json";
import lightGradientSample from "../../fixtures/themes/gradient-light.json";
import { colorDistance } from "../../../src/shared/theme-colors";
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

test("new areas, per-area scrollbars and all allowlisted typography choices round trip", () => {
  for (const family of ["geist", "geist-mono", "system", "system-mono"]) {
    for (const type of [
      { family, scale: 0.85, weight: 400, "strong-weight": 500 },
      { family, scale: 1.25, weight: 600, "strong-weight": 800 },
      {},
    ]) {
      const value = {
        ...theme(),
        type,
        areas: {
          titlebar: { bg: "#010101" },
          "tile-headers": { surface: "#010101" },
          board: { bg: "#010101", scrollbar: "#665588" },
          badges: {},
          wordmark: {},
          "dialog-headers": {},
        },
      };
      expect(parse(value)).toMatchObject({ kind: "theme", theme: value });
    }
  }
});

const darkGradient = {
  angle: 359,
  stops: [
    ["#000000", 0],
    ["#050408", 100],
  ],
};
test("gradients accept 2–4 ordered stops on only the fixed safe roots", () => {
  for (const area of ["sidebar", "board", "titlebar", "dialog-headers"]) {
    for (const stops of [
      darkGradient.stops,
      [
        ["#000000", 10],
        ["#010101", 40],
        ["#020202", 60],
        ["#030303", 90],
      ],
    ]) {
      const value = {
        ...theme(),
        areas: { [area]: { bg: "#000000", gradient: { angle: 0, stops } } },
      };
      expect(parse(value)).toMatchObject({ kind: "theme", theme: value });
    }
  }
});

test.each([
  [{ type: null }, "$.type", "invalid-value"],
  [{ type: { url: "file:///font" } }, "$.type", "unknown-key"],
  [{ type: { family: "Arial" } }, "$.type.family", "invalid-value"],
  [{ type: { family: "url(x)" } }, "$.type.family", "invalid-value"],
  [{ type: { scale: 0.84 } }, "$.type.scale", "invalid-value"],
  [{ type: { scale: 1.26 } }, "$.type.scale", "invalid-value"],
  [{ type: { weight: 399 } }, "$.type.weight", "invalid-value"],
  [{ type: { weight: 601 } }, "$.type.weight", "invalid-value"],
  [{ type: { "strong-weight": 499 } }, "$.type.strong-weight", "invalid-value"],
  [{ type: { "strong-weight": 801 } }, "$.type.strong-weight", "invalid-value"],
  [{ type: { scale: "1" } }, "$.type.scale", "invalid-value"],
  [{ type: { scale: null } }, "$.type.scale", "invalid-value"],
  [{ areas: { board: { scrollbar: "url(x)" } } }, "$.areas.board.scrollbar", "not-a-color"],
  [{ areas: { "tile-headers": { ink: "#000000" } } }, "$.areas.tile-headers.ink", "contrast"],
  [{ version: 1, type: {} }, "$", "unknown-key"],
])("rejects invalid area and type fields (%#)", (patch, path, reason) => {
  expect(() => parse({ ...theme(), ...patch })).toThrow(expect.objectContaining({ path, reason }));
});

test.each([
  [null, "$.areas.sidebar.gradient", "invalid-value"],
  [{ ...darkGradient, url: "x" }, "$.areas.sidebar.gradient", "unknown-key"],
  [{ stops: darkGradient.stops }, "$.areas.sidebar.gradient.angle", "missing-key"],
  [{ ...darkGradient, angle: -1 }, "$.areas.sidebar.gradient.angle", "invalid-value"],
  [{ ...darkGradient, angle: 360 }, "$.areas.sidebar.gradient.angle", "invalid-value"],
  [{ ...darkGradient, stops: [] }, "$.areas.sidebar.gradient.stops", "invalid-value"],
  [{ ...darkGradient, stops: "x" }, "$.areas.sidebar.gradient.stops", "invalid-value"],
  [
    { ...darkGradient, stops: Array.from({ length: 5 }, () => ["#000000", 0]) },
    "$.areas.sidebar.gradient.stops",
    "invalid-value",
  ],
  [
    { ...darkGradient, stops: [["#000000"], ["#000000", 100]] },
    "$.areas.sidebar.gradient.stops[0]",
    "invalid-value",
  ],
  [
    { ...darkGradient, stops: [null, ["#000000", 100]] },
    "$.areas.sidebar.gradient.stops[0]",
    "invalid-value",
  ],
  [
    {
      ...darkGradient,
      stops: [
        ["#fff", 0],
        ["#000000", 100],
      ],
    },
    "$.areas.sidebar.gradient.stops[0][0]",
    "not-a-color",
  ],
  [
    {
      ...darkGradient,
      stops: [
        ["#00000000", 0],
        ["#000000", 100],
      ],
    },
    "$.areas.sidebar.gradient.stops[0][0]",
    "not-a-color",
  ],
  [
    {
      ...darkGradient,
      stops: [
        ["url(x)", 0],
        ["#000000", 100],
      ],
    },
    "$.areas.sidebar.gradient.stops[0][0]",
    "not-a-color",
  ],
  [
    {
      ...darkGradient,
      stops: [
        ["#000000", -1],
        ["#000000", 100],
      ],
    },
    "$.areas.sidebar.gradient.stops[0][1]",
    "invalid-value",
  ],
  [
    {
      ...darkGradient,
      stops: [
        ["#000000", 0],
        ["#000000", 101],
      ],
    },
    "$.areas.sidebar.gradient.stops[1][1]",
    "invalid-value",
  ],
  [
    {
      ...darkGradient,
      stops: [
        ["#000000", 50],
        ["#000000", 50],
      ],
    },
    "$.areas.sidebar.gradient.stops[1][1]",
    "invalid-value",
  ],
  [
    {
      ...darkGradient,
      stops: [
        ["#ffffff", 0],
        ["#ffffff", 100],
      ],
    },
    "$.areas.sidebar.gradient.stops[0]",
    "contrast",
  ],
])("rejects malformed or unreadable gradients (%#)", (gradient, path, reason) => {
  expect(() => parse({ ...theme(), areas: { sidebar: { bg: "#000000", gradient } } })).toThrow(
    expect.objectContaining({ path, reason }),
  );
});

test("gradients require a solid fallback and refuse terminal-content roots with a fixed reason", () => {
  expect(() => parse({ ...theme(), areas: { sidebar: { gradient: darkGradient } } })).toThrow(
    expect.objectContaining({ path: "$.areas.sidebar.bg", reason: "missing-key" }),
  );
  for (const area of ["tiles", "tile-headers", "panels", "dialogs", "menus", "badges", "wordmark"])
    expect(() =>
      parse({ ...theme(), areas: { [area]: { bg: "#000000", gradient: darkGradient } } }),
    ).toThrow(
      expect.objectContaining({ path: `$.areas.${area}.gradient`, reason: "gradient-not-allowed" }),
    );
});

test("rejects both straddling and red-to-green sRGB interior contrast failures", () => {
  const inks = ["ink", "muted", "accent", "attention-ink", "done-ink", "failed-ink", "highlight"];
  for (const [ink, bg, stops] of [
    [
      "#000000",
      "#ffffff",
      [
        ["#ff0000", 0],
        ["#009400", 100],
      ],
    ],
    [
      "#757575",
      "#000000",
      [
        ["#000000", 0],
        ["#ffffff", 100],
      ],
    ],
  ] as const) {
    const colors = {
      ...base.colors,
      bg,
      surface: bg,
      "highlight-deep": "#010101",
      ...Object.fromEntries(inks.map((role) => [role, ink])),
    };
    const value = {
      ...theme(),
      colors,
      areas: { sidebar: { bg, gradient: { angle: 45, stops } } },
    };
    // Each endpoint alone passes: the failure is inside the interpolated segment.
    for (const [color] of stops)
      expect(() =>
        parse({
          ...value,
          areas: {
            sidebar: {
              bg,
              gradient: {
                angle: 45,
                stops: [
                  [color, 0],
                  [color, 100],
                ],
              },
            },
          },
        }),
      ).not.toThrow();
    expect(() => parse(value)).toThrow(
      expect.objectContaining({ path: "$.areas.sidebar.gradient", reason: "contrast" }),
    );
  }
});

test("gradient stops and local scrollbars participate in warnings and approval pair comparisons", () => {
  const value = {
    ...theme(),
    colors: { ...base.colors, attention: "#010101" },
    areas: { sidebar: { bg: "#000000", gradient: darkGradient, scrollbar: "#010101" } },
  };
  const parsed = parse(value);
  expect(parsed.kind === "theme" && parsed.warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: "$.areas.sidebar.gradient.stops[0]",
        reason: "attention-distinctness",
      }),
      expect.objectContaining({
        path: "$.areas.sidebar.scrollbar",
        reason: "attention-distinctness",
      }),
    ]),
  );
  if (parsed.kind !== "theme") throw Error("Wrong kind");
  expect(attentionConflicts(parsed.theme)).toEqual(
    expect.arrayContaining([
      "sidebar:gradient[0]~attention",
      "sidebar:gradient[1]~attention",
      "sidebar:attention~scrollbar",
    ]),
  );
});

test.each([darkGradientSample, lightGradientSample])(
  "gradient sample $base stays readable and visibly varied",
  (sample) => {
    const parsed = parse(sample);
    expect(parsed.kind).toBe("theme");
    if (parsed.kind !== "theme") throw Error("Wrong kind");
    expect(parsed.warnings ?? []).toEqual([]);
    expect(attentionConflicts(parsed.theme)).toEqual([]);
    for (const area of ["sidebar", "board"] as const) {
      const stops = parsed.theme.areas?.[area]?.gradient?.stops;
      const first = stops?.[0]?.[0],
        last = stops?.at(-1)?.[0];
      if (!first || !last) throw Error("Missing sample gradient");
      expect(colorDistance(first, last)).toBeGreaterThanOrEqual(40);
    }
  },
);

test("transparent child inks reject white on white across parent solid and gradient paints", () => {
  const light = interfaceThemes["eclipse-light"].colors;
  const white = {
    angle: 0,
    stops: [
      ["#ffffff", 0],
      ["#ffffff", 100],
    ],
  };
  for (const parent of ["titlebar", "sidebar"] as const) {
    for (const gradient of [undefined, white]) {
      const value = {
        ...theme(),
        areas: {
          [parent]: { ...light, bg: "#ffffff", ...(gradient ? { gradient } : {}) },
          wordmark: { ink: "#f4efff" },
        },
      };
      expect(() => parse(value)).toThrow(
        expect.objectContaining({ path: "$.areas.wordmark.ink", reason: "contrast" }),
      );
    }
  }
  for (const parent of ["sidebar", "panels", "dialogs", "dialog-headers"] as const) {
    const value = {
      ...theme(),
      areas: {
        [parent]: {
          ...light,
          bg: "#ffffff",
          ...(parent === "dialog-headers" ? { gradient: white } : {}),
        },
        badges: { ink: "#f4efff" },
      },
    };
    expect(() => parse(value)).toThrow(
      expect.objectContaining({ path: "$.areas.badges.ink", reason: "contrast" }),
    );
  }
});

test("transparent child checks include parent gradient interiors and launch's actual hole", () => {
  const whiteInks = Object.fromEntries(
    ["ink", "muted", "accent", "attention-ink", "done-ink", "failed-ink", "highlight"].map(
      (role) => [role, "#ffffff"],
    ),
  );
  const parentColors = {
    ...base.colors,
    ...whiteInks,
    "highlight-deep": "#010101",
    bg: "#757575",
    surface: "#757575",
  };
  for (const child of ["wordmark", "badges"] as const) {
    const parent = child === "wordmark" ? "titlebar" : "dialog-headers";
    for (const stops of [
      [
        ["#ec0000", 0],
        ["#008900", 100],
      ],
      [
        ["#101010", 0],
        ["#101010", 100],
      ],
    ]) {
      const value = {
        ...interfaceThemes["eclipse-light"],
        version: 2,
        areas: {
          [parent]: { ...parentColors, gradient: { angle: 0, stops } },
        },
      };
      // Parent white inks pass. The transparent black child fails at a stop or inside a segment.
      expect(() => parse(value)).not.toThrow();
      expect(() =>
        parse({ ...value, areas: { ...value.areas, [child]: { ink: "#000000" } } }),
      ).toThrow(expect.objectContaining({ path: `$.areas.${child}.ink`, reason: "contrast" }));
    }
  }
  expect(() =>
    parse({ ...theme(), areas: { wordmark: { hole: "#ffffff", "space-ink": "#000000" } } }),
  ).toThrow(expect.objectContaining({ path: "$.areas.wordmark.space-ink", reason: "contrast" }));
});
