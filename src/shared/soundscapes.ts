import type { Soundscape, SoundSettings, Tone } from "./sound";

export const DEFAULT_SOUND: SoundSettings = Object.freeze({
  soundscape: "drive",
  working: false,
  workingVolume: 0.15,
  alerts: true,
  alertVolume: 0.5,
});
export const SOUNDSCAPES: Readonly<Record<"drive" | "soft", Soundscape>> = {
  drive: {
    version: 1,
    name: "Hard drive",
    working: { hum: 90, seek: 1800, density: 18 },
    done: { frequency: 660, duration: 0.12, gap: 0, count: 1 },
    needsYou: { frequency: 880, duration: 0.13, gap: 0.16, count: 2 },
  },
  soft: {
    version: 1,
    name: "Soft drive",
    working: { hum: 60, seek: 900, density: 10 },
    done: { frequency: 440, duration: 0.16, gap: 0, count: 1 },
    needsYou: { frequency: 740, duration: 0.18, gap: 0.2, count: 2 },
  },
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
function number(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    throw new Error("Invalid sound parameter");
  return value;
}
function tone(value: unknown): Tone {
  const data = record(value, ["frequency", "duration", "gap", "count"]);
  const count = number(data["count"], 1, 3);
  if (!Number.isInteger(count)) throw new Error("Invalid tone count");
  return {
    frequency: number(data["frequency"], 200, 2000),
    duration: number(data["duration"], 0.03, 0.3),
    gap: number(data["gap"], 0, 0.3),
    count,
  };
}
export function parseSoundscape(value: unknown): Soundscape {
  const data = record(value, ["version", "name", "working", "done", "needsYou"]);
  if (
    data["version"] !== 1 ||
    typeof data["name"] !== "string" ||
    !/^[\p{L}\p{N} ._-]{1,40}$/u.test(data["name"])
  )
    throw new Error("Invalid soundscape");
  const working = record(data["working"], ["hum", "seek", "density"]);
  const done = tone(data["done"]);
  const needsYou = tone(data["needsYou"]);
  // Attention has a reserved double/triple cadence; completion is always a single beep.
  if (done.count !== 1 || needsYou.count < 2 || needsYou.gap < 0.08)
    throw new Error("Attention must have a distinct cadence");
  return {
    version: 1,
    name: data["name"],
    working: {
      hum: number(working["hum"], 40, 180),
      seek: number(working["seek"], 300, 4000),
      density: number(working["density"], 1, 24),
    },
    done,
    needsYou,
  };
}
export function parseSoundSettings(value: unknown): SoundSettings {
  const data = record(value, ["soundscape", "working", "workingVolume", "alerts", "alertVolume"]);
  if (typeof data["working"] !== "boolean" || typeof data["alerts"] !== "boolean")
    throw new Error("Invalid sound switches");
  const choice = data["soundscape"];
  return {
    soundscape: choice === "drive" || choice === "soft" ? choice : parseSoundscape(choice),
    working: data["working"],
    alerts: data["alerts"],
    workingVolume: number(data["workingVolume"], 0, 1),
    alertVolume: number(data["alertVolume"], 0, 1),
  };
}
export function resolveSoundscape(choice: SoundSettings["soundscape"]): Soundscape {
  return typeof choice === "string" ? SOUNDSCAPES[choice] : choice;
}
