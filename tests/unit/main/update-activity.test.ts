import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, onTestFinished } from "vitest";
import { UpdateActivity } from "../../../src/main/update-activity";

async function fixture(onTestFinished: (fn: () => Promise<void>) => void) {
  const directory = await mkdtemp(join(tmpdir(), "foom-update-activity-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return {
    directory,
    file: join(directory, "update-activity.json"),
    store: new UpdateActivity(directory),
  };
}

test("UTC days, ISO weeks and months advance independently and persist across restarts", async ({
  onTestFinished,
}) => {
  const { directory, file, store } = await fixture(onTestFinished);
  const flags = (date: string) => store.flags(new Date(date));
  expect(await flags("2026-12-31T23:59:59Z")).toBe("?d=1&w=1&m=1");
  expect(await flags("2026-12-31T23:59:59Z")).toBe("");
  expect(await flags("2027-01-01T00:00:00Z")).toBe("?d=1&m=1");
  expect(await flags("2027-01-03T23:59:59Z")).toBe("?d=1");
  expect(await flags("2027-01-04T00:00:00Z")).toBe("?d=1&w=1");
  expect(await flags("2027-02-01T00:00:00Z")).toBe("?d=1&w=1&m=1");
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
    d: "2027-02-01",
    w: "2027-02-01",
    m: "2027-02-01",
  });
  const reloaded = new UpdateActivity(directory);
  expect(await reloaded.flags(new Date("2027-02-01T23:59:59Z"))).toBe("");
  expect(await reloaded.flags(new Date("2026-01-01T00:00:00Z"))).toBe("");
  expect(await reloaded.flags(new Date("2027-02-02T00:00:00Z"))).toBe("?d=1");
});

test.each([
  "null",
  "[]",
  "false",
  "bad json",
  '{"d":"2026-02-30","w":"2026-12-31","m":"2026-12-02"}',
  '{"d":42,"w":"garbage","m":null}',
])("invalid profile dates %s are never sent", async (body) => {
  const { file, store } = await fixture(onTestFinished);
  await writeFile(file, body);
  expect(await store.flags(new Date("2026-12-31T00:00:00Z"))).toBe("?d=1&w=1&m=1");
});

test("valid fields survive invalid siblings and unknown fields are discarded", async ({
  onTestFinished,
}) => {
  const { file, store } = await fixture(onTestFinished);
  await writeFile(
    file,
    JSON.stringify({ d: "2026-12-31", w: false, m: "2026-12-01", id: "discard" }),
  );
  expect(await store.flags(new Date("2026-12-31T00:00:00Z"))).toBe("?w=1");
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
    d: "2026-12-31",
    w: "2026-12-28",
    m: "2026-12-01",
  });
});

test("failed atomic saves leave no temporary file and can retry", async ({ onTestFinished }) => {
  const { directory } = await fixture(onTestFinished);
  const store = new UpdateActivity(join(directory, "missing"));
  await expect(store.flags()).rejects.toThrow();
  expect(await readdir(directory)).toEqual([]);
});

test("overlapping checks reserve each period once", async ({ onTestFinished }) => {
  const { store } = await fixture(onTestFinished);
  const now = new Date("2026-12-31T00:00:00Z");
  expect(await Promise.all([store.flags(now), store.flags(now), store.flags(now)])).toEqual([
    "?d=1&w=1&m=1",
    "",
    "",
  ]);
});
