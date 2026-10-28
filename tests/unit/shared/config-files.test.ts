import { expect, test } from "vitest";
import {
  configJson,
  parseSettingsFile,
  validateConfigJson,
} from "../../../src/shared/config-files";
import {
  parseConfigSettings,
  migrateAppearanceSettings,
} from "../../../src/shared/config-settings";
import { DEFAULT_SOUND } from "../../../src/shared/sounds";
import { interfaceThemes } from "../../../src/shared/interface-themes";
import { ansiNames, terminalThemes } from "../../../src/shared/terminal-themes";
import { parseSettingsPatch } from "../../../src/main/setup/settings";
const allowed = {
  panelColor: "plain",
  interfaceTheme: "user:custom.json",
  interfaceScale: 120,
  terminalFontSize: 16,
  terminalTheme: "user:terminal.json",
  sound: DEFAULT_SOUND,
  agents: { claude: false, codex: true, agy: false },
  hooks: false,
  showNewChildren: false,
  agentArguments: { claude: [], codex: ["--ask-for-approval", "never"], agy: [] },
};
test("settings is an optional allowlisted patch with exactly main's value rules", () => {
  expect(parseSettingsFile('{"kind":"settings"}')).toEqual({});
  expect(parseSettingsFile(JSON.stringify({ kind: "settings", ...allowed }))).toEqual(allowed);
  expect(parseSettingsPatch(allowed)).toEqual(allowed);
  for (const colorMode of ["system", "light", "dark"])
    expect(() => parseConfigSettings({ colorMode })).toThrow();
  for (const panelColor of ["vivid", "subtle", "plain"])
    expect(parseConfigSettings({ panelColor })).toEqual({ panelColor });
  for (const interfaceScale of [80, 90, 100, 110, 120, 130, 140, 150, 175, 200, 250, 300])
    expect(parseConfigSettings({ interfaceScale })).toEqual({ interfaceScale });
  expect(
    parseSettingsFile('{"kind":"settings","interfaceTheme":"follow","terminalTheme":"dracula"}'),
  ).toEqual({ interfaceTheme: "follow", terminalTheme: "dracula" });
});
test.each([
  "agentBypassAcknowledged",
  "agentBypassIdentities",
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
test.each([true, false, [], ["/repo"]])(
  "rejects profile auto-removal in agent-editable config: %j",
  (value) => {
    expect(() =>
      parseSettingsFile(JSON.stringify({ kind: "settings", autoRemoveMergedWorktrees: value })),
    ).toThrow(expect.objectContaining({ reason: "unknown-key" }));
  },
);
test.each([
  ["colorMode", "auto"],
  ["panelColor", "red"],
  ["hooks", 0],
  ["agents", null],
  ["agents", { claude: true }],
  ["agents", { claude: true, codex: true, agy: 1 }],
  ["agents", { claude: true, codex: true, agy: true, "../evil": true }],
  ["interfaceScale", 101],
  ["interfaceScale", 160],
  ["interfaceScale", 400],
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

test.each([
  ["claude", ["--"]],
  ["claude", ["--settings", "{}"]],
  ["claude", ["--safe-mode"]],
  ["claude", ["--bare"]],
  ["claude", ["--resume", "id"]],
  ["codex", ["--no-alt-screen"]],
  ["codex", ["-c", "notify=[]"]],
  ["codex", ["--config=hooks={}"]],
  ["codex", ["--dangerously-bypass-hook-trust"]],
  ["codex", ["resume"]],
  ["agy", ["--conversation", "id"]],
] as const)("file validator reuses the reserved argument errors for %s", (agent, args) => {
  const text = JSON.stringify({
    kind: "settings",
    agentArguments: { claude: [], codex: [], agy: [], [agent]: args },
  });
  expect(() => parseSettingsFile(text)).toThrow(
    expect.objectContaining({
      path: "$.agentArguments",
      reason: "invalid-value",
      detail: expect.stringMatching(/line 1:/u) as unknown,
    }),
  );
  expect(() => validateConfigJson(text)).toThrow();
});

test("older persisted sound settings retain choices and levels with an unmuted master", () => {
  const old = {
    choices: DEFAULT_SOUND.choices,
    working: true,
    workingVolume: 0.3,
    alerts: false,
    alertVolume: 0.6,
  };
  expect(parseSettingsFile(JSON.stringify({ kind: "settings", sound: old })).sound).toEqual({
    ...old,
    volume: 1,
    muted: false,
  });
  expect(() =>
    parseSettingsFile(
      JSON.stringify({ kind: "settings", sound: { ...old, volume: "1", muted: false } }),
    ),
  ).toThrow();
});

test("offline validation uses the same agent manifest gate and reports stable paths without loading it", async () => {
  const { default: manifest } = await import("../../fixtures/agent-plugin.json");
  expect(validateConfigJson(JSON.stringify(manifest), "agent")).toEqual([]);
  for (const version of [1, 3])
    expect(() => validateConfigJson(JSON.stringify({ ...manifest, version }), "agent")).toThrow(
      expect.objectContaining({
        path: "$.version",
        detail:
          version === 1
            ? "Agent manifest version 1 is no longer supported; use version 2 (see README.md)"
            : "Agent manifest version must be 2 (see README.md)",
      }),
    );
  expect(() =>
    validateConfigJson(JSON.stringify({ ...manifest, capabilities: ["codex-hooks"] }), "agent"),
  ).toThrow(expect.objectContaining({ path: "$", reason: "invalid-value", detail: "unknown-key" }));
  expect(() => validateConfigJson(JSON.stringify(manifest), "settings")).toThrow();
});

test("config validation retains actionable hook placeholder diagnostics", async () => {
  const { default: copilot } = await import("../../fixtures/agent-plugins-v2/copilot.json");
  const draft = structuredClone(copilot);
  const channel = draft.hooks.channels[0];
  if (!channel) throw Error("Missing fixture channel");
  channel.arguments = ["--plugin-dir", "{file:plugin.json}/.."];
  try {
    validateConfigJson(JSON.stringify(draft), "agent");
    throw Error("Expected rejection");
  } catch (error) {
    expect(error).toMatchObject({
      path: "$.hooks.channels[0].arguments[1]",
      reason: "invalid-value",
    });
    expect(error).toHaveProperty("detail", expect.stringContaining("placeholder-path-arithmetic"));
    expect(error).toHaveProperty("detail", expect.stringContaining("{hookDir}"));
    expect(error).toHaveProperty("detail", expect.stringContaining("{hookFile:NAME}"));
  }
});

test.each([null, 0, 1, "false", {}, []])("child placement rejects non-booleans: %j", (value) => {
  expect(() =>
    parseSettingsFile(JSON.stringify({ kind: "settings", showNewChildren: value })),
  ).toThrow();
});

test.each([
  [{ interfaceTheme: "follow", colorMode: "system" }, "follow"],
  [{ interfaceTheme: "follow", colorMode: "light" }, "eclipse-light"],
  [{ interfaceTheme: "follow", colorMode: "dark" }, "eclipse-dark"],
  [{ colorMode: "dark" }, "eclipse-dark"],
  [{ interfaceTheme: "follow" }, "follow"],
  [{ interfaceTheme: "moonlight", colorMode: "dark" }, "moonlight"],
  [{ interfaceTheme: "user:night.json", colorMode: "light" }, "user:night.json"],
])("migrates legacy appearance %j without changing the look", (legacy, expected) => {
  const parsed = parseSettingsFile(JSON.stringify({ kind: "settings", ...legacy }));
  expect(parsed).toEqual({ interfaceTheme: expected });
  expect(parsed).not.toHaveProperty("colorMode");
});

test.each([
  "follow",
  "foom-light",
  "foom-dark",
  "solarized-light",
  "solarized-dark",
  "dracula",
  "user:term.json",
])("retains terminal choice %s (follow is now Default)", (terminalTheme) => {
  expect(parseSettingsFile(JSON.stringify({ kind: "settings", terminalTheme }))).toEqual({
    terminalTheme,
  });
});

test.each([null, false, 1, {}, [], "auto"])(
  "rejects invalid legacy color mode %j even with a fixed theme",
  (colorMode) => {
    for (const interfaceTheme of ["follow", "moonlight", "user:custom.json"])
      expect(() =>
        parseSettingsFile(JSON.stringify({ kind: "settings", colorMode, interfaceTheme })),
      ).toThrow(expect.objectContaining({ path: "$.colorMode", reason: "invalid-value" }));
  },
);

test("legacy validation reports a clear warning and invalid/missing themes retain strict validation", () => {
  expect(validateConfigJson('{"kind":"settings","colorMode":"dark"}')).toEqual([
    expect.objectContaining({
      path: "$.colorMode",
      severity: "warning",
    }),
  ]);
  expect(validateConfigJson('{"kind":"settings","colorMode":"dark"}')[0]?.detail).toContain(
    "colorMode is retired",
  );
  for (const interfaceTheme of [null, false, 1, {}, [], "unknown"])
    expect(() =>
      parseSettingsFile(JSON.stringify({ kind: "settings", interfaceTheme, colorMode: "dark" })),
    ).toThrow();
  expect(parseSettingsFile('{"kind":"settings"}')).toEqual({});
});

test("appearance migration validates an unknown boundary and explicit undefined values", () => {
  for (const value of [null, false, [], 3, "settings", { colorMode: undefined }])
    expect(() => migrateAppearanceSettings(value)).toThrow();
  expect(migrateAppearanceSettings({ interfaceTheme: "follow" })).toEqual({
    interfaceTheme: "follow",
  });
});
