import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type { ConfirmationWindowApi, DialogRequest } from "../shared/confirmation";
let current: DialogRequest | null = null;
const listeners = new Set<(request: DialogRequest | null) => void>();
// Main authors this data; still reject malformed structured IPC before exposing it.
function structured(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = (entry: unknown): entry is Record<string, unknown> =>
    Boolean(entry) && typeof entry === "object";
  const strings = (entry: unknown): boolean =>
    Array.isArray(entry) && entry.every((item: unknown) => typeof item === "string");
  if ("cancel" in value && value.cancel !== "Not now") return false;
  for (const key of ["subject", "quiet", "note"] as const)
    if (record(value) && key in value && typeof value[key] !== "string") return false;
  if (
    "glyph" in value &&
    !["trash", "branch", "power", "orbit", "link", "shield", "bell"].includes(String(value.glyph))
  )
    return false;
  if ("arguments" in value && !strings(value.arguments)) return false;
  if (
    "sections" in value &&
    !(
      Array.isArray(value.sections) &&
      value.sections.every(
        (entry: unknown) =>
          record(entry) && typeof entry["label"] === "string" && strings(entry["items"]),
      )
    )
  )
    return false;
  if (
    "facts" in value &&
    !(
      Array.isArray(value.facts) &&
      value.facts.every(
        (entry: unknown) =>
          record(entry) &&
          typeof entry["label"] === "string" &&
          typeof entry["value"] === "string" &&
          (entry["mono"] === undefined || typeof entry["mono"] === "boolean"),
      )
    )
  )
    return false;
  if (
    "pairing" in value &&
    !(
      record(value.pairing) &&
      typeof value.pairing["code"] === "string" &&
      typeof value.pairing["expiresAt"] === "number" &&
      Number.isFinite(value.pairing["expiresAt"])
    )
  )
    return false;
  if ("cleanup" in value && record(value.cleanup)) {
    for (const key of ["checkingCount", "fetchedAt"] as const) {
      const field = value.cleanup[key];
      if (
        field !== undefined &&
        (typeof field !== "number" || !Number.isFinite(field) || field < 0)
      )
        return false;
    }
  }
  return true;
}
ipcRenderer.on("confirmation:render", (_event: IpcRendererEvent, request: DialogRequest | null) => {
  current = request === null || structured(request) ? request : null;
  for (const listener of listeners) listener(current);
});
const api: ConfirmationWindowApi = {
  render(callback) {
    listeners.add(callback);
    callback(current);
    return () => {
      listeners.delete(callback);
    };
  },
  size(value) {
    ipcRenderer.send("confirmation:size", value);
  },
  answer(id, accepted) {
    ipcRenderer.send("confirmation:answer", id, accepted);
  },
};
contextBridge.exposeInMainWorld("confirmation", api);
