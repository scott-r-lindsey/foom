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
test.each(["claude", "codex", "agy"])(
  "persists %s metadata, restores exited sessions and serializes Close",
  async (agent) => {
    const entry = { ...record, agent };
    const { directory, store } = await setup();
    expect(await store.load()).toEqual([]);
    const restored = readSessions([entry]);
    expect(restored[0]).toMatchObject({
      exited: true,
      dormant: true,
      state: null,
      conversationId: "session-1",
    });
    await store.save(restored);
    expect(await store.load()).toEqual(restored);
    expect(JSON.parse(await readFile(join(directory, "sessions.json"), "utf8"))).toEqual([entry]);
    if (process.platform !== "win32")
      expect((await stat(join(directory, "sessions.json"))).mode & 0o777).toBe(0o600);
    await Promise.all([store.save(restored), store.save([])]);
    await store.flush();
    expect(await store.load()).toEqual([]);
  },
);
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
  [{ ...record, agent: "shell" }],
  [{ ...record, agent: "agy", conversationId: "../escape" }],
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
test("config sessions keep their discriminator across a save and load", async () => {
  const { store } = await setup();
  const config = { ...record, config: true, worktree: root, branch: null };
  const [restored] = readSessions([config]);
  if (!restored) throw new Error("Expected a session");
  expect(restored).toMatchObject({ config: true, repository: root, worktree: root });
  await store.save([restored]);
  expect((await store.load())[0]).toMatchObject({ config: true });
  for (const invalid of [
    { ...config, config: "yes" },
    { ...config, worktree: join(root, "tree") },
    { ...config, branch: "main" },
    { ...config, home: true, agent: "shell" },
  ])
    expect(() => readSessions([invalid])).toThrow();
});

test("round trips running state and main-owned roles, discarding invented capabilities", async () => {
  const { store } = await setup();
  const role = {
    identity: "repo-identity",
    history: [{ id: "action", action: "stop", label: "child", status: "succeeded", at: 1 }],
  };
  const entries = readSessions([
    { ...record, running: true, orchestrator: role, controlToken: "never", command: "/untrusted" },
    { ...record, id: "child", running: true, parentId: record.id },
  ]);
  await store.save(entries);
  expect(await store.load()).toEqual(entries);
  expect(entries[0]).not.toHaveProperty("controlToken");
  expect(entries[0]).not.toHaveProperty("command");
});

test.each([
  { running: "true" },
  { parentId: "bad/id" },
  { parentId: record.id },
  { agent: "shell", conversationId: undefined, parentId: "parent" },
  { orchestrator: null },
  { orchestrator: 1 },
  { orchestrator: {} },
  { orchestrator: { identity: "", history: [] } },
  { orchestrator: { identity: "x".repeat(4097), history: [] } },
  { orchestrator: { identity: "ok", history: {} } },
  { orchestrator: { identity: "ok", history: Array(21).fill({}) } },
  { orchestrator: { identity: "ok", history: [null] } },
  { orchestrator: { identity: "ok", history: [{}] } },
  { orchestrator: { identity: "ok", history: [] }, parentId: "parent" },
])("rejects malformed persisted restore provenance %j", (extra) => {
  expect(() => readSessions([{ ...record, ...extra }])).toThrow();
});

test("validates every action-log field without restoring pending operations", () => {
  const history = { id: "a", action: "launch", label: "child", status: "succeeded", at: 1 };
  for (const extra of [
    { id: 1 },
    { id: "x".repeat(257) },
    { label: false },
    { label: "x".repeat(4097) },
    { at: "now" },
    { at: NaN },
    { action: "input" },
    { status: "approved" },
  ]) {
    expect(() =>
      readSessions([
        { ...record, orchestrator: { identity: "ok", history: [{ ...history, ...extra }] } },
      ]),
    ).toThrow();
  }
  for (const action of [
    "create_worktree",
    "launch",
    "stop",
    "remove_worktree",
    "reply",
    "take_over",
  ]) {
    for (const status of [
      "pending_confirmation",
      "running",
      "succeeded",
      "failed",
      "declined",
      "cancelled",
      "indeterminate",
    ]) {
      expect(
        readSessions([
          {
            ...record,
            orchestrator: { identity: "ok", history: [{ ...history, action, status }] },
          },
        ])[0]?.orchestrator?.history,
      ).toHaveLength(1);
    }
  }
});

