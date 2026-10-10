import { expect, test } from "vitest";
import { configPart, describe, effective, weakenings } from "../../../../src/main/config/approval";
import { OWNED_FILES, digest, refreshable } from "../../../../src/main/config/layout";
import { DEFAULT_SETTINGS } from "../../../../src/main/setup/settings";

const base = configPart(DEFAULT_SETTINGS);

test("only changes that weaken attention need approval", () => {
  expect(weakenings(base, base)).toEqual([]);
  const quiet = effective(base, {
    sound: { ...base.sound, alerts: false, alertVolume: 0 },
    hooks: false,
    agents: { claude: false, codex: false, agy: false },
  });
  expect(weakenings(base, quiet).map((entry) => entry.detail)).toEqual([
    "sound.alerts: on → off",
    "sound.alertVolume: 0.5 → 0",
    "hooks: on → off",
    "agents.claude: on → off",
    "agents.codex: on → off",
    "agents.agy: on → off",
  ]);
  // Adding or tightening applies live: turning things on, themes, sizes and fonts.
  expect(weakenings(quiet, base)).toEqual([]);
  expect(
    weakenings(
      base,
      effective(base, {
        interfaceTheme: "deep-field",
        interfaceScale: 120,
        terminalFontSize: 20,
        sound: { ...base.sound, working: true, alertVolume: 0.1 },
      }),
    ),
  ).toEqual([]);
});

test("a missing key means the default, not unchanged", () => {
  const off = effective(base, { hooks: false });
  expect(effective(off, {})).toEqual(off);
  expect(effective(base, {}).hooks).toBe(true);
});

test("commit subjects name the change", () => {
  expect(describe(base, base)).toBe("Settings");
  expect(describe(base, effective(base, { terminalFontSize: 15 }))).toBe("Terminal font size 15");
  expect(describe(base, effective(base, { interfaceScale: 120 }))).toBe("Interface size 120%");
  expect(describe(base, effective(base, { hooks: false }))).toBe("Hooks off");
  expect(describe(effective(base, { hooks: false }), base)).toBe("Hooks on");
  expect(describe(base, effective(base, { interfaceTheme: "user:a.json" }))).toBe(
    "Interface theme user:a.json",
  );
  expect(describe(base, effective(base, { sound: { ...base.sound, working: true } }))).toBe(
    "Sound",
  );
  expect(describe(base, effective(base, { colorMode: "dark", panelColor: "plain" }))).toBe(
    "Settings: color mode, panel color",
  );
});

test("owned files refresh only when missing or matching an earlier Foom version", () => {
  expect(refreshable("README.md", null)).toBe(true);
  expect(refreshable("README.md", Buffer.from(OWNED_FILES["README.md"] ?? ""))).toBe(false);
  expect(refreshable("README.md", Buffer.from("edited"))).toBe(false);
  expect(refreshable("unknown.md", Buffer.from("x"))).toBe(false);
  expect(digest("abc")).toMatch(/^[0-9a-f]{64}$/);
  expect(OWNED_FILES["AGENTS.md"]).toContain("foom config validate .");
  expect(OWNED_FILES["CLAUDE.md"]).toBe(OWNED_FILES["AGENTS.md"]);
  const schema = JSON.parse(OWNED_FILES["schemas/settings.schema.json"] ?? "{}") as {
    properties: Record<string, unknown>;
    additionalProperties: boolean;
  };
  expect(schema.additionalProperties).toBe(false);
  expect(Object.keys(schema.properties).sort()).toEqual(
    [
      "kind",
      "colorMode",
      "panelColor",
      "interfaceTheme",
      "terminalTheme",
      "interfaceScale",
      "terminalFontSize",
      "sound",
      "agents",
      "hooks",
    ].sort(),
  );
  for (const file of ["schemas/theme.schema.json", "schemas/terminal-theme.schema.json"])
    expect(() => {
      JSON.parse(OWNED_FILES[file] ?? "");
    }).not.toThrow();
});
