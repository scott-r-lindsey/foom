import { expect, test } from "vitest";
import {
  DEFAULT_SOUND,
  SOUNDSCAPES,
  parseSoundSettings,
  parseSoundscape,
  resolveSoundscape,
} from "../../../src/shared/soundscapes";
test("built-in and portable synthesis data round-trip without sharing untrusted objects", () => {
  for (const [id, scape] of Object.entries(SOUNDSCAPES)) {
    expect(parseSoundscape(scape)).toEqual(scape);
    expect(parseSoundscape(scape)).not.toBe(scape);
    expect(parseSoundSettings({ ...DEFAULT_SOUND, soundscape: id })).toEqual({
      ...DEFAULT_SOUND,
      soundscape: id,
    });
  }
  const custom = parseSoundSettings({ ...DEFAULT_SOUND, soundscape: SOUNDSCAPES.soft });
  expect(resolveSoundscape(custom.soundscape)).toEqual(SOUNDSCAPES.soft);
  expect(resolveSoundscape("drive")).toBe(SOUNDSCAPES.drive);
  expect(DEFAULT_SOUND.working).toBe(false);
  expect(DEFAULT_SOUND.alerts).toBe(true);
});
test("rejects executable/unknown data, unbounded synthesis, and ambiguous attention cadence", () => {
  for (const value of [
    null,
    [],
    false,
    {},
    { ...SOUNDSCAPES.drive, extra: 0 },
    { ...SOUNDSCAPES.drive, version: 2 },
    { ...SOUNDSCAPES.drive, name: 1 },
    { ...SOUNDSCAPES.drive, name: "<script>" },
    { ...SOUNDSCAPES.drive, working: {} },
    ...[NaN, Infinity, -1, 5000, "90"].map((hum) => ({
      ...SOUNDSCAPES.drive,
      working: { ...SOUNDSCAPES.drive.working, hum },
    })),
    ...[0, 1.5, 4].map((count) => ({
      ...SOUNDSCAPES.drive,
      needsYou: { ...SOUNDSCAPES.drive.needsYou, count },
    })),
    { ...SOUNDSCAPES.drive, needsYou: SOUNDSCAPES.drive.done },
    { ...SOUNDSCAPES.drive, done: SOUNDSCAPES.drive.needsYou },
    { ...SOUNDSCAPES.drive, needsYou: { ...SOUNDSCAPES.drive.needsYou, gap: 0 } },
  ])
    expect(() => parseSoundscape(value)).toThrow();
  for (const value of [
    null,
    {},
    { ...DEFAULT_SOUND, working: 1 },
    { ...DEFAULT_SOUND, alerts: "yes" },
    { ...DEFAULT_SOUND, soundscape: "unknown" },
    { ...DEFAULT_SOUND, alertVolume: NaN },
    { ...DEFAULT_SOUND, workingVolume: 1.01 },
    { ...DEFAULT_SOUND, workingVolume: -0.01 },
    { ...DEFAULT_SOUND, sampleUrl: "https://example.com" },
  ])
    expect(() => parseSoundSettings(value)).toThrow();
});
