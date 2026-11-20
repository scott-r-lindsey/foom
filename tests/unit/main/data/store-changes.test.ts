import { HostObservations } from "../../../../src/main/data/host-observations";
import { settingsChanged } from "../../../../src/main/data/settings-changes";
import { DEFAULT_SETTINGS } from "../../../../src/main/setup/settings";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { viewChanges, ViewChanges } from "../../../../src/main/data/view-changes";
import { SettingsStore } from "../../../../src/main/setup/settings";
import { EnvironmentStore } from "../../../../src/main/setup/environment";
import { WorktreeStore } from "../../../../src/main/workspace/worktree-store";
import { SessionStore } from "../../../../src/main/workspace/session-store";
const roots: string[] = [];
const disposers: (() => void)[] = [];
afterEach(async () => {
  for (const off of disposers.splice(0)) off();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root() {
  const path = await mkdtemp(join(tmpdir(), "foom-view-writes-"));
  roots.push(path);
  return path;
}
test("the shared publication clock is monotonic across durable and live views and releases observers", () => {
  const changes = new ViewChanges();
  const observer = vi.fn();
  const off = changes.subscribe(observer);
  changes.publish("settings", "hosts");
  changes.publish("agents");
  expect(observer.mock.calls).toEqual([
    [new Set(["settings", "hosts"]), 1],
    [new Set(["agents"]), 2],
  ]);
  off();
  changes.publish("sessions");
  expect(observer).toHaveBeenCalledTimes(2);
  expect(changes.revision).toBe(3);
});
test("every Settings write boundary publishes only after successful persistence", async () => {
  const directory = await root();
  const store = await SettingsStore.open(directory);
  const changed = vi.fn();
  disposers.push(viewChanges.subscribe(changed));
  const published = async (write: () => unknown) => {
    changed.mockClear();
    await write();
    expect(changed).toHaveBeenCalled();
    expect(changed.mock.calls.at(-1)?.[0]).toContain("settings");
  };
  await published(() => store.update({ hooks: false }));
  await published(() => store.setThemeDigest("themes/example.json", "a".repeat(64)));
  await published(() =>
    store.attachConfig(
      (patch) => {
        store.setConfig(patch);
        return Promise.resolve();
      },
      {},
      null,
    ),
  );
  changed.mockClear();
  store.setConfig({ hooks: false });
  expect(changed).toHaveBeenCalledWith(new Set(["settings", "agents"]), expect.any(Number));
  await store.update({ hooks: false });
  expect(store.get().hooks).toBe(false);
  changed.mockClear();
  await rm(join(directory, "settings.json"));
  await mkdir(join(directory, "settings.json"));
  await expect(store.update({ setupComplete: true })).rejects.toThrow();
  expect(changed).not.toHaveBeenCalled();
  expect(store.get().setupComplete).toBe(false);
});
test("Environment save, removal and import share one commit publication with masked projections", async () => {
  const cipher = {
    supported: () => true,
    available: () => true,
    encrypt: (value: string) => Buffer.from(value),
    decrypt: (value: Buffer) => value.toString(),
  };
  const store = await EnvironmentStore.open(await root(), cipher, {
    read: () => Promise.resolve({ NO_PROXY: ".example" }),
  });
  const changed = vi.fn();
  disposers.push(viewChanges.subscribe(changed));
  await store.save({ scope: "all", previous: null, name: "TOKEN", value: "private", secret: true });
  expect(store.state().lists.all[0]?.value).toBeNull();
  await store.remove("all", "TOKEN");
  await store.readShell();
  await store.import(["NO_PROXY"]);
  expect(changed).toHaveBeenCalledTimes(3);
  for (const call of changed.mock.calls) expect(call[0]).toEqual(new Set(["environment"]));
  changed.mockClear();
  await expect(store.save({ scope: "all", name: "PATH" })).rejects.toThrow();
  expect(changed).not.toHaveBeenCalled();
});
test("repository/worktree and session stores publish their dependent views at commit", async () => {
  const directory = await root();
  const changed = vi.fn();
  disposers.push(viewChanges.subscribe(changed));
  const commit = vi.fn();
  await new WorktreeStore(join(directory, "worktrees.json")).save(
    () => ({ version: 1, repositories: [], managed: [] }),
    commit,
  );
  expect(commit).toHaveBeenCalledOnce();
  expect(changed).toHaveBeenCalledWith(
    new Set(["repositories", "worktrees", "hosts"]),
    expect.any(Number),
  );
  await new SessionStore(directory).save([]);
  expect(changed).toHaveBeenLastCalledWith(new Set(["sessions"]), expect.any(Number));
});

test("live host cache additions, replacement, removals and clears publish dependent views", () => {
  const changed = vi.fn();
  disposers.push(viewChanges.subscribe(changed));
  const cache = new HostObservations<string, number>();
  cache.clear();
  expect(cache.delete("missing")).toBe(false);
  cache.set("one", 1).set("one", 1).set("one", 2);
  expect(changed).toHaveBeenCalledTimes(2);
  expect(cache.delete("one")).toBe(true);
  cache.set("two", 2);
  cache.clear();
  expect(changed).toHaveBeenCalledTimes(5);
  for (const call of changed.mock.calls) expect(call[0]).toEqual(new Set(["hosts", "agents"]));
});
test("Settings dependencies target host/agent/readiness views and ignore unrelated field changes", () => {
  const changed = vi.fn();
  disposers.push(viewChanges.subscribe(changed));
  settingsChanged(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, interfaceScale: 110 });
  expect(changed).toHaveBeenLastCalledWith(new Set(["settings"]), expect.any(Number));
  settingsChanged(DEFAULT_SETTINGS, {
    ...DEFAULT_SETTINGS,
    registeredHosts: [{ host: "worker", codeFolder: "/code" }],
  });
  expect(changed).toHaveBeenLastCalledWith(
    new Set(["settings", "hosts", "agents"]),
    expect.any(Number),
  );
  settingsChanged(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, forges: { github: false } });
  expect(changed).toHaveBeenLastCalledWith(new Set(["settings", "readiness"]), expect.any(Number));
});

