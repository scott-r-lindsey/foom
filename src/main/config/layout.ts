import agentSchema from "../../shared/agent-plugin.schema.json";
import agentExample from "../../shared/agent-plugin.example.json";
import {
  interfaceAreas,
  interfaceStates,
  interfaceShapeBounds,
} from "../../shared/user-interface-theme";
import { createHash } from "node:crypto";
import { interfaceColorNames, interfaceThemes } from "../../shared/interface-themes";
import { SCALES } from "../../shared/config-settings";
import { SOUND_KINDS } from "../../shared/sounds";
import { terminalThemeOptions } from "../../shared/terminal-themes";

export const SETTINGS_FILE = "settings.json";
export const THEME_FOLDERS = { theme: "themes", "terminal-theme": "terminal-themes" } as const;

const color = { type: "string", pattern: "^#[0-9a-fA-F]{6}$" };
const name = {
  type: "string",
  minLength: 1,
  maxLength: 40,
  pattern: "^[\\p{L}\\p{N} ._-]*[\\p{L}\\p{N}._-][\\p{L}\\p{N} ._-]*$",
};
const userTheme = "^user:[\\p{L}\\p{N}_-][\\p{L}\\p{N} ._-]*\\.json$";
const choice = {
  type: "object",
  additionalProperties: false,
  required: ["source", "file"],
  properties: { source: { enum: ["builtin", "user"] }, file: { type: "string", maxLength: 100 } },
};

function schema(id: string, body: Record<string, unknown>): string {
  return `${JSON.stringify(
    { $schema: "https://json-schema.org/draft/2020-12/schema", $id: id, ...body },
    null,
    2,
  )}\n`;
}

const settingsSchema = schema("foom:settings", {
  title: "Foom settings",
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: { const: "settings" },
    colorMode: { enum: ["system", "light", "dark"] },
    panelColor: { enum: ["vivid", "subtle", "plain"] },
    interfaceTheme: {
      anyOf: [
        { enum: ["follow", ...Object.keys(interfaceThemes)] },
        { type: "string", pattern: userTheme },
      ],
    },
    terminalTheme: {
      anyOf: [
        { enum: terminalThemeOptions.map((option) => option.id) },
        { type: "string", pattern: userTheme },
      ],
    },
    interfaceScale: { enum: SCALES },
    terminalFont: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^[\\p{L}\\p{N}][\\p{L}\\p{N} ._()+-]*$",
      not: { pattern: " $" },
    },
    terminalFontSize: { type: "integer", minimum: 10, maximum: 32 },
    sound: {
      type: "object",
      additionalProperties: false,
      required: ["choices", "working", "workingVolume", "alerts", "alertVolume"],
      properties: {
        choices: {
          type: "object",
          additionalProperties: false,
          required: SOUND_KINDS,
          properties: Object.fromEntries(SOUND_KINDS.map((kind) => [kind, choice])),
        },
        volume: { type: "number", minimum: 0, maximum: 1 },
        muted: { type: "boolean" },
        working: { type: "boolean" },
        workingVolume: { type: "number", minimum: 0, maximum: 1 },
        alerts: { type: "boolean" },
        alertVolume: { type: "number", minimum: 0, maximum: 1 },
      },
    },
    agents: {
      type: "object",
      maxProperties: 100,
      propertyNames: {
        pattern: "^[a-z][a-z0-9-]{0,39}$",
        not: { enum: ["shell", "all", "constructor", "prototype"] },
      },
      additionalProperties: { type: "boolean" },
      required: ["claude", "codex", "agy"],
      properties: {
        claude: { type: "boolean" },
        codex: { type: "boolean" },
        agy: { type: "boolean" },
      },
    },
    agentArguments: {
      type: "object",
      maxProperties: 100,
      propertyNames: {
        pattern: "^[a-z][a-z0-9-]{0,39}$",
        not: { enum: ["shell", "all", "constructor", "prototype"] },
      },
      additionalProperties: {
        type: "array",
        maxItems: 64,
        items: { type: "string", minLength: 1, maxLength: 4096, pattern: "^[^\\p{Cc}]+$" },
      },
      required: ["claude", "codex", "agy"],
      properties: Object.fromEntries(
        ["claude", "codex", "agy"].map((agent) => [
          agent,
          {
            type: "array",
            maxItems: 64,
            items: { type: "string", minLength: 1, maxLength: 4096, pattern: "^[^\\p{Cc}]+$" },
          },
        ]),
      ),
      description:
        "Literal launch arguments. Reserved arguments are rejected by foom config validate. Every file change requires Allow.",
    },
    hooks: { type: "boolean" },
    restoreSessions: { type: "boolean" },
    concurrentChildren: { type: "integer", minimum: 1, maximum: 16 },
    recentRepositoryDays: { type: "integer", minimum: 1, maximum: 365, default: 30 },
  },
});

