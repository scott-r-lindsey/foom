import { repositoryKey, worktreeKey } from "./sidebar-model";
import type { SidebarPreferences, SidebarRepository } from "./sidebar.d";
const key = "foom.sidebar.v1";
export function emptyPreferences(): SidebarPreferences {
  return { pins: [], expanded: {}, names: {} };
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Local UI metadata never grants a path or terminal capability. Treat disk content as data. */
function readLegacyPreferences(storage: Pick<Storage, "getItem">): SidebarPreferences {
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? "null");
    if (
      !record(value) ||
      !Array.isArray(value["pins"]) ||
      !record(value["expanded"]) ||
      !record(value["names"])
    )
      return emptyPreferences();
    const pins = value["pins"].filter(
      (item): item is string => typeof item === "string" && item.length <= 4096,
    );
    const expanded = Object.fromEntries(
      Object.entries(value["expanded"]).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
      ),
    );
    const names = Object.fromEntries(
      Object.entries(value["names"]).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && entry[1].length <= 120,
      ),
    );
    return { pins: [...new Set(pins)], expanded, names };
  } catch {
    return emptyPreferences();
  }
}
const prefix = "foom.sidebar.v2.";
type PreferenceStorage = Pick<Storage, "getItem" | "setItem" | "key" | "length">;

/** Each metadata entry has its own atomic storage write; unrelated edits cannot collide. */
export function readPreferences(
  storage: Pick<Storage, "getItem" | "key" | "length">,
): SidebarPreferences {
  const legacy = readLegacyPreferences(storage);
  const pins = new Set(legacy.pins);
  const expanded = new Map(Object.entries(legacy.expanded));
  const names = new Map(Object.entries(legacy.names));
  for (let index = 0; index < storage.length; index++) {
    const entry = storage.key(index);
    if (!entry?.startsWith(prefix)) continue;
    try {
      const address: unknown = JSON.parse(entry.slice(prefix.length));
      if (
        !Array.isArray(address) ||
        address.length !== 2 ||
        typeof address[1] !== "string" ||
        address[1].length > 4096
      )
        continue;
      const id = address[1];
      const value: unknown = JSON.parse(storage.getItem(entry) ?? "null");
      if (address[0] === "pins" && typeof value === "boolean") {
        if (value) pins.add(id);
        else pins.delete(id);
      } else if (address[0] === "expanded" && (typeof value === "boolean" || value === null)) {
        if (value === null) expanded.delete(id);
        else expanded.set(id, value);
      } else if (
        address[0] === "names" &&
        (value === null || (typeof value === "string" && value.length <= 120))
      ) {
        if (value === null) names.delete(id);
        else names.set(id, value);
      }
    } catch {
      // Ignore malformed metadata without discarding other entries.
    }
  }
  return {
    pins: [...pins],
    expanded: Object.fromEntries(expanded),
    names: Object.fromEntries(names),
  };
}

/** Write only the user's delta, never fields copied from a potentially stale snapshot. */
export function writePreferences(
  storage: Pick<Storage, "setItem">,
  next: SidebarPreferences,
  previous: SidebarPreferences = emptyPreferences(),
): void {
  for (const field of ["pins", "names"] as const) {
    const before = new Map<string, boolean | string>(
      field === "pins" ? previous.pins.map((id) => [id, true]) : Object.entries(previous[field]),
    );
    const after = new Map<string, boolean | string>(
      field === "pins" ? next.pins.map((id) => [id, true]) : Object.entries(next[field]),
    );
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      if (before.get(id) === after.get(id)) continue;
      // Tombstones override legacy entries without mutating the legacy snapshot.
      storage.setItem(
        prefix + JSON.stringify([field, id]),
        JSON.stringify(after.get(id) ?? (field === "pins" ? false : null)),
      );
    }
  }
}

export function createPreferencesStore(storage: PreferenceStorage, events: Window) {
  let snapshot = readPreferences(storage);
  const listeners = new Set<() => void>();
  const refresh = () => {
    const next = readPreferences(storage);
    if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea !== storage) return;
    if (event.key === null || event.key === key || event.key.startsWith(prefix)) refresh();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      if (listeners.size === 0) events.addEventListener("storage", onStorage);
      listeners.add(listener);
      // Covers changes between render and subscription, including remounts.
      refresh();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) events.removeEventListener("storage", onStorage);
      };
    },
    save(previous: SidebarPreferences, next: SidebarPreferences) {
      writePreferences(storage, next, previous);
      refresh();
    },
  };
}
export function renameSession(
  preferences: SidebarPreferences,
  id: string,
  name: string,
): SidebarPreferences {
  const names = { ...preferences.names };
  const trimmed = name.trim().slice(0, 120);
  if (trimmed) names[id] = trimmed;
  else
    return {
      ...preferences,
      names: Object.fromEntries(Object.entries(names).filter(([key]) => key !== id)),
    };
  return { ...preferences, names };
}

/** Prune only after inventory is ready; retained session locations remain valid rows. */
export function pruneExpansion(
  expanded: Record<string, boolean>,
  repositories: readonly SidebarRepository[],
): Record<string, boolean> {
  const known = new Set(
    repositories.flatMap((repo) => [
      repositoryKey(repo.path),
      ...repo.worktrees.map((tree) => worktreeKey(tree.path)),
    ]),
  );
  const entries = Object.entries(expanded).filter(([key]) => key === "home" || known.has(key));
  return entries.length === Object.keys(expanded).length ? expanded : Object.fromEntries(entries);
}
