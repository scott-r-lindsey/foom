import { expect, test, vi } from "vitest";
import { loadRecording, recordingGain } from "../../../../src/renderer/sound/recording";
import { DEFAULT_SOUND } from "../../../../src/shared/sounds";
import type { SoundRead } from "../../../../src/shared/sound";
function buffer(duration = 1, samples = [0.1, -0.1]): AudioBuffer {
  return {
    duration,
    numberOfChannels: 1,
    length: samples.length,
    sampleRate: 48000,
    copyFromChannel: vi.fn(),
    copyToChannel: vi.fn(),
    getChannelData: () => new Float32Array(samples),
  };
}
test("duration caps and bounded gain reject unsafe decoded audio", () => {
  for (const kind of ["working", "done", "needs-you", "refusal"] as const) {
    expect(recordingGain(kind, buffer(kind === "working" ? 1 : 0.2))).toBeGreaterThan(0);
    for (const duration of [0, -1, NaN, Infinity, 31])
      expect(() => recordingGain(kind, buffer(duration))).toThrow();
  }
  expect(() => recordingGain("working", buffer(0.9))).toThrow();
  expect(() => recordingGain("done", buffer(1.51))).toThrow();
  expect(() => recordingGain("refusal", buffer(0.31))).toThrow();
  expect(() => recordingGain("done", buffer(1, [NaN]))).toThrow();
  expect(recordingGain("done", buffer(1, [0]))).toBe(0);
  expect(recordingGain("done", buffer(1, []))).toBe(0);
  expect(recordingGain("done", buffer(1, [0.000001]))).toBe(4);
  expect(recordingGain("done", buffer(1, [1, ...Array.from({ length: 10000 }, () => 0)]))).toBe(
    0.5,
  );
});
test("falls back without changing the choice and explains decode, read and duration failures", async () => {
  const chosen = { source: "user", file: "mine.wav" } as const;
  const decode = vi.fn(() => Promise.resolve(buffer()));
  const read = vi
    .fn<() => Promise<SoundRead>>()
    .mockResolvedValueOnce({ error: "Missing" })
    .mockResolvedValue({ bytes: new Uint8Array([1]) });
  expect(await loadRecording("done", chosen, read, decode)).toMatchObject({
    reason: "Missing. Using the default sound.",
  });
  expect(read).toHaveBeenLastCalledWith({ kind: "done", ...DEFAULT_SOUND.choices.done });
  expect(chosen.file).toBe("mine.wav");
  decode.mockRejectedValueOnce(new Error("codec"));
  expect((await loadRecording("done", chosen, read, decode)).reason).toContain("decoded");
  decode.mockResolvedValueOnce(buffer(2));
  expect((await loadRecording("done", chosen, read, decode)).reason).toContain("duration");
  read.mockRejectedValueOnce("unavailable");
  expect((await loadRecording("done", chosen, read, decode)).reason).toContain("Sound unavailable");
  read.mockResolvedValue({ error: "Missing default" });
  await expect(loadRecording("done", DEFAULT_SOUND.choices.done, read, decode)).rejects.toThrow(
    "Missing default",
  );
  await expect(loadRecording("done", chosen, read, decode)).rejects.toThrow("Missing default");
});

test("a case-mismatched default filename still falls back on a case-sensitive filesystem", async () => {
  const read = vi
    .fn<() => Promise<SoundRead>>()
    .mockResolvedValueOnce({ error: "missing" })
    .mockResolvedValue({ bytes: new Uint8Array([1]) });
  const chosen = {
    source: "builtin",
    file: DEFAULT_SOUND.choices.done.file.toUpperCase(),
  } as const;
  const result = await loadRecording("done", chosen, read, () => Promise.resolve(buffer()));
  expect(result.reason).toContain("Using the default");
  expect(read).toHaveBeenLastCalledWith({ kind: "done", ...DEFAULT_SOUND.choices.done });
});