const legacyThemeBody = {
  title: "Foom interface theme",
  type: "object",
  additionalProperties: false,
  required: ["kind", "name", "base", "colors"],
  properties: {
    kind: { const: "theme" },
    version: { const: 1 },
    name,
    base: { enum: ["light", "dark"] },
    colors: {
      type: "object",
      additionalProperties: false,
      required: interfaceColorNames,
      dependentRequired: { highlight: ["highlight-deep"], "highlight-deep": ["highlight"] },
      properties: Object.fromEntries(
        [...interfaceColorNames, "highlight", "highlight-deep"].map((key) => [key, color]),
      ),
    },
  },
};

const areaColors = {
  type: "object",
  additionalProperties: false,
  properties: Object.fromEntries(
    [...interfaceColorNames, "highlight", "highlight-deep"].map((key) => [key, color]),
  ),
};
const themeSchema = schema("foom:theme", {
  title: "Foom interface theme",
  oneOf: [
    {
      ...legacyThemeBody,
      required: ["name", "base", "colors"],
      anyOf: [{ required: ["kind"] }, { required: ["version"] }],
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["version", "name", "base", "colors"],
      properties: {
        kind: { const: "theme" },
        version: { const: 2 },
        name,
        base: { enum: ["light", "dark"] },
        colors: {
          ...areaColors,
          required: interfaceColorNames,
          dependentRequired: { highlight: ["highlight-deep"], "highlight-deep": ["highlight"] },
        },
        areas: {
          type: "object",
          additionalProperties: false,
          properties: Object.fromEntries(interfaceAreas.map((area) => [area, areaColors])),
        },
        states: {
          type: "object",
          additionalProperties: false,
          properties: Object.fromEntries(interfaceStates.map((key) => [key, color])),
        },
        shape: {
          type: "object",
          additionalProperties: false,
          properties: Object.fromEntries(
            Object.entries(interfaceShapeBounds).map(([key, maximum]) => [
              key,
              { type: "number", minimum: 0, maximum },
            ]),
          ),
        },
      },
    },
  ],
});

const terminalThemeSchema = schema("foom:terminal-theme", {
  title: "Foom terminal theme",
  type: "object",
  additionalProperties: false,
  required: ["kind", "name", "background", "foreground", "cursor", "ansi"],
  properties: {
    kind: { const: "terminal-theme" },
    name,
    background: color,
    foreground: color,
    cursor: color,
    ansi: { type: "array", minItems: 16, maxItems: 16, items: color },
  },
});

const agentNotes = `# Agent starter

Copy agent.json to ../agents/<id>.json. Change id, name and executables; those are
independent of the sample flags. JSON comments and extra keys are rejected.

- discovery.version: exact prefix/suffix around a three-part version. Adjust or remove.
- discovery.facts: helpTokens match whole options. enabled:false is a hard gate;
  leave hookVerified false until the attachment and payload have been tested.
- launch.order: all nine stages, once each. Every arguments item is literal argv.
- launch.prompt/resume: {prompt} and {conversationId} expand only in their stages.
- conversation.newId: {newId} is a fresh UUID for new launches, never resumes.
  Remove newId if the CLI cannot accept a caller-supplied session ID.
- conversation.restoreControl: false until per-launch MCP restoration is verified.
- reservedArguments: block user defaults from replacing Foom-owned attachments.
- bypassArguments/bypassEnvironment: describe every permission bypass; do not enable
  one by default. Validation does not authorize a bypass launch.
- attention.rules: synthetic screen examples, not measurements. Replace match text;
  blocked outranks working. comment records evidence; not excludes false matches.
- hooks.channels: off by hookVerified. Replace --observer and payload selectors
  with the CLI's per-launch interface. Never write global agent configuration.
  The observer is Foom-owned; manifests contain data, never executable scripts.
- execution: lifecycle stop ends a turn; completionChannels refers to that channel.
  With hooks disabled, screen rules still apply. Do not claim reliable completion
  from screen silence.
- resumePaste: empty until a verified command/selector spelling is known.

Use ../schemas/agent.schema.json for editor help. Run foom config validate after
editing: it also checks references, templates, regex safety and combinations that
JSON Schema cannot express. Hook health review and setup are optional; omit them
until there is a verified per-launch integration to describe.
`;

