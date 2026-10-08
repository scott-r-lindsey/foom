import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SoundLibrary,
  matchesSoundHeader,
  soundSizeLimit,
} from "../../../../src/main/sounds/library";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const wav = Buffer.from("RIFF0000WAVEfmt ");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "foom-sounds-"));
  roots.push(root);
  const library = new SoundLibrary(join(root, "builtin"), join(root, "user"));
  await library.initialize();
  return { root, library, done: join(root, "user/done") };
}
test("headers match accepted formats and reject renamed or corrupt content", () => {
  for (const [file, header] of [
    ["a.wav", "RIFF0000WAVE"],
    ["a.flac", "fLaC"],
    ["a.ogg", "OggS0000OpusHead"],
    ["a.opus", "OggS0000OpusHead"],
    ["a.ogg", "OggS0000\x01vorbis"],
    ["a.mp3", "ID3\x04"],
  ]) {
    if (file === undefined || header === undefined) throw Error("fixture");
    expect(matchesSoundHeader(file, Buffer.from(header))).toBe(true);
  }
  expect(matchesSoundHeader("x.mp3", Buffer.from([0xff, 0xfb, 0x90]))).toBe(true);
  for (const file of ["a.wav", "a.flac", "a.ogg", "a.opus", "a.mp3", "a.bin"])
    expect(matchesSoundHeader(file, Buffer.from("not audio"))).toBe(false);
  expect(matchesSoundHeader("a.opus", Buffer.from("OggS\x01vorbis"))).toBe(false);
  expect(matchesSoundHeader("a.mp3", Buffer.from([0xff, 0xfb, 0xf0]))).toBe(false);
  expect(matchesSoundHeader("a.mp3", Buffer.alloc(0))).toBe(false);
  expect(soundSizeLimit("working")).toBe(8 * 1024 * 1024);
});
test("lists direct audio files, explains invalid files and re-reads updates", async () => {
  const f = await fixture();
  await writeFile(join(f.done, "valid.wav"), wav);
  await writeFile(join(f.done, "bad.mp3"), wav);
  await writeFile(join(f.done, ".hidden.wav"), wav);
  await writeFile(join(f.done, "ignored.txt"), wav);
  await writeFile(join(f.done, "a".repeat(101) + ".wav"), wav);
  await mkdir(join(f.done, "nested.wav"));
  expect(await f.library.list()).toEqual([
    {
      kind: "done",
      source: "user",
      file: "bad.mp3",
      name: "Bad",
      error: "Audio header does not match its extension",
    },
    { kind: "done", source: "user", file: "valid.wav", name: "Valid" },
  ]);
  expect(await f.library.read({ kind: "done", source: "user", file: "valid.wav" })).toEqual({
    bytes: new Uint8Array(wav),
  });
  await writeFile(join(f.done, "valid.wav"), Buffer.from("corrupt"));
  expect(await f.library.read({ kind: "done", source: "user", file: "valid.wav" })).toHaveProperty(
    "error",
  );
  expect(
    await f.library.read({ kind: "done", source: "user", file: "missing.wav" }),
  ).toHaveProperty("error");
  await expect(
    f.library.read({ kind: "done", source: "user", file: "../outside.wav" }),
  ).rejects.toThrow();
  await writeFile(join(f.done, "oversize.wav"), Buffer.alloc(2 * 1024 * 1024 + 1));
  expect(await f.library.read({ kind: "done", source: "user", file: "oversize.wav" })).toEqual({
    error: "Sound exceeds the 2 MB limit",
  });
  await writeFile(join(f.root, "user/working/oversize.wav"), Buffer.alloc(8 * 1024 * 1024 + 1));
  expect(await f.library.read({ kind: "working", source: "user", file: "oversize.wav" })).toEqual({
    error: "Sound exceeds the 8 MB limit",
  });
});
test.skipIf(process.platform === "win32")(
  "confines links to the same folder and rejects dangling and folder links",
  async () => {
    const f = await fixture();
    await writeFile(join(f.done, "ok.wav"), wav);
    await writeFile(join(f.root, "outside.wav"), wav);
    await symlink(join(f.done, "ok.wav"), join(f.done, "inside.wav"));
    await symlink(join(f.root, "outside.wav"), join(f.done, "outside.wav"));
    await symlink(join(f.root, "absent"), join(f.done, "dangling.wav"));
    await mkdir(join(f.done, "dir"));
    await symlink(join(f.done, "dir"), join(f.done, "dir.wav"));
    expect(
      await f.library.read({ kind: "done", source: "user", file: "inside.wav" }),
    ).toHaveProperty("bytes");
    for (const file of ["outside.wav", "dangling.wav", "dir.wav"])
      expect(await f.library.read({ kind: "done", source: "user", file })).toHaveProperty("error");
    await rm(join(f.root, "user/refusal"), { recursive: true });
    await symlink(f.done, join(f.root, "user/refusal"));
    expect((await f.library.list()).filter((entry) => entry.kind === "refusal")).toEqual([]);
  },
);
test("limits both catalogs and direct reads to 100 files per folder", async () => {
  const f = await fixture();
  await Promise.all(
    Array.from({ length: 101 }, (_, i) => writeFile(join(f.done, `sound-${String(i)}.wav`), wav)),
  );
  const list = await f.library.list();
  expect(list).toHaveLength(100);
  const excluded = Array.from({ length: 101 }, (_, i) => `sound-${String(i)}.wav`).find(
    (file) => !list.some((entry) => entry.file === file),
  );
  expect(await f.library.read({ kind: "done", source: "user", file: excluded })).toHaveProperty(
    "error",
  );
});
