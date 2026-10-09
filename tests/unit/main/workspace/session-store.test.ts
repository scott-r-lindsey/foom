import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { readSessions, SessionStore } from "../../../../src/main/workspace/session-store";
const root = process.platform === "win32" ? "C:\\repos" : "/repos";
const record = {
  id: "terminal-1",
  agent: "claude",
  repository: root,
  worktree: join(root, "tree"),
  branch: "main",
  conversationId: "session-1",
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "foom-session-store-"));
  directories.push(directory);
  return { directory, store: new SessionStore(directory) };
}
test("persists only metadata, restores exited sessions and serializes Close", async () => {
  const { directory, store } = await setup();
  expect(await store.load()).toEqual([]);
  const restored = readSessions([record]);
  expect(restored[0]).toMatchObject({
    exited: true,
    dormant: true,
    state: null,
    conversationId: "session-1",
  });
  await store.save(restored);
  expect(await store.load()).toEqual(restored);
  expect(JSON.parse(await readFile(join(directory, "sessions.json"), "utf8"))).toEqual([record]);
  if (process.platform !== "win32")
    expect((await stat(join(directory, "sessions.json"))).mode & 0o777).toBe(0o600);
  await Promise.all([store.save(restored), store.save([])]);
  await store.flush();
  expect(await store.load()).toEqual([]);
});
test.each([
  null,
  {},
  Array(1001).fill(record),
  [null],
  [record, record],
  [{ ...record, id: "--bad" }],
  [{ ...record, agent: "other" }],
  [{ ...record, repository: "relative" }],
  [{ ...record, worktree: "a\0b" }],
  [{ ...record, branch: 12 }],
  [{ ...record, conversationId: "--last" }],
  [{ ...record, agent: "agy" }],
])("rejects corrupt disk records", (value) => {
  expect(() => readSessions(value)).toThrow();
});
test("restores shells and unknown conversations without inventing IDs", () => {
  expect(
    readSessions([{ ...record, agent: "shell", conversationId: undefined, branch: null }])[0],
  ).toMatchObject({ kind: "shell", branch: null });
});
test("corrupt and oversized files are ignored; failed writes can be retried", async () => {
  const { directory, store } = await setup();
  await writeFile(join(directory, "sessions.json"), "{");
  expect(await store.load()).toEqual([]);
  await writeFile(join(directory, "sessions.json"), " ".repeat(1024 * 1024 + 1));
  expect(await store.load()).toEqual([]);
  await mkdir(join(directory, "sessions.json.tmp"));
  await expect(store.save([])).rejects.toThrow();
  await rm(join(directory, "sessions.json.tmp"), { recursive: true });
  await store.save([]);
  expect(await store.load()).toEqual([]);
});

test("ignores obsolete session fields without persisting them", async () => {
  const { store, directory } = await setup();
  const expected = readSessions([record]);
  for (const readOnly of [true, false, "true", 1, null]) {
    const entries = readSessions([{ ...record, readOnly }]);
    expect(entries).toEqual(expected);
    await store.save(entries);
    expect(await store.load()).toEqual(expected);
    expect(await readFile(join(directory, "sessions.json"), "utf8")).not.toContain("readOnly");
  }
});

test("home records persist only the shell location marker and reject forged agent homes", async () => {
  const { store } = await setup();
  const shell = {
    ...record,
    agent: "shell",
    home: true,
    repository: root,
    worktree: root,
    branch: null,
    conversationId: undefined,
  };
  const entries = readSessions([shell]);
  expect(entries[0]?.home).toBe(true);
  await store.save(entries);
  expect(await store.load()).toEqual(entries);
  for (const bad of [
    { ...shell, home: false },
    { ...shell, agent: "claude" },
    { ...shell, branch: "main" },
    { ...shell, worktree: join(root, "elsewhere") },
  ])
    expect(() => readSessions([bad])).toThrow();
});
