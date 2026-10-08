import type { SoundChoice, SoundKind, SoundRequest, SoundSettings } from "./sound";
export const SOUND_KINDS: readonly SoundKind[] = ["working", "done", "needs-you", "refusal"];
export const DEFAULT_SOUND: SoundSettings = {
  choices: {
    working: { source: "builtin", file: "seagate-read-write.ogg" },
    done: { source: "builtin", file: "typewriter-bell.ogg" },
    "needs-you": { source: "builtin", file: "bicycle-bell.ogg" },
    refusal: { source: "builtin", file: "lip-pop.ogg" },
  },
  working: false,
  workingVolume: 0.15,
  alerts: true,
  alertVolume: 0.5,
};
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    throw new Error("Invalid sound configuration");
  return value;
}
export function validSoundFile(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 100 &&
    /^[\p{L}\p{N}_()][\p{L}\p{N} _().-]*\.(ogg|opus|wav|flac|mp3)$/iu.test(value) &&
    !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])\./i.test(value)
  );
}
export function parseSoundChoice(value: unknown): SoundChoice {
  const data = record(value, ["source", "file"]);
  if ((data["source"] !== "builtin" && data["source"] !== "user") || !validSoundFile(data["file"]))
    throw new Error("Invalid sound file choice");
  return { source: data["source"], file: data["file"] };
}
export function parseSoundRequest(value: unknown): SoundRequest {
  const data = record(value, ["kind", "source", "file"]);
  const kind = SOUND_KINDS.find((kind) => kind === data["kind"]);
  if (!kind) throw new Error("Invalid sound kind");
  return { kind, ...parseSoundChoice({ source: data["source"], file: data["file"] }) };
}
export function sameSound(a: SoundChoice, b: SoundChoice): boolean {
  return a.source === b.source && a.file.toLowerCase() === b.file.toLowerCase();
}
export function parseSoundSettings(value: unknown): SoundSettings {
  const data = record(value, ["choices", "working", "workingVolume", "alerts", "alertVolume"]);
  const choices = record(data["choices"], SOUND_KINDS);
  const parsed = {
    working: parseSoundChoice(choices["working"]),
    done: parseSoundChoice(choices["done"]),
    "needs-you": parseSoundChoice(choices["needs-you"]),
    refusal: parseSoundChoice(choices["refusal"]),
  };
  if (sameSound(parsed["needs-you"], parsed.done) || sameSound(parsed["needs-you"], parsed.refusal))
    throw new Error("Needs you must use a different file from Done and Refusal");
  if (typeof data["working"] !== "boolean" || typeof data["alerts"] !== "boolean")
    throw new Error("Invalid sound switches");
  const volume = (value: unknown) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
      throw new Error("Invalid sound volume");
    return value;
  };
  return {
    choices: parsed,
    working: data["working"],
    alerts: data["alerts"],
    workingVolume: volume(data["workingVolume"]),
    alertVolume: volume(data["alertVolume"]),
  };
}
/** Migration is for persisted settings only, never the IPC save contract. */
export function migrateSoundSettings(value: unknown): SoundSettings {
  if (typeof value === "object" && value !== null && "soundscape" in value) {
    const data = record(value, ["soundscape", "working", "workingVolume", "alerts", "alertVolume"]);
    return parseSoundSettings({
      choices: DEFAULT_SOUND.choices,
      working: data["working"],
      alerts: data["alerts"],
      workingVolume: data["workingVolume"],
      alertVolume: data["alertVolume"],
    });
  }
  return parseSoundSettings(value);
}
export function soundName(file: string): string {
  const name = file.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}