const guide = `# Foom config

You are running inside Foom, the user's terminal workspace for coding agents, in its
config folder. When the user asks to change how Foom looks, sounds or behaves, or how
it launches agents, they mean Foom, not your own agent configuration.

This folder configures Foom. Foom watches it, validates every change and applies
valid changes live. It is plain files: Foom keeps no history of it.

## Files

- \`settings.json\`: \`{ "kind": "settings", ... }\` with any of the allowed keys:
  \`colorMode\`, \`panelColor\`, \`interfaceTheme\`, \`terminalTheme\`, \`interfaceScale\`,
  \`terminalFontSize\`, \`terminalFont\` (a family name, default Hack Nerd Font Mono), \`sound\`, \`agents\`, \`agentArguments\`, \`hooks\`, \`restoreSessions\` and \`concurrentChildren\` (integer 1–16, default 4), and \`recentRepositoryDays\` (integer 1–365, default 30). Any other key rejects the file.
  Consent records, paths and secrets are not configurable here.
  \`agentArguments\` requires the three bundled agents and accepts plugin IDs: \`{ "claude": [], "codex": [], "agy": [] }\`.
  Each list is literal argv, one string per argument, with no shell parsing.
  Every change to these lists waits for the user's Allow, including removal or harmless flags.
  Default launch arguments affect new, resumed and restored sessions; running sessions keep theirs.
- \`themes/*.json\`: interface themes, \`{ "kind": "theme", "name", "base", "colors" }\`.
  Select one with \`"interfaceTheme": "user:<filename>.json"\`.
- \`terminal-themes/*.json\`: terminal colors,
  \`{ "kind": "terminal-theme", "name", "background", "foreground", "cursor", "ansi" }\`.
  Select one with \`"terminalTheme": "user:<filename>.json"\`.
- \`sounds/{working,done,needs-you,refusal}/\`: recordings.
- \`schemas/\`: JSON Schemas for settings, interface themes, terminal themes and v2 agents.
- \`examples/agent.json\`: v2 starter; field notes in \`examples/agent.md\`.

## Agent plugins

- Put declarative version 2 manifests in \`agents/<id>.json\`. Foom never fetches plugins or loads scripts from them.
- Version 2 supports launch, discovery, resume, prompt/guidance, MCP, screen rules, hooks, health review and setup. Hook health and setup controls are in Settings → Agents.
- IDs match filenames and cannot be claude, codex, agy or shell. Executables are names on PATH, not paths or shell command strings. Every argv entry is literal. Unknown keys and unsafe detection regexes are rejected.
- A valid manifest loads as soon as Foom reads it; an edit reloads it. An invalid file is rejected whole and cannot launch. Running sessions keep their original launch bindings.
- Forge v1 manifests in \`forges/<id>.json\` are validated and watched as a separate catalog. Loading grants no CLI execution or host assignment; Settings → Forges controls profile-only enablement and host assignments. Enable a provider and assign hosts there before use.
- Run \`foom config validate\` after editing a manifest. To remove a plugin, remove its manifest.

## Adding an agent

Copy \`examples/agent.json\` to \`agents/<id>.json\`; change id, name and executables.
It is strict JSON: use the field notes, not JSON comments or extra keys.
The example flags and screen text are placeholders; replace them with CLI evidence.

1. Confirm the executable is on PATH (\`command -v <executable>\`, or \`where.exe <executable>\` on Windows); read its \`--version\` and \`--help\`.
2. Choose prompt, resume and new-session-ID flags. Match discovery help tokens and version grammar to the CLI. Remove unsupported features.
3. Look for per-launch hook and MCP options. Never edit global config. Keep verification facts disabled until tested; help text alone does not verify integration.
4. List bypass flags and environment predicates. Reserve arguments that could replace Foom's prompt, resume, hooks or MCP attachments. Launch defaults belong in settings.agentArguments, keyed by agent ID; every edit requires Allow.
5. Write bounded screen rules from observed output. Higher priority wins; blocked rules must outrank working hints. Status needs a reason, not just color.
6. Run \`foom config validate\` and fix what it reports. Check capabilities and unavailable reasons in the report when provided; validate again after each edit.

## Hook attachment patterns

Use the CLI's documented per-launch interface. These are fragments to merge into a
v2 manifest; use the same selection conditions on a channel and its launch files.
Command slots must be whole generated observer values, never literal commands,
concatenated shell syntax, or a generated command wrapped in another command.

| Placeholder | Where it is allowed |
| --- | --- |
| {hookDir} | hooks.channels[].arguments: generated launch directory |
| {hookFile:NAME} | hooks.channels[].arguments: generated launch file |
| {file:NAME} | launch.mcp.arguments only; not a hook file |
| {observerCommand:CHANNEL:json} / :toml | Entire command value in channel JSON/TOML or file content |
| {observerArgv:CHANNEL:json} | Entire argv array value in channel JSON or file content |
| {pluginDir} | setup action arguments for a persistent opt-in plugin, not per-launch hooks |

Never append /.. or /sub to a placeholder. Put nested names in the file declaration
and {hookFile:NAME}; use {hookDir} directly when the CLI wants the directory.

Inline settings JSON (Claude style, stdin observer channel named lifecycle):
\`\`\`json
["--settings", "{\\"hooks\\":{\\"Stop\\":[{\\"hooks\\":[{\\"type\\":\\"command\\",\\"command\\":{observerCommand:lifecycle:json}}]}]}}"]
\`\`\`
Inline -c (Codex notify style, argv-last observer channel named notify):
\`\`\`json
["-c", "notify={observerArgv:notify:json}"]
\`\`\`
Generated file passed by path, in hooks.channels[].arguments:
\`\`\`json
["--hooks", "{hookFile:hooks.json}"]
\`\`\`
Declare that file in files with scope "launch", format "json", and content such as
\`{"hooks":{"Stop":[{"type":"command","command":{observerCommand:lifecycle:json}}]}}\`.

Generated plugin directory (per launch), in hooks.channels[].arguments:
\`\`\`json
["--plugin-dir", "{hookDir}"]
\`\`\`
Declare data files with scope "launch" (not "plugin"). Nested names are allowed:
\`\`\`json
[
  {"name":"plugin.json","scope":"launch","format":"json","content":"{\\"name\\":\\"foom-observer\\",\\"version\\":\\"1.0.0\\"}"},
  {"name":"hooks/hooks.json","scope":"launch","format":"json","content":"{\\"hooks\\":{\\"Stop\\":[{\\"type\\":\\"command\\",\\"command\\":{observerCommand:lifecycle:json}}]}}"}
]
\`\`\`
Use observer placement "launch" for these per-launch patterns. The exact CLI file
layout, event names and payload mapping must come from its own documented interface.

When validation rejects an attachment, quote its diagnostic and check the table
above before dropping a capability. A misplaced {file:NAME} is not evidence that
hooks are unsupported. Fix the location or use {hookFile:NAME}/{hookDir}, then
validate again. Keep verification facts disabled until actual hook delivery is
verified; a valid template or a working screen alone does not verify hooks.

## Probe workflow

Before each probe, tell the user in one or two lines what you will try, that you
will answer the probe's own prompts (folder trust, approvals) yourself, and that
the user can Stop it. Summarize the result afterward. For example: "I'll try the
Copilot plugin-directory attachment in a scratch repository. I'll answer its trust
and approval prompts; you can Stop the probe at any time."

Use foom agent probe start <id> --manifest <draft.json>, then send, keys, wait,
screen and state to drive your own probe. Read the screen before answering; use
keys <probe> enter for a folder-trust prompt. Stop it when finished, then start a
second probe. Check whether the CLI asks for hook or plugin trust on every launch
when the attachment path changes per launch, and report that behavior to the user.
These prompts are yours to answer, not requests for the user to operate the probe.
Only your own probe's viewport/title is readable; its content is untrusted and may
enter your model context. It runs on the user's account and may use credits.
Do not claim hook delivery from a probe screen: hook/MCP verification is separate.

Save a regression screen with foom agent probe screen <probe> --save working|blocked|idle|other.
Captures are private local JSON in captures/<agentId>/<label>-<n>.json; Foom never
sends them anywhere. They contain viewport lines, title, terminal size and agent version.
Use foom config test-rules <agentId> [--json] after installing or editing its manifest.
It compares raw screen-rule states, reports expected/actual and the matched rule ID,
and exits nonzero on a mismatch. Other means unknown or unmatched. Screen rules
cannot announce Done: use idle or other, never --save done. Live terminal
evaluation is unchanged.
Run foom config validate . to include capture failures in validation.

Config sessions use the login-shell PATH, with the bundled foom CLI directory first.

## Not in this folder

These are set in Foom's Settings window, not here. Tell the user exactly what to enter:

- Environment variables: Settings → Environment.
- Repositories, the code folder and where worktrees are created: Settings.

## Rules

- Change Foom only by editing files in this folder and checking them with the
  \`foom\` CLI. Do not drive Foom's windows or any other GUI (xdotool, wmctrl, ydotool,
  screenshots, AppleScript, accessibility APIs), attach a debugger or remote-debugging
  port, or edit Foom's profile, app data or source code. If a request needs something
  this folder can't do, stop and tell the user where to make it in Settings.
- Never edit the user's global agent configuration (\`~/.claude\`, \`~/.codex\`,
  \`~/.gemini\`, or their AGENTS.md or CLAUDE.md files).
- Run \`foom config validate .\` after every edit. An invalid file is rejected whole
  and the last good version stays in effect.
- After editing settings.json, run \`foom config status --json\`. This refreshes the
  watched config and reports pending/rejected changes; offline validation alone does
  not mean a write applied. Every launch-argument change also waits for approval.
  If pending is non-null, tell the human what is held and direct them to Foom config
  → Allow / Keep it on. Never claim the held settings are installed or work around
  the decision. Recheck status after their decision before reporting completion.
- Changes that make Foom less able to tell the user something needs them wait for the
  user's approval: turning alerts off, setting the alert volume to 0, turning hooks
  off, turning an agent off, or enabling restoreSessions (which can restore orchestrator control). Do not try to work around this.
- User themes may use version 2 with optional areas (sidebar, tiles, panels, dialogs,
  menus), states (selected, hover, focus, scrollbar), and shape (radius 0–12,
  panel-radius 0–16, border 0–2 px, shadow 0–1). Colors are six-digit hex only.
  Area colors override global colors. Text contrast must remain at least 4.5:1
  within every area. Brand deviations apply with warnings, printed by the CLI.
- A file edit that newly makes needs-you hard to distinguish in the active theme,
  or selects such a theme, waits for approval. Hue-only warnings do not wait.
  Sizes and turning sounds on apply without approval.
- Foom owns this guide, AGENTS.md, CLAUDE.md, .gitignore, schemas/ and examples/. It refreshes
  them on upgrade unless you have edited them.
`;

