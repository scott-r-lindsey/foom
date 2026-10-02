import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type { DesktopApi, TerminalActivity } from "../shared/desktop";
import type { ProbeUpdate } from "../shared/inference";
import type { SetupState } from "../shared/setup";
import type { TerminalState } from "../shared/workspace";

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

const steps = ["key", "connect", "server", "model", "load", "request", "reply", "parse"];
const statuses = ["running", "ok", "failed", "skipped"];
function probeUpdate(value: unknown): value is ProbeUpdate {
  if (!object(value)) return false;
  if (value["kind"] === "stream")
    return typeof value["thinking"] === "number" && typeof value["reply"] === "string";
  const event = value["event"];
  return (
    value["kind"] === "step" &&
    object(event) &&
    steps.includes(String(event["step"])) &&
    statuses.includes(String(event["status"])) &&
    typeof event["label"] === "string" &&
    typeof event["atMs"] === "number" &&
    (event["durationMs"] === undefined || typeof event["durationMs"] === "number")
  );
}

function setupState(value: unknown): value is SetupState {
  return (
    object(value) &&
    object(value["settings"]) &&
    object(value["keys"]) &&
    typeof value["secureStorage"] === "boolean" &&
    typeof value["worktreeRoot"] === "string"
  );
}

const desktop: DesktopApi = {
  onBoardCommand(callback) {
    const listener = (_event: IpcRendererEvent, command: unknown) => {
      if (command === "sidebar" || command === "next-waiting") callback(command);
    };
    ipcRenderer.on("board:command", listener);
    return () => {
      ipcRenderer.removeListener("board:command", listener);
    };
  },
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
  onWorkspaceChange(callback) {
    const listener = () => {
      callback();
    };
    ipcRenderer.on("workspace:changed", listener);
    return () => {
      ipcRenderer.removeListener("workspace:changed", listener);
    };
  },
  startWorktree: (request) => ipcRenderer.invoke("workspace:start", request),
  removeWorktree: (id) => ipcRenderer.invoke("workspace:remove", id),
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
  checkInference(id, config, timeoutMs, onUpdate) {
    const listener = (_event: IpcRendererEvent, check: unknown, update: unknown) => {
      if (check === id && probeUpdate(update)) onUpdate(update);
    };
    ipcRenderer.on("setup:check-progress", listener);
    return ipcRenderer.invoke("setup:check", id, config, timeoutMs).finally(() => {
      ipcRenderer.removeListener("setup:check-progress", listener);
    });
  },
  async cancelInferenceCheck(id) {
    await ipcRenderer.invoke("setup:check-cancel", id);
  },
  localModels: (endpoint) => ipcRenderer.invoke("setup:models", endpoint),
  codeSuggestions: () => ipcRenderer.invoke("setup:code-suggestions"),
  scanCode(id, folder, onProgress) {
    const listener = (_event: IpcRendererEvent, scan: unknown, progress: unknown) => {
      if (
        scan === id &&
        object(progress) &&
        typeof progress["folders"] === "number" &&
        typeof progress["repositories"] === "number"
      )
        onProgress({ folders: progress["folders"], repositories: progress["repositories"] });
    };
    ipcRenderer.on("setup:scan-progress", listener);
    return ipcRenderer.invoke("setup:scan-code", id, folder).finally(() => {
      ipcRenderer.removeListener("setup:scan-progress", listener);
    });
  },
  applyRepositories: (selected) => ipcRenderer.invoke("setup:apply-repositories", selected),
  onSetupChange(callback) {
    const listener = (_event: IpcRendererEvent, state: unknown) => {
      if (setupState(state)) callback(state);
    };
    ipcRenderer.on("setup:changed", listener);
    return () => {
      ipcRenderer.removeListener("setup:changed", listener);
    };
  },
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
