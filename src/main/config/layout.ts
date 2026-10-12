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
        working: { type: "boolean" },
        workingVolume: { type: "number", minimum: 0, maximum: 1 },
        alerts: { type: "boolean" },
        alertVolume: { type: "number", minimum: 0, maximum: 1 },
      },
    },
    agents: {
      type: "object",
      additionalProperties: false,
      required: ["claude", "codex", "agy"],
      properties: {
        claude: { type: "boolean" },
        codex: { type: "boolean" },
        agy: { type: "boolean" },
      },
    },
    hooks: { type: "boolean" },
    restoreSessions: { type: "boolean" },
  },
});

const themeSchema = schema("foom:theme", {
  title: "Foom interface theme",
  type: "object",
  additionalProperties: false,
  required: ["kind", "name", "base", "colors"],
  properties: {
    kind: { const: "theme" },
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
  \`terminalFontSize\`, \`sound\`, \`agents\` \`hooks\` and \`restoreSessions\`. Any other key rejects the file.
  Launch arguments, consent records, paths and secrets are not configurable here.
- \`themes/*.json\`: interface themes, \`{ "kind": "theme", "name", "base", "colors" }\`.
  Select one with \`"interfaceTheme": "user:<filename>.json"\`.
- \`terminal-themes/*.json\`: terminal colors,
  \`{ "kind": "terminal-theme", "name", "background", "foreground", "cursor", "ansi" }\`.
  Select one with \`"terminalTheme": "user:<filename>.json"\`.
- \`sounds/{working,done,needs-you,refusal}/\`: recordings. They are not committed.
- \`schemas/\`: JSON Schemas for the three JSON formats.

## Not in this folder

These are set in Foom's Settings window, not here. Tell the user exactly what to enter:

- Agent default launch arguments, such as approval mode, sandbox or model flags:
  Settings → Agents and hooks → Default launch arguments, one argument per line.
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
- Themes, sizes and turning sounds on apply without approval.
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
    "35a362caf6cfdec503b113efd0b66a6b89be3dc835b597e39f1fb8679b20875f",
    "878a20cc974fb5cee577361660f8153f9adbcb3ca815ee5fc4eca26047b8d858",
  ],
  "AGENTS.md": [
    "35a362caf6cfdec503b113efd0b66a6b89be3dc835b597e39f1fb8679b20875f",
    "878a20cc974fb5cee577361660f8153f9adbcb3ca815ee5fc4eca26047b8d858",
  ],
  "CLAUDE.md": [
    "35a362caf6cfdec503b113efd0b66a6b89be3dc835b597e39f1fb8679b20875f",
    "878a20cc974fb5cee577361660f8153f9adbcb3ca815ee5fc4eca26047b8d858",
  ],
  "schemas/settings.schema.json": [
    "e975ab7aba189e009bbcd16becb6c096679dc5c46017d585a46cbda130af804e",
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