test("worktree metadata commits retain the repository revision, including after reopening the store", async () => {
  const directory = await root();
  const file = join(directory, "worktrees.json");
  const state = { version: 1 as const, repositories: [directory], managed: [] };
  const store = new WorktreeStore(file);
  await store.save(() => state);
  const revision = viewChanges.current("repositories");
  const changed = vi.fn();
  disposers.push(viewChanges.subscribe(changed));
  await store.save(() => state);
  expect(changed).toHaveBeenLastCalledWith(new Set(["worktrees"]), expect.any(Number));
  const reopened = new WorktreeStore(file);
  await reopened.read();
  await reopened.save(() => state);
  expect(viewChanges.current("repositories")).toBe(revision);
  await reopened.save(() => ({ ...state, repositories: [] }));
  expect(viewChanges.current("repositories")).toBeGreaterThan(revision);
});

test("the approved config copy, its digest and selected palette publish as one profile write", async () => {
  const directory = await root();
  const store = await SettingsStore.open(directory);
  await store.attachConfig(async () => {}, {}, null);
  const file = "themes/example.json";
  const publications: (string | null)[][] = [];
  disposers.push(
    viewChanges.subscribe(() => {
      publications.push([store.configDigest(), store.configText(), store.themeDigest(file)]);
    }),
  );
  const digest = "b".repeat(64);
  const text = '{"kind":"settings","interfaceTheme":"user:example.json"}';
  const themeDigest = "c".repeat(64);
  await store.setConfigBaseline(digest, text, { file, digest: themeDigest });
  expect(publications).toEqual([[digest, text, themeDigest]]);
  const restarted = await SettingsStore.open(directory);
  expect(restarted.configDigest()).toBe(digest);
  expect(restarted.configText()).toBe(text);
  expect(restarted.themeDigest(file)).toBe(themeDigest);
});
