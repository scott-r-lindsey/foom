import { expect, test } from "vitest";
import {
  DEFAULT_SOUND,
  migrateSoundSettings,
  parseSoundChoice,
  parseSoundRequest,
  parseSoundSettings,
  sameSound,
  soundName,
  validSoundFile,
} from "../../../src/shared/sounds";
test("choices are copied, independent and strictly validated", () => {
  expect(parseSoundSettings(DEFAULT_SOUND)).toEqual(DEFAULT_SOUND);
  expect(parseSoundSettings(DEFAULT_SOUND).choices).not.toBe(DEFAULT_SOUND.choices);
  expect(DEFAULT_SOUND).toMatchObject({
    working: false,
    workingVolume: 0.15,
    alerts: true,
    alertVolume: 0.5,
  });
  expect(parseSoundRequest({ kind: "done", source: "user", file: "chime.wav" })).toEqual({
    kind: "done",
    source: "user",
    file: "chime.wav",
  });
  for (const bad of [
    null,
    [],
    {},
    { ...DEFAULT_SOUND, extra: 1 },
    { ...DEFAULT_SOUND, working: 0 },
    { ...DEFAULT_SOUND, alerts: "yes" },
    ...[NaN, Infinity, -1, 2, "1"].map((alertVolume) => ({ ...DEFAULT_SOUND, alertVolume })),
  ])
    expect(() => parseSoundSettings(bad)).toThrow();
  for (const file of [
    "../escape.wav",
    "/a.mp3",
    "a\\b.wav",
    ".hidden.wav",
    "x\0.wav",
    "a".repeat(101) + ".wav",
    "CON.wav",
    "a:stream.mp3",
    "sound.exe",
    1,
  ])
    expect(validSoundFile(file)).toBe(false);
  for (const file of ["a.wav", "soft click.OPUS", "ベル.ogg", "x.FLAC", "hello_world.mp3"])
    expect(validSoundFile(file)).toBe(true);
  expect(() => parseSoundChoice({ source: "url", file: "x.wav" })).toThrow();
  expect(() => parseSoundChoice({ source: "user", file: "../x.wav" })).toThrow();
  expect(() => parseSoundRequest({ kind: "other", source: "user", file: "x.wav" })).toThrow();
  expect(soundName("old-modem_2.ogg")).toBe("Old modem 2");
  expect(sameSound({ source: "user", file: "a.wav" }, { source: "builtin", file: "a.wav" })).toBe(
    false,
  );
  for (const kind of ["done", "refusal"] as const)
    expect(() =>
      parseSoundSettings({
        ...DEFAULT_SOUND,
        choices: { ...DEFAULT_SOUND.choices, [kind]: DEFAULT_SOUND.choices["needs-you"] },
      }),
    ).toThrow("different file");
});
test("legacy disk settings drop synthesis but preserve switches and volumes", () => {
  for (const soundscape of ["drive", "soft", { version: 1, name: "Custom" }]) {
    const migrated = migrateSoundSettings({
      soundscape,
      working: true,
      workingVolume: 0.2,
      alerts: false,
      alertVolume: 0.8,
    });
    expect(migrated).toEqual({
      ...DEFAULT_SOUND,
      working: true,
      workingVolume: 0.2,
      alerts: false,
      alertVolume: 0.8,
    });
    expect(migrated).not.toHaveProperty("soundscape");
  }
  expect(migrateSoundSettings(DEFAULT_SOUND)).toEqual(DEFAULT_SOUND);
  expect(() => migrateSoundSettings({ soundscape: "drive" })).toThrow();
});
