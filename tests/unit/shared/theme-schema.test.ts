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
