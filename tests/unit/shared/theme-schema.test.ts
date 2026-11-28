import Ajv from "ajv/dist/2020";
import { expect, test } from "vitest";
import { OWNED_FILES } from "../../../src/main/config/layout";
import { interfaceThemes } from "../../../src/shared/interface-themes";
import { parseThemeFile } from "../../../src/shared/theme-files";

test("generated theme schema and parser agree on versioned structural examples", () => {
  const schema: unknown = JSON.parse(OWNED_FILES["schemas/theme.schema.json"] ?? "{}");
  if (typeof schema !== "object" || !schema) throw Error("Missing schema");
  const validate = new Ajv().compile(schema);
  const base = interfaceThemes["eclipse-dark"];
  const legacy = { kind: "theme", name: base.name, base: base.base, colors: base.colors };
  for (const value of [
    legacy,
    { ...legacy, version: 1 },
    base,
    { ...base, version: 2 },
    {
      ...base,
      version: 2,
      type: { family: "system", scale: 1.25, weight: 600, "strong-weight": 800 },
      areas: {
        sidebar: {
          bg: "#000000",
          scrollbar: "#665588",
          gradient: {
            angle: 90,
            stops: [
              ["#000000", 0],
              ["#020202", 100],
            ],
          },
        },
        titlebar: {},
        "tile-headers": {},
        board: {},
        badges: {},
        wordmark: {},
        "dialog-headers": {},
      },
    },
    {
      ...base,
      version: 2,
      areas: { panels: { bg: "#010101" } },
      states: { hover: "#123456" },
      shape: { radius: 0, border: 2, shadow: 1 },
    },
  ]) {
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    expect(() => parseThemeFile(JSON.stringify(value), "theme")).not.toThrow();
  }
  for (const patch of [
    { version: 3 },
    { type: { family: "url(x)" } },
    { type: { scale: 2 } },
    { type: { weight: 100 } },
    {
      areas: {
        tiles: {
          bg: "#000000",
          gradient: {
            angle: 0,
            stops: [
              ["#000000", 0],
              ["#000000", 100],
            ],
          },
        },
      },
    },
    {
      areas: {
        sidebar: {
          gradient: {
            angle: 0,
            stops: [
              ["#000000", 0],
              ["#000000", 100],
            ],
          },
        },
      },
    },
    { areas: { sidebar: { bg: "#000000", gradient: { angle: 360, stops: [] } } } },
    { version: null },
    { areas: { secret: {} } },
    { areas: { menus: { bg: "url(x)" } } },
    { states: { other: "#123456" } },
    { shape: { radius: 13 } },
    { shape: { border: -1 } },
    { colors: { ...base.colors, highlight: "#ffffff" } },
    { extra: 1 },
  ]) {
    const value = { ...base, version: 2, ...patch };
    expect(validate(value)).toBe(false);
    expect(() => parseThemeFile(JSON.stringify(value), "theme")).toThrow();
  }
});

test("bitmap schema agrees with the parser on fixed slots, direct names and paint bounds", () => {
  const schema: unknown = JSON.parse(OWNED_FILES["schemas/theme.schema.json"] ?? "{}");
  if (typeof schema !== "object" || !schema) throw Error("Missing schema");
  const validate = new Ajv().compile(schema);
  const base = { ...interfaceThemes["eclipse-dark"], version: 2 };
  const value = {
    ...base,
    images: {
      board: { file: "Board 1.PNG" },
      gutter: { file: "gutter.webp", opacity: 0.05, fit: "cover", anchor: "top-right" },
      "tile-header": { files: ["a.png", "b.png"] },
      sidebar: { file: "lower.jpeg", opacity: 0.6, fit: "tile", anchor: "bottom" },
    },
  };
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
  const parsed = parseThemeFile(JSON.stringify(value), "theme");
  if (parsed.kind !== "theme") throw Error("Expected interface theme");
  expect(parsed).toMatchObject({
    images: {
      empty: [
        { file: "Board 1.PNG", opacity: 0.25, fit: "contain", anchor: "center" },
        { file: "gutter.webp", opacity: 0.05, fit: "cover", anchor: "top-right" },
      ],
      "tile-header": [{ file: "a.png" }, { file: "b.png" }],
    },
  });
  expect(parsed.warnings?.filter(({ reason }) => reason === "legacy-image-slot")).toEqual([
    { file: "", path: "$.images.board", reason: "legacy-image-slot", severity: "warning" },
    { file: "", path: "$.images.gutter", reason: "legacy-image-slot", severity: "warning" },
  ]);
  for (const patch of [
    { version: 1, images: value.images },
    { images: { empty: {} } },
    { images: { empty: { files: [] } } },
    { images: { empty: { files: "art.png" } } },
    { images: { empty: { files: [42] } } },
    { images: { empty: { files: ["art.png"], file: "art.png" } } },
    { images: { empty: { files: Array.from({ length: 9 }, (_, i) => `art-${String(i)}.png`) } } },
    { images: { terminal: { file: "board.png" } } },
    { images: { board: "board.png" } },
    { images: { board: { file: "/board.png" } } },
    { images: { board: { file: "sub/board.png" } } },
    { images: { board: { file: "sub\\board.png" } } },
    { images: { board: { file: "board.gif" } } },
    { images: { board: { file: "board.png", opacity: 0.04 } } },
    { images: { board: { file: "board.png", opacity: 0.61 } } },
    { images: { board: { file: "board.png", tint: "transparent" } } },
    { images: { board: { file: "board.png", anchor: "15% 20%" } } },
    { images: { board: { file: "board.png", fit: "fill" } } },
  ]) {
    const invalid = { ...base, ...patch };
    expect(validate(invalid)).toBe(false);
    expect(() => parseThemeFile(JSON.stringify(invalid), "theme")).toThrow();
  }
});

