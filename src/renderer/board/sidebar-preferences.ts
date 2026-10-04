import type { SidebarPreferences } from "./sidebar.d";
const key = "foom.sidebar.v1";
export function emptyPreferences(): SidebarPreferences {
  return { pins: [], expanded: {}, names: {} };
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Local UI metadata never grants a path or terminal capability. Treat disk content as data. */
export function readPreferences(storage: Pick<Storage, "getItem">): SidebarPreferences {
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
export function writePreferences(
  storage: Pick<Storage, "setItem">,
  preferences: SidebarPreferences,
): void {
  storage.setItem(key, JSON.stringify(preferences));
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
