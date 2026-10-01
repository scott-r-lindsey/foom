import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { SCALES } from "./appearance";
import { parseInferenceConfig } from "./inference-source";
import type { AgentId } from "./shared/agents";
import type { Settings, SettingsPatch } from "./shared/setup";

const AGENTS: readonly AgentId[] = ["claude", "codex", "agy"];

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  setupComplete: false,
  hooks: true,
  agents: Object.freeze({ claude: true, codex: true, agy: true }),
  worktreeLocation: "root",
  inference: Object.freeze({ kind: "rules" }),
  inferenceTimeoutMs: 5000,
  colorMode: "system",
  interfaceScale: 100,
  codeFolder: null,
});

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates and copies an untrusted patch (from IPC or disk). Unknown fields are
 * rejected, so nothing the renderer invents is ever stored.
 */
export function parseSettingsPatch(value: unknown): SettingsPatch {
  if (!record(value)) throw new Error("Invalid settings");
  const patch: SettingsPatch = {};
  for (const [key, entry] of Object.entries(value)) {
    if ((key === "setupComplete" || key === "hooks") && typeof entry === "boolean")
      patch[key] = entry;
    else if (key === "worktreeLocation" && (entry === "root" || entry === "adjacent"))
      patch.worktreeLocation = entry;
    else if (
      key === "agents" &&
      record(entry) &&
      Object.keys(entry).length === AGENTS.length &&
      AGENTS.every((id) => typeof entry[id] === "boolean")
    )
      patch.agents = {
        claude: entry["claude"] === true,
        codex: entry["codex"] === true,
        agy: entry["agy"] === true,
      };
    else if (key === "inference") patch.inference = parseInferenceConfig(entry);
    else if (
      key === "codeFolder" &&
      (entry === null ||
        (typeof entry === "string" &&
          entry.length <= 4096 &&
          !entry.includes("\0") &&
          isAbsolute(entry)))
    )
      patch.codeFolder = entry;
    else if (key === "colorMode" && (entry === "system" || entry === "light" || entry === "dark"))
      patch.colorMode = entry;
    else if (key === "interfaceScale" && typeof entry === "number" && SCALES.includes(entry))
      patch.interfaceScale = entry;
    else if (
      key === "inferenceTimeoutMs" &&
      Number.isInteger(entry) &&
      typeof entry === "number" &&
      entry >= 1000 &&
      entry <= 30_000
    )
      patch.inferenceTimeoutMs = entry;
    else throw new Error("Invalid settings");
  }
  return patch;
}

/** Versioned `settings.json` in user data, written atomically and one write at a time. */
export class SettingsStore {
  private settings: Settings = DEFAULT_SETTINGS;
  private pending: Promise<void> = Promise.resolve();

  private constructor(private readonly file: string) {}

  /** Missing, corrupt or unsupported state starts from defaults, so setup runs again. */
  static async open(userData: string): Promise<SettingsStore> {
    const store = new SettingsStore(join(userData, "settings.json"));
    try {
      const state: unknown = JSON.parse(await readFile(store.file, "utf8"));
      if (record(state) && state["version"] === 1 && record(state["settings"]))
        store.settings = { ...DEFAULT_SETTINGS, ...parseSettingsPatch(state["settings"]) };
    } catch {
      // Defaults.
    }
    return store;
  }

  get(): Settings {
    return this.settings;
  }

  /** Resolves once the new settings are on disk; a failed write leaves them unchanged. */
  async update(patch: SettingsPatch): Promise<Settings> {
    const write = this.pending
      .catch(() => undefined)
      .then(async () => {
        const next = { ...this.settings, ...patch };
        await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify({ version: 1, settings: next }), {
            flag: "wx",
            mode: 0o600,
          });
          await rename(temporary, this.file);
        } finally {
          await rm(temporary, { force: true });
        }
        this.settings = next;
      });
    this.pending = write;
    await write;
    return this.settings;
  }
}
