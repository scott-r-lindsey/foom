import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { loadWindowSize, saveWindowSize } from "../../../../src/main/window/window-state";

const dirs: string[] = [];
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "foom-window-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("missing state uses defaults and saved dimensions survive reopening", async () => {
  const dir = join(await directory(), "nested");
  expect(await loadWindowSize(dir)).toBeUndefined();
  await saveWindowSize(dir, { width: 1200, height: 850 });
  expect(await loadWindowSize(dir)).toEqual({ width: 1200, height: 850 });
  await saveWindowSize(dir, { width: 1000, height: 700 });
  expect(await loadWindowSize(dir)).toEqual({ width: 1000, height: 700 });
  expect(await readdir(dir)).toEqual(["window-size.json"]);
});

test("corrupt or invalid dimensions fall back to the first-launch size", async () => {
  const dir = await directory();
  for (const value of [
    "broken",
    "null",
    "[]",
    "4",
    "{}",
    '{"width":900}',
    ...[
      { width: "900", height: 640 },
      { width: 0, height: 640 },
      { width: 900.5, height: 640 },
      { width: 900, height: "640" },
      { width: 900, height: 0 },
      { width: 900, height: 640.5 },
    ].map((value) => JSON.stringify(value)),
  ]) {
    await writeFile(join(dir, "window-size.json"), value);
    expect(await loadWindowSize(dir)).toBeUndefined();
  }
});

test("a failed replacement cleans up its temporary file", async () => {
  const dir = await directory();
  await mkdir(join(dir, "window-size.json"));
  await expect(saveWindowSize(dir, { width: 1000, height: 700 })).rejects.toThrow();
  expect(await readdir(dir)).toEqual(["window-size.json"]);
});
