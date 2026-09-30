import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type { DesktopApi, TerminalActivity } from "./shared/desktop";
import type { TerminalState } from "./shared/workspace";

const states = ["needs_input", "done", "failed", "quiet_ok", "working"];
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Main is trusted, but the renderer still receives only well-formed state. */
function terminalState(value: unknown): value is TerminalState {
  return (
    object(value) &&
    typeof value["id"] === "string" &&
    (value["verdictId"] === null || typeof value["verdictId"] === "string") &&
    states.includes(String(value["state"])) &&
    typeof value["reason"] === "string" &&
    typeof value["signal"] === "string" &&
    typeof value["confidence"] === "number" &&
    typeof value["timestamp"] === "number"
  );
}

const desktop: DesktopApi = {
  async create(cols, rows) {
    const reply: unknown = await ipcRenderer.invoke("terminal:create", cols, rows);
    if (
      typeof reply !== "object" ||
      reply === null ||
      !("id" in reply) ||
      typeof reply.id !== "string" ||
      !("title" in reply) ||
      typeof reply.title !== "string"
    )
      throw new Error("Invalid terminal response");
    return { id: reply.id, title: reply.title };
  },
  async attach(id) {
    await ipcRenderer.invoke("terminal:attach", id);
  },
  async detach(id) {
    await ipcRenderer.invoke("terminal:detach", id);
  },
  async kill(id) {
    await ipcRenderer.invoke("terminal:kill", id);
  },
  input(id, data) {
    for (let offset = 0; offset < data.length; ) {
      let end = Math.min(offset + 65536, data.length);
      // IPC limits use UTF-16 code units. Keep a surrogate pair in the same write.
      const before = data.charCodeAt(end - 1);
      const after = data.charCodeAt(end);
      if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
        end -= 1;
      }
      ipcRenderer.send("terminal:input", id, data.slice(offset, end));
      offset = end;
    }
  },
  resize: (id, cols, rows) => {
    ipcRenderer.send("terminal:resize", id, cols, rows);
  },
  acknowledge: (id, token, count) => {
    ipcRenderer.send("terminal:ack", id, token, count);
  },
  async tail(id, lines) {
    const reply: unknown = await ipcRenderer.invoke("terminal:tail", id, lines);
    if (
      !Array.isArray(reply) ||
      reply.length > 10000 ||
      !reply.every((line: unknown) => typeof line === "string")
    )
      throw new Error("Invalid terminal tail");
    return reply;
  },
  onActivity(callback) {
    const listener = (_event: IpcRendererEvent, batch: unknown) => {
      if (!Array.isArray(batch)) return;
      const entries: TerminalActivity[] = [];
      const values: unknown[] = batch;
      for (const entry of values) {
        if (
          typeof entry !== "object" ||
          entry === null ||
          !("id" in entry) ||
          typeof entry.id !== "string" ||
          !entry.id ||
          !("rate" in entry) ||
          typeof entry.rate !== "number" ||
          !Number.isFinite(entry.rate) ||
          entry.rate < 0
        )
          return;
        entries.push({ id: entry.id, rate: entry.rate });
      }
      callback(entries);
    };
    ipcRenderer.on("terminal:activity", listener);
    return () => ipcRenderer.removeListener("terminal:activity", listener);
  },
  workspace: () => ipcRenderer.invoke("workspace:snapshot"),
  addRepository: () => ipcRenderer.invoke("workspace:add-repository"),
  worktrees: (repository) => ipcRenderer.invoke("workspace:worktrees", repository),
  createWorktree: (repository, branch, location) =>
    ipcRenderer.invoke("workspace:create-worktree", repository, branch, location),
  scanAgents: (refresh) => ipcRenderer.invoke("agents:scan", refresh),
  launchAgent: (request) => ipcRenderer.invoke("agents:launch", request),
  setupState: () => ipcRenderer.invoke("setup:state"),
  saveSetup: (patch) => ipcRenderer.invoke("setup:save", patch),
  setInferenceKey: (provider, key) => ipcRenderer.invoke("setup:set-key", provider, key),
  removeInferenceKey: (provider) => ipcRenderer.invoke("setup:remove-key", provider),
  checkInference: (config) => ipcRenderer.invoke("setup:check", config),
  async feedback(id, verdictId, action) {
    await ipcRenderer.invoke("terminal:feedback", id, verdictId, action);
  },
  onState(callback) {
    const listener = (_event: IpcRendererEvent, state: unknown) => {
      if (terminalState(state)) callback(state);
    };
    ipcRenderer.on("terminal:state", listener);
    return () => {
      ipcRenderer.removeListener("terminal:state", listener);
    };
  },
  onData(callback) {
    const listener = (_event: IpcRendererEvent, id: unknown, token: unknown, data: unknown) => {
      if (typeof id === "string" && typeof token === "string" && typeof data === "string")
        callback(id, token, data);
    };
    ipcRenderer.on("terminal:data", listener);
    return () => {
      ipcRenderer.removeListener("terminal:data", listener);
    };
  },
  onExit(callback) {
    const listener = (_event: IpcRendererEvent, id: unknown, code: unknown) => {
      if (typeof id === "string" && typeof code === "number" && Number.isInteger(code))
        callback(id, code);
    };
    ipcRenderer.on("terminal:exit", listener);
    return () => {
      ipcRenderer.removeListener("terminal:exit", listener);
    };
  },
};
contextBridge.exposeInMainWorld("desktop", desktop);
