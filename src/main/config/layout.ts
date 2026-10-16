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

const guide = `# Foom config

You are running inside Foom, the user's terminal workspace for coding agents, in its
config folder. When the user asks to change how Foom looks, sounds or behaves, or how
it launches agents, they mean Foom, not your own agent configuration.

This folder configures Foom. Foom watches it, validates every change and applies
valid changes live. It is a git repository: every applied change is a commit, so it
can be reviewed and reverted from Settings → Foom config.

## Files

- \`settings.json\`: \`{ "kind": "settings", ... }\` with any of the allowed keys:
  \`colorMode\`, \`panelColor\`, \`interfaceTheme\`, \`terminalTheme\`, \`interfaceScale\`,
  \`terminalFontSize\`, \`terminalFont\` (a family name, default Hack Nerd Font Mono), \`sound\`, \`agents\`, \`agentArguments\`, \`hooks\`, \`restoreSessions\` and \`concurrentChildren\` (integer 1–16, default 4). Any other key rejects the file.
  Consent records, paths and secrets are not configurable here.
  \`agentArguments\` names all three agents: \`{ "claude": [], "codex": [], "agy": [] }\`.
  Each list is literal argv, one string per argument, with no shell parsing.
  Every change to these lists waits for the user's Allow, including removal or harmless flags.
  Default launch arguments affect new, resumed and restored sessions; running sessions keep theirs.
- \`themes/*.json\`: interface themes, \`{ "kind": "theme", "name", "base", "colors" }\`.
  Select one with \`"interfaceTheme": "user:<filename>.json"\`.
- \`terminal-themes/*.json\`: terminal colors,
  \`{ "kind": "terminal-theme", "name", "background", "foreground", "cursor", "ansi" }\`.
  Select one with \`"terminalTheme": "user:<filename>.json"\`.
- \`sounds/{working,done,needs-you,refusal}/\`: recordings. They are not committed.
- \`schemas/\`: JSON Schemas for the three JSON formats.

## Agent plugins

- Put declarative version 1 or version 2 manifests in \`agents/<id>.json\`. Foom never fetches plugins or loads scripts from them.
- Version 2 supports generic launch, discovery, resume, prompt/guidance, MCP and attention data; hooks, health and setup declarations stay unavailable until their engines ship.
- A minimal version 1 manifest is \`{ "kind": "agent", "version": 1, "id": "example-agent", "name": "Example Agent", "badge": "EX", "executables": ["example-agent"], "launch": { "arguments": [], "prompt": ["--prompt", "{prompt}"], "resume": ["--resume", "{conversationId}"] }, "bypassArguments": ["--yolo"], "attention": { "minimumEngineVersion": 1, "rules": [] } }\`.
- IDs match filenames and cannot be claude, codex, agy or shell. Executables are names on PATH, not paths or shell command strings. Every argv entry is literal. Unknown keys and unsafe detection regexes are rejected.
- A valid manifest loads as soon as Foom reads it; an edit reloads it. An invalid file is rejected whole and cannot launch. Running sessions keep their original launch bindings.
- Run \`foom config validate\` after editing a manifest. To remove a plugin, remove its manifest.

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
- Foom commits applied changes itself. Do not rewrite history.
- Foom owns this guide, AGENTS.md, CLAUDE.md, .gitignore and schemas/. It refreshes
  them on upgrade unless you have edited them.
`;

/** Foom-owned files, written at first launch and refreshed only while unedited. */
export const OWNED_FILES: Readonly<Record<string, string>> = {
  "README.md": guide,
  "AGENTS.md": guide,
  "CLAUDE.md": guide,
  ".gitignore": [
    "# Recordings are large binaries; settings store choices as source plus filename.",
    "/sounds/*/*",
    "!/sounds/*/.gitkeep",
    "",
  ].join("\n"),
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
  "README.md": [
    "c8255169631ec679c29d78bd2ece6f88f1b6dc0fcf1b2a41d9683a07a60b0b03",
    "88acb3815e8efc866973c2d329491c63bef04d67b19e61579fe5abcf9af1221e",
    "205d3cac8e70f43434c221c43f8611ba846c580084e3b6b2a53d9a966e410810",
    "35a362caf6cfdec503b113efd0b66a6b89be3dc835b597e39f1fb8679b20875f",
    "878a20cc974fb5cee577361660f8153f9adbcb3ca815ee5fc4eca26047b8d858",
    "c6b86f464a73d1c4255fd412bc454bea148a5bf2130aa3175b3de36e85aeb6a2",
    "d71127b1f24427c8f3a36b5b32fde2aac496941c5bc038960f0d81399519c3e5",
    "da0c1cc124400b4e6f204fb6b29b181aec5ef76f1edc336bd7cb9ce6a6a252e4",
  ],
  "AGENTS.md": [
    "c8255169631ec679c29d78bd2ece6f88f1b6dc0fcf1b2a41d9683a07a60b0b03",
    "88acb3815e8efc866973c2d329491c63bef04d67b19e61579fe5abcf9af1221e",
    "205d3cac8e70f43434c221c43f8611ba846c580084e3b6b2a53d9a966e410810",
    "35a362caf6cfdec503b113efd0b66a6b89be3dc835b597e39f1fb8679b20875f",
    "878a20cc974fb5cee577361660f8153f9adbcb3ca815ee5fc4eca26047b8d858",
    "c6b86f464a73d1c4255fd412bc454bea148a5bf2130aa3175b3de36e85aeb6a2",
    "d71127b1f24427c8f3a36b5b32fde2aac496941c5bc038960f0d81399519c3e5",
    "da0c1cc124400b4e6f204fb6b29b181aec5ef76f1edc336bd7cb9ce6a6a252e4",
  ],
  "CLAUDE.md": [
    "c8255169631ec679c29d78bd2ece6f88f1b6dc0fcf1b2a41d9683a07a60b0b03",
    "88acb3815e8efc866973c2d329491c63bef04d67b19e61579fe5abcf9af1221e",
    "205d3cac8e70f43434c221c43f8611ba846c580084e3b6b2a53d9a966e410810",
    "35a362caf6cfdec503b113efd0b66a6b89be3dc835b597e39f1fb8679b20875f",
    "878a20cc974fb5cee577361660f8153f9adbcb3ca815ee5fc4eca26047b8d858",
    "c6b86f464a73d1c4255fd412bc454bea148a5bf2130aa3175b3de36e85aeb6a2",
    "d71127b1f24427c8f3a36b5b32fde2aac496941c5bc038960f0d81399519c3e5",
    "da0c1cc124400b4e6f204fb6b29b181aec5ef76f1edc336bd7cb9ce6a6a252e4",
  ],
  "schemas/theme.schema.json": ["831094a9c9c8c13c87ab7ff227b70803dcd3a9f9f59b6f1cc352f67b43a8e1cc"],
  "schemas/settings.schema.json": [
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
