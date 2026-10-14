import { expect, test } from "vitest";
import {
  argumentChanges,
  argumentDisclosure,
  configPart,
  describe,
  effective,
  weakenings,
} from "../../../../src/main/config/approval";
import {
  OWNED_FILES,
  OWNED_HISTORY,
  digest,
  refreshable,
} from "../../../../src/main/config/layout";
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
  // Agents here must read requests as about Foom and stay out of global agent config.
  expect(OWNED_FILES["AGENTS.md"]).toContain("they mean Foom, not your own agent configuration");
  expect(OWNED_FILES["AGENTS.md"]).toContain("Default launch arguments");
  expect(OWNED_FILES["AGENTS.md"]).toContain("Never edit the user's global agent configuration");
  expect(OWNED_FILES["AGENTS.md"]).toContain("Do not drive Foom's windows or any other GUI");
  expect(OWNED_FILES["CLAUDE.md"]).toBe(OWNED_FILES["AGENTS.md"]);
  const schema = JSON.parse(OWNED_FILES["schemas/settings.schema.json"] ?? "{}") as {
    properties: Record<string, unknown>;
    additionalProperties: boolean;
  };
  expect(schema.additionalProperties).toBe(false);
  expect(schema.properties["concurrentChildren"]).toEqual({
    type: "integer",
    minimum: 1,
    maximum: 16,
  });
  expect(Object.keys(schema.properties).sort()).toEqual(
    [
      "kind",
      "colorMode",
      "panelColor",
      "interfaceTheme",
      "terminalTheme",
      "interfaceScale",
      "terminalFontSize",
      "terminalFont",
      "sound",
      "agents",
      "agentArguments",
      "hooks",
      "restoreSessions",
      "concurrentChildren",
    ].sort(),
  );
  for (const file of ["schemas/theme.schema.json", "schemas/terminal-theme.schema.json"])
    expect(() => {
      JSON.parse(OWNED_FILES[file] ?? "");
    }).not.toThrow();
});

test("enabling automatic restore requires approval, disabling it does not", () => {
  const off = effective(base, { restoreSessions: false });
  expect(weakenings(off, base)).toEqual([
    { action: "restore sessions on launch", detail: "restoreSessions: off → on" },
  ]);
  expect(weakenings(base, off)).toEqual([]);
});

test("unedited earlier guides refresh to the current one", () => {
  for (const file of ["README.md", "AGENTS.md", "CLAUDE.md"]) {
    const history = OWNED_HISTORY[file] ?? [];
    expect(history).toContain("d71127b1f24427c8f3a36b5b32fde2aac496941c5bc038960f0d81399519c3e5");
    // The guide shipped with restoreSessions, before the launch-argument guidance.
    expect(history).toContain("878a20cc974fb5cee577361660f8153f9adbcb3ca815ee5fc4eca26047b8d858");
    expect(history).not.toContain(digest(OWNED_FILES[file] ?? ""));
  }
});

test("every argument transition holds, and disclosures preserve literal lines and name bypass", () => {
  const args = effective(base, {
    agentArguments: {
      claude: ["--permission-mode", "bypassPermissions"],
      codex: ["--sandbox", "danger-full-access", " spaces  and 'quotes' ", "<script>"],
      agy: ["--dangerously-skip-permissions"],
    },
  });
  expect(argumentChanges(base, args).map((change) => change.detail)).toEqual([
    "agentArguments.claude",
    "agentArguments.codex",
    "agentArguments.agy",
  ]);
  expect(argumentChanges(args, base)).toHaveLength(3);
  expect(argumentChanges(args, { ...args, agentArguments: { ...args.agentArguments } })).toEqual(
    [],
  );
  expect(describe(base, args)).toBe("Agent launch arguments");
  const disclosure = argumentDisclosure(base, args);
  expect(disclosure.sections).toContainEqual({
    label: "Codex before",
    arguments: true,
    items: ["(no arguments)"],
  });
  expect(disclosure.sections).toContainEqual({
    label: "Codex after",
    arguments: true,
    items: args.agentArguments.codex,
  });
  expect(disclosure.sections).toContainEqual({
    label: "Codex bypass",
    arguments: true,
    items: ["--sandbox", "danger-full-access"],
  });
  expect(disclosure.sections).toContainEqual({
    label: "Claude Code bypass",
    arguments: true,
    items: ["--permission-mode", "bypassPermissions"],
  });
  expect(disclosure.sections).toContainEqual({
    label: "Antigravity bypass",
    arguments: true,
    items: ["--dangerously-skip-permissions"],
  });
  const removal = argumentDisclosure(args, base);
  expect(removal.sections).toContainEqual({
    label: "Codex before",
    arguments: true,
    items: args.agentArguments.codex,
  });
  expect(removal.sections).toContainEqual({
    label: "Codex after",
    arguments: true,
    items: ["(no arguments)"],
  });
  expect(removal.sections).toHaveLength(6);
  expect(argumentDisclosure(base, base).sections).toEqual([]);
});

