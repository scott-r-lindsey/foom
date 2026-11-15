import { DEFAULT_SETTINGS } from "../../../../src/main/setup/settings";
import type { ViewReader } from "../../../../src/main/data/view-registry";
import { afterEach, expect, test, vi } from "vitest";
import { ViewChanges } from "../../../../src/main/data/view-changes";
import { MAX_VIEW_BYTES, ViewRegistry, viewRequest } from "../../../../src/main/data/view-registry";
import type { ViewSnapshot } from "../../../../src/shared/data-views";

const registries: ViewRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
});
function fixture(read = vi.fn(() => Promise.resolve([]))) {
  const changes = new ViewChanges();
  const registry = new ViewRegistry(changes, read);
  registries.push(registry);
  const send = vi.fn<(snapshot: ViewSnapshot) => void>();
  return { registry, changes, send, read };
}
const request = { id: "test", view: "repositories", params: {} };
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
test("validates the closed registry and bounded, view-specific parameters", () => {
  for (const input of [
    null,
    [],
    1,
    {},
    { ...request, id: "" },
    { ...request, id: "x".repeat(65) },
    { ...request, view: "sql" },
    { ...request, extra: true },
    { ...request, params: null },
    { ...request, params: new Date() },
    { id: "x".repeat(32768), view: "settings", params: {} },
    { other: "test", view: "settings", params: {} },
    { ...request, params: [] },
    { ...request, params: { repository: "/private" } },
    { ...request, params: { offset: -1 } },
    { ...request, params: { offset: 1000001 } },
    { ...request, params: { limit: 0 } },
    { ...request, params: { limit: 101 } },
    { ...request, params: { limit: NaN } },
    { ...request, view: "settings", params: { limit: 1 } },
    { ...request, view: "worktrees" },
    { ...request, view: "worktrees", params: { repository: "" } },
    { ...request, view: "worktrees", params: { repository: "a\0" } },
    { ...request, view: "agents", params: { machine: "unknown" } },
  ])
    expect(viewRequest(input)).toBe(false);
  for (const input of [
    request,
    { ...request, params: { offset: 0, limit: 100 } },
    { ...request, view: "worktrees", params: { repository: "/registered" } },
    { ...request, view: "agents", params: { machine: "local" } },
  ])
    expect(viewRequest(input)).toBe(true);
});
test("orders publications, targets affected views, and coalesces behind acknowledgement", async () => {
  const { registry, changes, send, read } = fixture();
  registry.subscribe(request, send);
  await flush();
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ generation: 1, revision: 0, data: [] }),
  );
  changes.publish("settings");
  changes.publish("repositories");
  changes.publish("repositories");
  await flush();
  expect(send).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledTimes(1);
  registry.acknowledge("test", 9, 0);
  registry.acknowledge("test", 1, 99);
  registry.acknowledge("gone", 1, 0);
  registry.acknowledge("test", 1, 0);
  await flush();
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 3 }));
  registry.unsubscribe("test");
  registry.subscribe(request, send);
  await flush();
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ generation: 2, revision: 3 }));
  expect(() => {
    registry.acknowledge(null, 1, 1);
  }).toThrow();
  expect(() => {
    registry.acknowledge("test", "1", 1);
  }).toThrow();
  expect(() => {
    registry.acknowledge("test", 1, NaN);
  }).toThrow();
  expect(() => {
    registry.unsubscribe({});
  }).toThrow();
  expect(() => {
    registry.unsubscribe("");
  }).toThrow();
});
test("a change racing the initial async snapshot repeats the read without delivering old data", async () => {
  let resolve: (data: never[]) => void = () => undefined;
  const read = vi.fn(
    () =>
      new Promise<never[]>((done) => {
        resolve = done;
      }),
  );
  const { registry, changes, send } = fixture(read);
  registry.subscribe(request, send);
  await flush();
  changes.publish("repositories");
  resolve([]);
  await flush();
  expect(send).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledTimes(2);
  resolve([]);
  await flush();
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ revision: 1 }));
  registry.acknowledge("test", 1, 1);
  changes.publish("repositories");
  await flush();
  registry.clear();
  resolve([]);
  await flush();
  expect(send).toHaveBeenCalledTimes(1);
});
test("enforces per-board limits, unique IDs and pagination", async () => {
  const changes = new ViewChanges();
  const registry = new ViewRegistry(changes, () => [
    { path: "/one", name: "one" },
    { path: "/two", name: "two" },
  ]);
  registries.push(registry);
  const send = vi.fn();
  registry.subscribe({ ...request, params: { offset: 1, limit: 1 } }, send);
  expect(() => {
    registry.subscribe(request, send);
  }).toThrow();
  expect(() => {
    registry.subscribe({}, send);
  }).toThrow();
  for (let n = 1; n < 32; n++)
    registry.subscribe({ ...request, id: `s${String(n)}` }, () => undefined);
  expect(() => {
    registry.subscribe({ ...request, id: "overflow" }, send);
  }).toThrow();
  await flush();
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ data: [{ path: "/two", name: "two" }] }),
  );
});
test("bounds failures and oversized snapshots without exposing exception content", async () => {
  const changes = new ViewChanges();
  const read = vi.fn<ViewReader>(() => Promise.reject(new Error("private content")));
  const registry = new ViewRegistry(changes, read);
  registries.push(registry);
  const send = vi.fn();
  registry.subscribe({ ...request, view: "settings" }, send);
  await flush();
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ error: "unavailable" }));
  read.mockImplementation(() =>
    Promise.resolve({
      worktreeRoot: "/root",
      settings: { ...DEFAULT_SETTINGS, codeFolder: "x".repeat(MAX_VIEW_BYTES) },
    }),
  );
  // The registry's boundary also handles structurally invalid owner projections.
  registry.acknowledge("test", 1, 0);
  changes.publish("settings");
  await flush();
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ error: "too-large" }));
  const invalid = new ViewRegistry(changes, () => ({
    worktreeRoot: "/root",
    settings: DEFAULT_SETTINGS,
  }));
  registries.push(invalid);
  invalid.subscribe(request, send);
  await flush();
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ error: "unavailable" }));
});

test("cyclic requests refuse and synchronous acknowledgements preserve a coalesced follow-up", async () => {
  const cycle: { id: string; view: string; params?: unknown } = { id: "cycle", view: "settings" };
  cycle.params = cycle;
  expect(viewRequest(cycle)).toBe(false);
  const { registry, changes, send } = fixture();
  registry.subscribe(request, (snapshot) => {
    send(snapshot);
    if (snapshot.revision === 0) {
      changes.publish("repositories");
      registry.acknowledge(snapshot.id, snapshot.generation, snapshot.revision);
    }
  });
  await flush();
  await flush();
  expect(send).toHaveBeenCalledTimes(2);
});