test("legacy gutter maps to empty, and an explicit empty slot takes precedence", () => {
  const base = { ...interfaceThemes["eclipse-dark"], version: 2 };
  const gutter = { file: "gutter.png", fit: "cover" };
  const parse = (images: object) => parseThemeFile(JSON.stringify({ ...base, images }), "theme");
  expect(parse({ gutter })).toMatchObject({
    images: { empty: [{ file: "gutter.png", fit: "cover" }] },
  });
  const explicit = parse({ gutter, empty: { files: ["new.png", "new.png"] } });
  if (explicit.kind !== "theme") throw Error("Expected interface theme");
  expect(explicit).toMatchObject({
    images: { empty: [{ file: "new.png", fit: "contain" }] },
  });
  expect(explicit.warnings).toContainEqual({
    file: "",
    path: "$.images.gutter",
    reason: "legacy-image-slot",
    severity: "warning",
  });
});

test("bitmap styles inherit defaults and validate each whole entry", () => {
  const schema: unknown = JSON.parse(OWNED_FILES["schemas/theme.schema.json"] ?? "{}");
  if (typeof schema !== "object" || !schema) throw Error("Missing schema");
  const validate = new Ajv().compile(schema);
  const base = { ...interfaceThemes["eclipse-dark"], version: 2 };
  const theme = (empty: object) => ({ ...base, images: { empty } });
  const valid = theme({
    fit: "none",
    opacity: 0.4,
    anchor: "bottom",
    size: 25,
    files: [
      "accent.png",
      { file: "accent.png", fit: "cover", anchor: "center", opacity: 0.6 },
      { file: "large.webp", size: 100 },
    ],
  });
  expect(validate(valid), JSON.stringify(validate.errors)).toBe(true);
  expect(parseThemeFile(JSON.stringify(valid), "theme")).toMatchObject({
    images: {
      empty: [
        { file: "accent.png", fit: "none", opacity: 0.4, anchor: "bottom", size: 25 },
        { file: "accent.png", fit: "cover", opacity: 0.6, anchor: "center" },
        { file: "large.webp", fit: "none", opacity: 0.4, anchor: "bottom", size: 100 },
      ],
    },
  });
  const optionalSlotDefault = theme({
    size: 5,
    files: ["fill.png", { file: "accent.png", fit: "none" }],
  });
  expect(validate(optionalSlotDefault), JSON.stringify(validate.errors)).toBe(true);
  const parsed = parseThemeFile(JSON.stringify(optionalSlotDefault), "theme");
  if (parsed.kind !== "theme") throw Error("Expected interface theme");
  expect(parsed.images?.empty?.[0]).not.toHaveProperty("size");
  expect(parsed.images?.empty?.[1]?.size).toBe(5);
  expect(
    parseThemeFile(JSON.stringify(theme({ file: "one.png", fit: "none", size: 100 })), "theme"),
  ).toMatchObject({ images: { empty: [{ file: "one.png", fit: "none", size: 100 }] } });
  for (const invalid of [
    { file: "one.png", size: 25 },
    { files: ["cover.png"], fit: "cover", size: 20 },
    { files: [{ file: "one.png", size: 25 }] },
    { files: [{ file: "one.png", fit: "cover", size: 25 }], fit: "none" },
    { files: [{ file: "one.png", fit: "none", size: 4.9 }] },
    { files: [{ file: "one.png", fit: "none", size: 101 }] },
    { files: [{ file: "one.png", fit: "none", size: null }] },
    { files: [{ file: "one.png", opacity: 0.65 }] },
    { files: [{ file: "one.png", fit: "fill" }] },
    { files: [{ fit: "none" }] },
    { files: [{ file: "../one.png" }] },
    { files: [{ file: "one.png", path: "Other.png" }] },
  ]) {
    expect(validate(theme(invalid))).toBe(false);
    expect(() => parseThemeFile(JSON.stringify(theme(invalid)), "theme")).toThrow();
  }
});