test("the immediately previous guide and schema are refreshable history", () => {
  for (const file of ["README.md", "AGENTS.md", "CLAUDE.md"])
    expect(OWNED_HISTORY[file]).toContain(
      "c6b86f464a73d1c4255fd412bc454bea148a5bf2130aa3175b3de36e85aeb6a2",
    );
  expect(OWNED_HISTORY["schemas/settings.schema.json"]).toContain(
    "24d2c65f96e90c242c21990e919dee89287addcd1ddbb2d39892f9033beb49f6",
  );
  expect(OWNED_FILES["AGENTS.md"]).toContain("Every change to these lists waits");
  expect(
    OWNED_FILES["AGENTS.md"]?.split("## Not in this folder")[1]?.split("## Rules")[0],
  ).not.toContain("Agent default launch arguments");
});

test.each([
  { agent: "claude", name: "Claude Code", args: ["--permission-mode", "bypassPermissions"] },
  { agent: "claude", name: "Claude Code", args: ["--permission-mode=bypassPermissions"] },
  ...["--sandbox", "-s"].map((flag) => ({
    agent: "codex" as const,
    name: "Codex",
    args: [flag, "danger-full-access"],
  })),
  ...["-c", "--config"].map((flag) => ({
    agent: "codex" as const,
    name: "Codex",
    args: [flag, 'profiles.full.sandbox_mode="danger-full-access"'],
  })),
  ...[
    "--sandbox=danger-full-access",
    "-s=danger-full-access",
    "-sdanger-full-access",
    '--config=sandbox_mode="danger-full-access"',
    "-csandbox_mode=danger-full-access",
    '-c=sandbox_mode="danger-full-access"',
  ].map((flag) => ({
    agent: "codex" as const,
    name: "Codex",
    args: [flag],
  })),
] as const)(
  "bypass disclosure preserves complete literal options: $args",
  ({ agent, name, args }) => {
    const after = effective(base, {
      agentArguments: {
        ...base.agentArguments,
        [agent]: ["--model", "ordinary", ...args, ...args, "--verbose"],
      },
    });
    expect(argumentDisclosure(base, after).sections).toContainEqual({
      label: `${name} bypass`,
      arguments: true,
      items: [...args, ...args],
    });
  },
);

test("file edits cannot silence attention through the master without approval", () => {
  const quiet = effective(base, { sound: { ...base.sound, volume: 0, muted: true } });
  expect(weakenings(base, quiet).map((entry) => entry.detail)).toEqual([
    "sound.volume: 1 → 0",
    "sound.muted: off → on",
  ]);
  expect(weakenings(quiet, base)).toEqual([]);
});

test("config plugin arguments and disabling require review, including removal of plugin defaults", () => {
  const plugin = {
    ...base,
    agents: { ...base.agents, fixture: false },
    agentArguments: { ...base.agentArguments, fixture: ["--model", "literal model"] },
  };
  expect(weakenings(base, plugin)).toContainEqual({
    action: "turn off fixture",
    detail: "agents.fixture: on → off",
  });
  expect(argumentChanges(base, plugin)).toEqual([
    { action: "change fixture launch arguments", detail: "agentArguments.fixture" },
  ]);
  expect(argumentDisclosure(base, plugin).sections).toEqual([
    { label: "fixture before", arguments: true, items: ["(no arguments)"] },
    { label: "fixture after", arguments: true, items: ["--model", "literal model"] },
  ]);
  expect(argumentDisclosure(plugin, base).sections).toEqual([
    { label: "fixture before", arguments: true, items: ["--model", "literal model"] },
    { label: "fixture after", arguments: true, items: ["(no arguments)"] },
  ]);
});
