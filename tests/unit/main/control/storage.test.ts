import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { rename } from "node:fs/promises";
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
import {
  atomicPrivate,
  privateDirectory,
  readDiscovery,
  verifyPrivate,
} from "../../../../src/main/control/private-files";
import { ControlRuntime } from "../../../../src/main/control/runtime";
import { ControlStore } from "../../../../src/main/control/store";
import type { StoredOperation } from "../../../../src/main/control/types";

// Native Windows ACL checks invoke PowerShell at each file boundary.
vi.setConfig({ testTimeout: process.platform === "win32" ? 60000 : 5000 });

let root: string;
let directory: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "foom-control-test-"));
  directory = await privateDirectory(root);
});
afterEach(async () => {
  vi.mocked(rename).mockImplementation(fs.rename);
  await rm(root, { recursive: true, force: true });
});
const metadata = {
  version: 1,
  endpoint: "http://127.0.0.1:12345/control/v1",
  instanceId: "instance",
};
const record: StoredOperation = {
  actor: {
    generation: "generation",
    sessionId: "session",
    repository: "repository",
    worktree: "worktree",
    terminalId: "terminal",
    parentId: null,
    role: "orchestrator",
  },
  key: "hash",
  fingerprint: "hash",
  operation: {
    operationId: "11111111-1111-1111-1111-111111111111",
    action: "stop",
    targetId: "child",
    resultId: null,
    status: "running",
    createdAt: "2026-10-07T00:00:00Z",
    updatedAt: "2026-10-07T00:00:00Z",
    reason: "intent",
  },
};
it("atomically publishes private, credential-free metadata", async () => {
  expect(await privateDirectory(root)).toBe(directory);
  await atomicPrivate(directory, "discovery.json", metadata);
  expect(await readDiscovery(directory)).toEqual(metadata);
  if (process.platform !== "win32") {
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(directory, "discovery.json"))).mode & 0o777).toBe(0o600);
  }
  await atomicPrivate(directory, "discovery.json", { ...metadata, instanceId: "next" });
  expect((await readDiscovery(directory)).instanceId).toBe("next");
  expect(await readdir(directory)).toEqual(["discovery.json"]);
});
it.each([
  { ...metadata, version: 2 },
  { ...metadata, token: "secret" },
  { ...metadata, endpoint: 2 },
  { ...metadata, endpoint: "http://localhost:12345/control/v1" },
  { ...metadata, endpoint: "http://2130706433:12345/control/v1" },
  { ...metadata, endpoint: "https://127.0.0.1:12345/control/v1" },
  { ...metadata, endpoint: "http://127.0.0.1/control/v1" },
  { ...metadata, endpoint: "http://user:secret@127.0.0.1:12345/control/v1" },
  { ...metadata, endpoint: "http://127.0.0.1:12345/control/v1?token=x" },
  { ...metadata, endpoint: "http://127.0.0.1:12345/control/v1#token" },
  { ...metadata, endpoint: "http://127.0.0.1:12345/other" },
  { ...metadata, instanceId: "x".repeat(5000) },
])("rejects unsafe discovery %j", async (value) => {
  await atomicPrivate(directory, "discovery.json", value);
  await expect(readDiscovery(directory)).rejects.toThrow("invalid_request");
});
it("refuses redirected, insecure and non-file storage", async () => {
  await expect(verifyPrivate(directory, false)).rejects.toThrow("unavailable");
  if (process.platform !== "win32") {
    const external = join(root, "external");
    await writeFile(external, "secret", { mode: 0o600 });
    await symlink(external, join(directory, "discovery.json"));
    await expect(readDiscovery(directory)).rejects.toThrow("unavailable");
    await rm(join(directory, "discovery.json"));
    await atomicPrivate(directory, "discovery.json", metadata);
    await chmod(join(directory, "discovery.json"), 0o644);
    await expect(readDiscovery(directory)).rejects.toThrow("unavailable");
    await chmod(directory, 0o755);
    await expect(privateDirectory(root)).rejects.toThrow("unavailable");
    await chmod(directory, 0o700);
    await rm(directory, { recursive: true });
    await mkdir(external + "-directory");
    await symlink(external + "-directory", directory);
    await expect(privateDirectory(root)).rejects.toThrow("unavailable");
  }
});
it("cleans atomic-write scratch files on rename failure", async () => {
  await mkdir(join(directory, "discovery.json"));
  await expect(atomicPrivate(directory, "discovery.json", metadata)).rejects.toThrow();
  expect(await readdir(directory)).toEqual(["discovery.json"]);
});
it("persists deduplication independently of clearable audit and reconciles crashed intents", async () => {
  const store = new ControlStore(directory);
  await store.persist(record);
  const name = `operation-${record.operation.operationId}.json`;
  expect(JSON.parse(await readFile(join(directory, name), "utf8"))).toEqual(record);
  expect(await readFile(join(directory, "actions-0.jsonl"), "utf8")).toContain(
    '"status":"running"',
  );
  await store.clearAudit();
  expect(await readdir(directory)).toEqual([name]);
  await store.recover();
  expect(await readdir(directory)).toEqual(["actions-0.jsonl"]);
  expect(await readFile(join(directory, "actions-0.jsonl"), "utf8")).toContain(
    '"status":"indeterminate"',
  );
  await store.recover();
});
it("rotates audit size, prunes expired files and retains at most five", async () => {
  const store = new ControlStore(directory);
  for (let index = 0; index < 6; index++) {
    await store.persist(record);
    await truncate(join(directory, "actions-0.jsonl"), 10 * 1024 * 1024);
  }
  expect((await readdir(directory)).filter((name) => name.startsWith("actions-"))).toHaveLength(5);
  const old = new Date(Date.now() - 31 * 24 * 3600 * 1000);
  await utimes(join(directory, "actions-4.jsonl"), old, old);
  await truncate(join(directory, "actions-0.jsonl"), 0);
  await store.persist(record);
  expect(await readdir(directory)).not.toContain("actions-4.jsonl");
});
it("refuses audit replacement and fails before a caller could mutate", async () => {
  const store = new ControlStore(directory);
  await mkdir(join(directory, "actions-0.jsonl"));
  await expect(store.persist(record)).rejects.toThrow("unavailable");
});
it("runs the real lazy endpoint, grants fresh credentials, removes discovery on shutdown", async () => {
  const runtime = await ControlRuntime.start(root);
  try {
    const discovery = await readDiscovery(directory);
    const launch = runtime.prepare(root, root);
    launch.bind("terminal");
    expect(launch.env["FOOM_CONTROL_URL"]).toBe(discovery.endpoint);
    const response = await fetch(discovery.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${launch.env["FOOM_CONTROL_TOKEN"] ?? ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: 1,
        instanceId: discovery.instanceId,
        method: "whoami",
        params: {},
      }),
    });
    expect(response.status).toBe(200);
    launch.dispose();
    // Main's launch path selects the role; a child grant records its parent.
    const parent = runtime.prepare(root, root, undefined, "orchestrator");
    parent.bind("parent");
    const child = runtime.prepare(root, root, "child-session", "agent", "parent");
    child.bind("child");
    const childActor = runtime.service.authenticate(child.env["FOOM_CONTROL_TOKEN"] ?? "");
    expect(childActor).toMatchObject({
      role: "agent",
      parentId: "parent",
      sessionId: "child-session",
    });
    expect(runtime.service.authenticate(parent.env["FOOM_CONTROL_TOKEN"] ?? "").role).toBe(
      "orchestrator",
    );
    // The human's revoke and grant reach the same credential through the runtime.
    runtime.setRole("parent", "agent");
    expect(runtime.service.authenticate(parent.env["FOOM_CONTROL_TOKEN"] ?? "").role).toBe("agent");
    parent.dispose();
    child.dispose();
    const orchestrator = runtime.service.prepare(root, root, "orchestrator");
    orchestrator.bind("orchestrator");
    const actor = runtime.service.authenticate(orchestrator.env["FOOM_CONTROL_TOKEN"] ?? "");
    await runtime.service.operations.begin(actor, "stop", "key", "{}");
    orchestrator.dispose();
    await runtime.service.operations.drain();
  } finally {
    await runtime.close();
  }
  expect(await readdir(directory)).not.toContain("discovery.json");
  const fresh = await ControlRuntime.start(root);
  await fresh.close();
});
it("closes listener when publishing discovery fails", async () => {
  await mkdir(join(directory, "discovery.json"));
  await expect(ControlRuntime.start(root)).rejects.toThrow();
});

