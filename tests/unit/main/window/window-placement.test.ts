import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPlacements,
  parsePlacements,
  placeWindow,
  savePlacements,
} from "../../../../src/main/window/window-placement";
const saved = {
  id: "window-1",
  display: 2,
  bounds: { x: -1500, y: 40, width: 1200, height: 800 },
  maximized: true,
  scale: 120,
};
const primary = { id: 1, workArea: { x: 0, y: 25, width: 1280, height: 900 } };
const secondary = { id: 2, workArea: { x: -1920, y: 0, width: 1920, height: 1080 } };
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
test("restores a connected negative-coordinate display and falls back inside the primary", () => {
  expect(placeWindow(saved, [primary, secondary], primary)).toEqual(saved);
  expect(placeWindow(saved, [primary], primary)).toEqual({
    ...saved,
    display: 1,
    bounds: { x: 0, y: 40, width: 1200, height: 800 },
  });
  expect(
    placeWindow(
      { ...saved, bounds: { x: 10000, y: -10000, width: 5000, height: 5000 } },
      [],
      primary,
    ).bounds,
  ).toEqual(primary.workArea);
  expect(
    placeWindow(
      { ...saved, bounds: { x: 10000, y: 10000, width: 500, height: 400 } },
      [primary],
      primary,
    ).bounds,
  ).toEqual({ x: 780, y: 525, width: 500, height: 400 });
});
test("validates persisted windows independently and rejects duplicate identities", () => {
  expect(parsePlacements([saved, saved, { ...saved, id: "two" }])).toEqual([
    saved,
    { ...saved, id: "two" },
  ]);
  for (const value of [null, {}, "windows", Array.from({ length: 33 }, () => saved)])
    expect(parsePlacements(value)).toEqual([]);
  const fields = {
    id: [null, "", "a".repeat(65), "../path", 2],
    display: [null, "2", 1.5, Infinity],
    maximized: [null, 1],
    scale: [null, "100", 80.5, 79, 151],
    bounds: [null, "bounds", {}],
  };
  for (const [field, invalids] of Object.entries(fields)) {
    for (const invalid of invalids)
      expect(parsePlacements([{ ...saved, [field]: invalid }])).toEqual([]);
    const missing: Record<string, unknown> = Object.fromEntries(
      Object.entries(saved).filter(([key]) => key !== field),
    );
    expect(parsePlacements([missing])).toEqual([]);
  }
  for (const value of [null, 3, "window"]) expect(parsePlacements([value])).toEqual([]);
  for (const field of ["x", "y", "width", "height"]) {
    for (const invalid of [null, "number", 1.5, Infinity, 100001])
      expect(
        parsePlacements([{ ...saved, bounds: { ...saved.bounds, [field]: invalid } }]),
      ).toEqual([]);
    const bounds: Record<string, unknown> = Object.fromEntries(
      Object.entries(saved.bounds).filter(([key]) => key !== field),
    );
    expect(parsePlacements([{ ...saved, bounds }])).toEqual([]);
  }
  for (const field of ["width", "height"])
    expect(parsePlacements([{ ...saved, bounds: { ...saved.bounds, [field]: 0 } }])).toEqual([]);
});
test("persists windows atomically and fails closed for missing, corrupt and oversized files", async () => {
  const root = await mkdtemp(join(tmpdir(), "foom-placements-"));
  directories.push(root);
  const dir = join(root, "profile");
  expect(await loadPlacements(dir)).toEqual([]);
  await savePlacements(dir, [saved]);
  expect(await loadPlacements(dir)).toEqual([saved]);
  expect(JSON.parse(await readFile(join(dir, "windows.json"), "utf8"))).toEqual([saved]);
  await writeFile(join(dir, "windows.json"), "{");
  expect(await loadPlacements(dir)).toEqual([]);
  await writeFile(join(dir, "windows.json"), " ".repeat(32769));
  expect(await loadPlacements(dir)).toEqual([]);
  await rm(join(dir, "windows.json"));
  await mkdir(join(dir, "windows.json"));
  await expect(savePlacements(dir, [saved])).rejects.toThrow();
});
