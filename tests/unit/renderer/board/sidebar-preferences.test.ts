// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import {
  createPreferencesStore,
  emptyPreferences,
  readPreferences,
  renameSession,
  pruneExpansion,
  writePreferences,
} from "../../../../src/renderer/board/sidebar-preferences";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

const entry = (field: string, id: string) => `foom.sidebar.v2.${JSON.stringify([field, id])}`;
function external(key: string | null, storageArea: Storage = localStorage) {
  window.dispatchEvent(new StorageEvent("storage", { key, storageArea, newValue: '"stale"' }));
}

test("stale snapshots merge only edited keys, including independent pins and resets", () => {
  localStorage.setItem(
    "foom.sidebar.v1",
    JSON.stringify({
      pins: ["old"],
      expanded: { old: true },
      names: { old: "Legacy" },
    }),
  );
  const a = readPreferences(localStorage);
  const b = readPreferences(localStorage);
  writePreferences(
    localStorage,
    { ...a, pins: [...a.pins, "a"], names: { ...a.names, a: "Newest" } },
    a,
  );
  writePreferences(
    localStorage,
    { ...b, pins: [...b.pins, "b"], expanded: { ...b.expanded, b: false } },
    b,
  );
  expect(readPreferences(localStorage)).toEqual({
    pins: ["old", "a", "b"],
    expanded: { old: true },
    names: { old: "Legacy", a: "Newest" },
  });
  writePreferences(localStorage, { pins: [], expanded: {}, names: {} }, b);
  expect(readPreferences(localStorage)).toEqual({
    pins: ["a", "b"],
    expanded: { old: true },
    names: { a: "Newest" },
  });
  const current = readPreferences(localStorage);
  writePreferences(localStorage, renameSession(current, "a", "Renamed"), current);
  writePreferences(localStorage, { ...a, expanded: { old: false } }, a);
  expect(readPreferences(localStorage).names["a"]).toBe("Renamed");
});

test("external store applies current outside changes, ignores unrelated events and disposes", () => {
  const store = createPreferencesStore(localStorage, window);
  const listener = vi.fn();
  const second = vi.fn();
  const remove = vi.spyOn(window, "removeEventListener");
  // A change before subscription must also be seen.
  writePreferences(localStorage, { ...emptyPreferences(), pins: ["a"] });
  const dispose = store.subscribe(listener);
  const disposeSecond = store.subscribe(second);
  expect(store.getSnapshot().pins).toEqual(["a"]);
  const before = store.getSnapshot();
  external("unrelated");
  external(entry("names", "a"), sessionStorage);
  external(entry("names", "a"));
  expect(store.getSnapshot()).toBe(before);
  expect(listener).toHaveBeenCalledTimes(1);
  writePreferences(localStorage, renameSession(before, "a", "Shared"), before);
  external(entry("names", "a"));
  expect(store.getSnapshot().names["a"]).toBe("Shared");
  expect(second).toHaveBeenCalledTimes(1);
  // Local saves notify too, retaining external changes even from a stale snapshot.
  store.save(before, { ...before, expanded: { a: false } });
  expect(store.getSnapshot()).toEqual({
    pins: ["a"],
    names: { a: "Shared" },
    expanded: {},
  });
  localStorage.clear();
  external(null);
  expect(store.getSnapshot()).toEqual(emptyPreferences());
  localStorage.setItem(
    "foom.sidebar.v1",
    JSON.stringify({ ...emptyPreferences(), names: { old: "Old" } }),
  );
  external("foom.sidebar.v1");
  expect(store.getSnapshot().names["old"]).toBe("Old");
  dispose();
  expect(remove).not.toHaveBeenCalled();
  disposeSecond();
  expect(remove).toHaveBeenCalledWith("storage", expect.any(Function));
  listener.mockClear();
  localStorage.clear();
  external(null);
  expect(listener).not.toHaveBeenCalled();
});

test("per-entry data is validated and unsafe property names remain inert metadata", () => {
  localStorage.setItem("unrelated", "ignore");
  localStorage.setItem("foom.sidebar.v2.broken", "true");
  for (const address of [[], ["pins"], ["pins", 4], ["pins", "a".repeat(4097)]]) {
    localStorage.setItem(`foom.sidebar.v2.${JSON.stringify(address)}`, "true");
  }
  for (const [field, value] of [
    ["pins", "yes"],
    ["expanded", 2],
    ["names", "a".repeat(121)],
    ["unknown", true],
  ]) {
    localStorage.setItem(entry(String(field), "bad"), JSON.stringify(value));
  }
  localStorage.setItem(entry("names", "broken"), "broken");
  localStorage.setItem(entry("names", "__proto__"), '"Inert"');
  localStorage.setItem(entry("expanded", "__proto__"), "true");
  localStorage.setItem(entry("pins", "valid"), "true");
  localStorage.setItem(entry("pins", "removed"), "false");
  localStorage.setItem(entry("names", "removed"), "null");
  localStorage.setItem(entry("expanded", "removed"), "null");
  expect(readPreferences(localStorage)).toEqual({
    pins: ["valid"],
    names: { ["__proto__"]: "Inert" },
    expanded: { ["__proto__"]: true },
  });
});

test("failed persistence propagates without advertising an unsaved snapshot", () => {
  const store = createPreferencesStore(localStorage, window);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw Error("full");
  });
  expect(() => {
    store.save(emptyPreferences(), renameSession(emptyPreferences(), "a", "Name"));
  }).toThrow("full");
  expect(store.getSnapshot()).toEqual(emptyPreferences());
});

test("expansion writes stay local and removed locations are pruned", () => {
  writePreferences(localStorage, { ...emptyPreferences(), expanded: { "repository:/a": false } });
  expect(readPreferences(localStorage).expanded).toEqual({});
  const expanded = {
    "repository:/a": false,
    "worktree:/a": true,
    "worktree:/gone": false,
    "repository:/gone": true,
  };
  const repositories = [
    {
      name: "a",
      path: "/a",
      worktrees: [
        {
          path: "/a",
          branch: "main",
          head: null,
          bare: false,
          locked: false,
          prunable: false,
          managed: false,
        },
      ],
    },
  ];
  const pruned = pruneExpansion(expanded, repositories);
  expect(pruned).toEqual({ "repository:/a": false, "worktree:/a": true });
  expect(pruneExpansion(pruned, repositories)).toBe(pruned);
  expect(pruneExpansion(pruned, [])).toEqual({});
  expect(pruneExpansion({ home: false }, [])).toEqual({ home: false });
});