it("refuses a mutation when audit rotation cannot be persisted", async () => {
  const store = new ControlStore(directory);
  await store.persist(record);
  await truncate(join(directory, "actions-0.jsonl"), 10 * 1024 * 1024);
  vi.mocked(rename).mockImplementation((source, target) => {
    if (String(source).includes("actions-")) return Promise.reject(new Error("disk unavailable"));
    return fs.rename(source, target);
  });
  await expect(store.persist(record)).rejects.toThrow("disk unavailable");
});

it.each(["succeeded", "declined", "failed", "cancelled", "indeterminate"] as const)(
  "preserves known %s outcomes during recovery",
  async (status) => {
    const store = new ControlStore(directory);
    await store.persist({ ...record, operation: { ...record.operation, status } });
    await store.clearAudit();
    await store.recover();
    expect(await readFile(join(directory, "actions-0.jsonl"), "utf8")).toContain(
      `"status":"${status}"`,
    );
  },
);
it.each(["invalid", 42, "x".repeat(17000)])(
  "fails closed on malformed recovery state",
  async (status) => {
    const name = `operation-${record.operation.operationId}.json`;
    await atomicPrivate(directory, name, { operation: { status } });
    await expect(new ControlStore(directory).recover()).rejects.toThrow("unavailable");
    expect(await readdir(directory)).toContain(name);
  },
);
it("searches only redacted allowlisted history, filters and pages, and serializes clearing", async () => {
  const store = new ControlStore(directory);
  await store.persist({
    ...record,
    operation: { ...record.operation, action: "reply", proposal: "token=top-secret" },
  });
  const query = { search: "", action: "", status: "", offset: 0 };
  const page = await store.read(query);
  expect(page.entries[0]).toMatchObject({
    actorId: "terminal",
    targetId: "child",
    action: "reply",
    proposal: "[REDACTED CREDENTIAL]",
  });
  expect(JSON.stringify(page)).not.toMatch(/top-secret|fingerprint|generation|sessionId/u);
  expect(
    (await store.read({ ...query, search: "REDACTED", action: "reply", status: "running" })).total,
  ).toBe(1);
  expect((await store.read({ ...query, action: "stop" })).total).toBe(0);
  expect((await store.read({ ...query, status: "succeeded" })).total).toBe(0);
  expect((await store.read({ ...query, search: "absent" })).total).toBe(0);
  await store.human("make_orchestrator", "human", "repository", "worktree", null, "succeeded");
  await store.refused(record.actor, "tail");
  await store.refused(record.actor, "tail", "succeeded", "child");
  expect(
    (await store.read({ ...query, action: "tail", status: "succeeded" })).entries[0]?.targetId,
  ).toBe("child");
  expect((await store.read({ ...query, status: "refused" })).entries[0]?.reason).toBe("refused");
  await Promise.all([
    store.human("take_over", "human", "repo", "tree", "child", "succeeded"),
    store.clearAudit(),
  ]);
  expect(await store.read(query)).toEqual({ entries: [], total: 0 });
  expect(await readdir(directory)).toContain(`operation-${record.operation.operationId}.json`);
  await store.human("take_over", "human", "repo", "tree", null, "succeeded");
  const auditPath = join(directory, "actions-0.jsonl");
  const event = await readFile(auditPath, "utf8");
  await writeFile(auditPath, event.repeat(102));
  expect((await store.read(query)).entries).toHaveLength(100);
  expect((await store.read({ ...query, offset: 100 })).entries).toHaveLength(2);
  expect((await store.read({ ...query, offset: 100001 })).entries).toHaveLength(0);
});
it.each([
  null,
  {},
  { search: 1, action: "", status: "", offset: 0 },
  { search: "x".repeat(257), action: "", status: "", offset: 0 },
  { search: "", action: 1, status: "", offset: 0 },
  { search: "", action: "x".repeat(65), status: "", offset: 0 },
  { search: "", action: "", status: 1, offset: 0 },
  { search: "", action: "", status: "x".repeat(65), offset: 0 },
  { search: "", action: "", status: "", offset: -1 },
  { search: "", action: "", status: "", offset: 0.5 },
  { search: "", action: "", status: "", offset: Number.MAX_SAFE_INTEGER + 1 },
  { search: "", action: "", status: "", offset: "0" },
  { search: "", action: "", status: "", offset: 0, path: "/secret" },
])("rejects invalid log queries %j", async (query) => {
  await expect(new ControlStore(directory).read(query)).rejects.toThrow();
});
it("fails closed on oversized, corrupted, insecure or malformed history, and expires old entries", async () => {
  const store = new ControlStore(directory);
  const query = { search: "", action: "", status: "", offset: 0 };
  const path = join(directory, "actions-0.jsonl");
  await store.persist(record);
  const original = await readFile(path, "utf8");
  await truncate(path, 10 * 1024 * 1024 + 1);
  await expect(store.read(query)).rejects.toThrow("unavailable");
  for (const data of [
    "invalid",
    JSON.stringify({ timestamp: "invalid" }),
    JSON.stringify({ timestamp: new Date().toISOString(), status: 4 }),
    JSON.stringify({ timestamp: new Date().toISOString(), proposal: "x".repeat(8193) }),
  ]) {
    await writeFile(path, data + "\n");
    await expect(store.read(query)).rejects.toThrow();
  }
  const value: unknown = JSON.parse(original);
  if (typeof value !== "object" || value === null) throw new Error("Missing record");
  await writeFile(path, JSON.stringify({ ...value, timestamp: "2000-01-01T00:00:00Z" }) + "\n");
  expect((await store.read(query)).total).toBe(0);
  if (process.platform !== "win32") {
    await chmod(path, 0o644);
    await expect(store.read(query)).rejects.toThrow();
  }
});

it("preserves opaque worktree identities while refusing malformed identity fields", async () => {
  const store = new ControlStore(directory);
  const targetId = "a".repeat(64);
  const resultId = "b".repeat(64);
  await store.persist({ ...record, operation: { ...record.operation, targetId, resultId } });
  const query = { search: targetId, action: "", status: "", offset: 0 };
  expect((await store.read(query)).entries[0]).toMatchObject({ targetId, resultId });
  await writeFile(
    join(directory, "actions-0.jsonl"),
    JSON.stringify({ timestamp: new Date().toISOString(), targetId: "token=secret" }) + "\n",
  );
  await expect(store.read(query)).rejects.toThrow("unavailable");
});

it("keeps legacy recovery events readable without an actor", async () => {
  const store = new ControlStore(directory);
  await atomicPrivate(directory, `operation-${record.operation.operationId}.json`, {
    operation: { status: "running" },
  });
  await store.recover();
  expect(
    (await store.read({ search: "", action: "", status: "", offset: 0 })).entries[0],
  ).toMatchObject({ actorId: "unknown", status: "indeterminate", reason: "recovery" });
});
