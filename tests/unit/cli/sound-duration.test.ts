import { expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { soundDuration } from "../../../src/cli/sound-duration";
import { SOUND_KINDS } from "../../../src/shared/sounds";
import { validSoundDuration } from "../../../src/shared/sound-files";

test("rejects huge WAV token lengths before the tokenizer can allocate", async () => {
  for (const size of [268435456, 0xffffffff]) {
    const bytes = Buffer.alloc(20);
    bytes.write("RIFF");
    bytes.writeUInt32LE(size, 4);
    bytes.write("WAVECSET", 8);
    bytes.writeUInt32LE(size, 16);
    await expect(soundDuration(bytes, "attack.wav")).rejects.toThrow("Invalid audio token bounds");
  }
});
test("rejects truncated metadata and reads real recordings through bounded tokens", async () => {
  await expect(soundDuration(new Uint8Array(), "empty.wav")).rejects.toThrow();
  for (const kind of SOUND_KINDS) {
    const file = {
      working: "seagate-read-write.ogg",
      done: "typewriter-bell.ogg",
      "needs-you": "bicycle-bell.ogg",
      refusal: "lip-pop.ogg",
    }[kind];
    const bytes = await readFile(`src/sounds/${kind}/${file}`);
    expect(validSoundDuration(kind, await soundDuration(bytes, file))).toBe(true);
  }
});

test("reads MP3, FLAC and Vorbis duration, including tokenizer lookahead", async () => {
  for (const extension of ["mp3", "flac", "ogg"]) {
    const file = `tone.${extension}`;
    const bytes = await readFile(`tests/fixtures/sounds/${file}`);
    const duration = await soundDuration(bytes, file);
    expect(duration).toBeGreaterThanOrEqual(0.1);
    expect(duration).toBeLessThan(0.2);
  }
});

function flacComment(payload: Uint8Array, size = payload.length): Buffer {
  const bytes = Buffer.alloc(8 + payload.length);
  bytes.write("fLaC");
  bytes.writeUInt32BE(0x84000000 + size, 4);
  bytes.set(payload, 8);
  return bytes;
}
test("bounds FLAC comments before parser-internal allocations", async () => {
  const malicious = Buffer.alloc(8);
  malicious.writeUInt32LE(16000000, 4);
  await expect(soundDuration(flacComment(malicious), "attack.flac")).rejects.toThrow(
    "Invalid FLAC comment count",
  );
  for (const bytes of [Buffer.from("fLaC"), flacComment(new Uint8Array(1), 100)])
    await expect(soundDuration(bytes, "bad.flac")).rejects.toThrow("Truncated FLAC block");
  const vendor = Buffer.alloc(8);
  vendor.writeUInt32LE(100, 0);
  const comment = Buffer.alloc(12);
  comment.writeUInt32LE(1, 4);
  comment.writeUInt32LE(100, 8);
  const nextComment = Buffer.alloc(16);
  nextComment.writeUInt32LE(2, 4);
  nextComment.writeUInt32LE(4, 8);
  for (const payload of [new Uint8Array(4), vendor, comment, nextComment])
    await expect(soundDuration(flacComment(payload), "bad.flac")).rejects.toThrow(
      "Invalid FLAC comments",
    );
});