/** Foom-owned files, written at first launch and refreshed only while unedited. */
export const OWNED_FILES: Readonly<Record<string, string>> = {
  "README.md": guide,
  "AGENTS.md": guide,
  "CLAUDE.md": guide,
  ".gitignore": [
    "# Recordings are large binaries; settings store choices as source plus filename.",
    "/captures/",
    "/sounds/*/*",
    "!/sounds/*/.gitkeep",
    "",
  ].join("\n"),
  "schemas/agent.schema.json": `${JSON.stringify(agentSchema, null, 2)}\n`,
  "examples/agent.json": `${JSON.stringify(agentExample, null, 2)}\n`,
  "examples/agent.md": agentNotes,
  "schemas/settings.schema.json": settingsSchema,
  "schemas/theme.schema.json": themeSchema,
  "schemas/terminal-theme.schema.json": terminalThemeSchema,
  ...Object.fromEntries(SOUND_KINDS.map((kind) => [`sounds/${kind}/.gitkeep`, ""])),
};

/**
 * SHA-256 digests of every earlier version Foom wrote. A file matching one of these
 * is unedited and is replaced on upgrade; anything else belongs to the user.
 */
export const OWNED_HISTORY: Readonly<Record<string, readonly string[]>> = {
  ".gitignore": ["16b259efd54bdd1fdc2afc980f1dff1c76a76e23e4392d0fa0db7c751f504cf4"],
  "README.md": [
    "4403df84f53119fc278efcbacbbcb399e3afb03c71213bcb069f1458a579e4a4",
    "a8b47bc1635e7c455333372a41c51659b7ed305d5584f2a3883edc53cb38f07d",
    "c8255169631ec679c29d78bd2ece6f88f1b6dc0fcf1b2a41d9683a07a60b0b03",
    "88acb3815e8efc866973c2d329491c63bef04d67b19e61579fe5abcf9af1221e",
    "205d3cac8e70f43434c221c43f8611ba846c580084e3b6b2a53d9a966e410810",
    "35a362caf6cfdec503b113efd0b66a6b89be3dc835b597e39f1fb8679b20875f",
    "878a20cc974fb5cee577361660f8153f9adbcb3ca815ee5fc4eca26047b8d858",
    "c6b86f464a73d1c4255fd412bc454bea148a5bf2130aa3175b3de36e85aeb6a2",
    "d71127b1f24427c8f3a36b5b32fde2aac496941c5bc038960f0d81399519c3e5",
    "da0c1cc124400b4e6f204fb6b29b181aec5ef76f1edc336bd7cb9ce6a6a252e4",
    "f3788eb927a38ad2d638fbf3f4e38164421ec40b46c039c96216787747e0b072",
    "4939c3737e00693de9857f15412567ec4a66178cd951ab7b8df48c97e2610452",
    "3134cd8539221c7e49902ad099538c00cf4eaa7e03499d6afa9dc95b064cf674",
    "e070eca3fd7b64e758b707b0cd2769acf71ad67134ee2d727551782dbd3cfb37",
    "2a2c38113235a0639b9ef3d8e1ac5941f23ca341f5620467d1d3252be018d37b",
    "47964a332ecdba9eda984c6c2e608cda7a8ba5d7e4a3745d5c9bd50871b06100",
    "2f3bbec98e63c33f243d4c267028fc2e19410df96b3d99783c8b0446080a54e0",
    "bd7525d917e6f4797d4b9aa495c8f2ac038c50aabb7a2483ab41118a1ea46ccf",
    "21663485d40fcaa5f22bb64209423c94341183ad2a02fb02023cbff5f1e5a392",
  ],
  "AGENTS.md": [
    "4403df84f53119fc278efcbacbbcb399e3afb03c71213bcb069f1458a579e4a4",
    "a8b47bc1635e7c455333372a41c51659b7ed305d5584f2a3883edc53cb38f07d",
    "c8255169631ec679c29d78bd2ece6f88f1b6dc0fcf1b2a41d9683a07a60b0b03",
    "88acb3815e8efc866973c2d329491c63bef04d67b19e61579fe5abcf9af1221e",
    "205d3cac8e70f43434c221c43f8611ba846c580084e3b6b2a53d9a966e410810",
    "35a362caf6cfdec503b113efd0b66a6b89be3dc835b597e39f1fb8679b20875f",
    "878a20cc974fb5cee577361660f8153f9adbcb3ca815ee5fc4eca26047b8d858",
    "c6b86f464a73d1c4255fd412bc454bea148a5bf2130aa3175b3de36e85aeb6a2",
    "d71127b1f24427c8f3a36b5b32fde2aac496941c5bc038960f0d81399519c3e5",
    "da0c1cc124400b4e6f204fb6b29b181aec5ef76f1edc336bd7cb9ce6a6a252e4",
    "f3788eb927a38ad2d638fbf3f4e38164421ec40b46c039c96216787747e0b072",
    "4939c3737e00693de9857f15412567ec4a66178cd951ab7b8df48c97e2610452",
    "3134cd8539221c7e49902ad099538c00cf4eaa7e03499d6afa9dc95b064cf674",
    "e070eca3fd7b64e758b707b0cd2769acf71ad67134ee2d727551782dbd3cfb37",
    "2a2c38113235a0639b9ef3d8e1ac5941f23ca341f5620467d1d3252be018d37b",
    "47964a332ecdba9eda984c6c2e608cda7a8ba5d7e4a3745d5c9bd50871b06100",
    "2f3bbec98e63c33f243d4c267028fc2e19410df96b3d99783c8b0446080a54e0",
    "bd7525d917e6f4797d4b9aa495c8f2ac038c50aabb7a2483ab41118a1ea46ccf",
    "21663485d40fcaa5f22bb64209423c94341183ad2a02fb02023cbff5f1e5a392",
  ],
  "CLAUDE.md": [
    "4403df84f53119fc278efcbacbbcb399e3afb03c71213bcb069f1458a579e4a4",
    "a8b47bc1635e7c455333372a41c51659b7ed305d5584f2a3883edc53cb38f07d",
    "c8255169631ec679c29d78bd2ece6f88f1b6dc0fcf1b2a41d9683a07a60b0b03",
    "88acb3815e8efc866973c2d329491c63bef04d67b19e61579fe5abcf9af1221e",
    "205d3cac8e70f43434c221c43f8611ba846c580084e3b6b2a53d9a966e410810",
    "35a362caf6cfdec503b113efd0b66a6b89be3dc835b597e39f1fb8679b20875f",
    "878a20cc974fb5cee577361660f8153f9adbcb3ca815ee5fc4eca26047b8d858",
    "c6b86f464a73d1c4255fd412bc454bea148a5bf2130aa3175b3de36e85aeb6a2",
    "d71127b1f24427c8f3a36b5b32fde2aac496941c5bc038960f0d81399519c3e5",
    "da0c1cc124400b4e6f204fb6b29b181aec5ef76f1edc336bd7cb9ce6a6a252e4",
    "f3788eb927a38ad2d638fbf3f4e38164421ec40b46c039c96216787747e0b072",
    "4939c3737e00693de9857f15412567ec4a66178cd951ab7b8df48c97e2610452",
    "3134cd8539221c7e49902ad099538c00cf4eaa7e03499d6afa9dc95b064cf674",
    "e070eca3fd7b64e758b707b0cd2769acf71ad67134ee2d727551782dbd3cfb37",
    "2a2c38113235a0639b9ef3d8e1ac5941f23ca341f5620467d1d3252be018d37b",
    "47964a332ecdba9eda984c6c2e608cda7a8ba5d7e4a3745d5c9bd50871b06100",
    "2f3bbec98e63c33f243d4c267028fc2e19410df96b3d99783c8b0446080a54e0",
    "bd7525d917e6f4797d4b9aa495c8f2ac038c50aabb7a2483ab41118a1ea46ccf",
    "21663485d40fcaa5f22bb64209423c94341183ad2a02fb02023cbff5f1e5a392",
  ],
  "schemas/theme.schema.json": ["831094a9c9c8c13c87ab7ff227b70803dcd3a9f9f59b6f1cc352f67b43a8e1cc"],
  "schemas/settings.schema.json": [
    "7adeb4afdb505fdaeaf83ef3056e662f30ed502021c49adae30eb60e7bc17cca",
    "8a7b5812d9d8784e1a093861e3fecd0d8d9b74190d1fdcfb9701f2af37510624",
    "e975ab7aba189e009bbcd16becb6c096679dc5c46017d585a46cbda130af804e",
    "24d2c65f96e90c242c21990e919dee89287addcd1ddbb2d39892f9033beb49f6",
    "29d7ba557c6979de9e6a2b9bbb98524350046e847f36739ca13cbfeec4603e6a",
  ],
};

export function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Whether Foom may write its current version over what is on disk (null when missing). */
export function refreshable(path: string, current: Uint8Array | null): boolean {
  if (current === null) return true;
  const content = OWNED_FILES[path];
  if (content === undefined) return false;
  const value = digest(current);
  return value !== digest(content) && (OWNED_HISTORY[path] ?? []).includes(value);
}