test("round trips owned worktrees and refuses malformed ownership and budgets", async () => {
  const { store } = await setup();
  const tree = { path: join(root, "owned"), identity: "checkout", state: "unused" };
  const role = { identity: "repo", history: [], worktrees: [tree], uncertain: 2 };
  const entries = readSessions([{ ...record, orchestrator: role }]);
  await store.save(entries);
  expect(await store.load()).toEqual(entries);
  for (const worktrees of [
    null,
    {},
    [null],
    [{}],
    [{ ...tree, path: "relative" }],
    [{ ...tree, identity: "" }],
    [{ ...tree, identity: 1 }],
    [{ ...tree, identity: "x".repeat(4097) }],
    [{ ...tree, state: "starting" }],
    [{ ...tree, extra: true }],
    [tree, tree],
    Array(1001).fill(tree),
    Array.from({ length: 5 }, (_, i) => ({ ...tree, path: join(root, String(i)) })),
  ]) {
    expect(() => readSessions([{ ...record, orchestrator: { ...role, worktrees } }])).toThrow();
  }
  for (const uncertain of [-1, 5, 1.5, "1", null]) {
    expect(() => readSessions([{ ...record, orchestrator: { ...role, uncertain } }])).toThrow();
  }
  expect(() => readSessions([{ ...record, orchestrator: { ...role, uncertain: 4 } }])).toThrow();
});

test("preserves config-agent conversation metadata while its provider is unavailable without granting launch authority", async () => {
  const { knownAgentId } = await import("../../../../src/main/agents/providers/registry");
  const plugin = { ...record, agent: "unavailable-fixture", providerOrigin: "config" };
  expect(knownAgentId(plugin.agent)).toBe(false);
  const entries = readSessions([plugin]);
  expect(entries[0]).toMatchObject({
    agent: plugin.agent,
    providerOrigin: "config",
    conversationId: record.conversationId,
    exited: true,
    dormant: true,
  });
  const { store } = await setup();
  await store.save(entries);
  expect(await store.load()).toEqual(entries);
  expect(knownAgentId(plugin.agent)).toBe(false);
  for (const value of [
    { ...plugin, providerOrigin: true },
    { ...plugin, providerOrigin: "builtin" },
    { ...plugin, agent: "shell" },
    { ...plugin, agent: "claude" },
    { ...plugin, agent: "../escape" },
  ])
    expect(() => readSessions([value])).toThrow();
  expect(() => readSessions([{ ...record, agent: "unavailable-fixture" }])).toThrow();
});

test("retains bounded child handoffs across restart and deletes them with the row", async () => {
  const { store } = await setup();
  const handoffs = [
    {
      seq: 7,
      status: "blocked",
      summary: "CI is red",
      links: ["https://example.com/pr/1"],
      timestamp: "2026-10-15T00:00:00.000Z",
    },
  ];
  await store.save(readSessions([{ ...record, parentId: "parent", handoffs }]));
  expect((await store.load())[0]?.handoffs).toEqual(handoffs);
  await store.save([]);
  expect(await store.load()).toEqual([]);
  expect(() =>
    readSessions([{ ...record, handoffs: [{ ...handoffs[0], summary: "bad\u001b" }] }]),
  ).toThrow();
});

test("persists requested selections as validated metadata", async () => {
  const { store } = await setup();
  const selection = { model: "fixture/model", effort: "high" };
  await store.save([{ ...record, kind: "agent", attention: "hooks", state: null, selection }]);
  expect((await store.load())[0]?.selection).toEqual(selection);
  expect(() => readSessions([{ ...record, selection: { model: "--bad" } }])).toThrow(
    "invalid_request",
  );
  expect(() => readSessions([{ ...record, selection: { args: [] } }])).toThrow("invalid_request");
});

test("persists actual placement independently of startup mappings and rejects malformed aliases", async () => {
  const { store } = await setup();
  const rows = readSessions([
    { ...record, placement: { kind: "local" } },
    { ...record, id: "remote", remote: true, placement: { kind: "remote", host: "fixture-alias" } },
  ]);
  await store.save(rows);
  expect(await store.load()).toEqual(rows);
  for (const placement of [
    null,
    { kind: "remote", host: "-oBAD" },
    { kind: "remote", host: "host\nsecret" },
    { kind: "local", host: "host" },
    { kind: "unknown" },
  ])
    expect(() => readSessions([{ ...record, remote: true, placement }])).toThrow();
  expect(() =>
    readSessions([{ ...record, placement: { kind: "remote", host: "fixture" } }]),
  ).toThrow();
});
