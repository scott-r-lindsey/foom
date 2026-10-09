import type { WindowView, WindowAudioState } from "../shared/windows";
import type { ExecutionTransition } from "../shared/execution";
import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type { DesktopApi, TerminalActivity } from "../shared/desktop";
import type { ProbeUpdate } from "../shared/inference";
import type { SetupState } from "../shared/setup";
import type { TerminalState } from "../shared/workspace";

const states = ["needs_input", "done", "failed", "quiet_ok", "working", "checking"];
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
    typeof value["timestamp"] === "number" &&
    (value["execution"] === undefined || executionSnapshot(value["execution"]))
  );
}

function executionSnapshot(value: unknown): boolean {
  return (
    object(value) &&
    typeof value["terminalId"] === "string" &&
    value["terminalId"].length > 0 &&
    value["terminalId"].length <= 200 &&
    ["starting", "idle", "working", "blocked", "exited"].includes(String(value["phase"])) &&
    ["launch", "revision", "turn"].every(
      (key) =>
        typeof value[key] === "number" && Number.isSafeInteger(value[key]) && value[key] >= 0,
    )
  );
}

function executionTransition(value: unknown): value is ExecutionTransition {
  if (!object(value) || !executionSnapshot(value)) return false;
  return (
    ["launch", "hook", "title", "screen", "exit"].includes(String(value["source"])) &&
    ["starting", "idle", "working", "blocked", "exited"].includes(String(value["from"])) &&
    value["phase"] === value["to"] &&
    value["from"] !== value["to"] &&
    typeof value["at"] === "number" &&
    Number.isFinite(value["at"])
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

// Main sends this after availability notifications. Reply after the current
// renderer turn, behind any already-sent view IPC, even when no view is mounted.
ipcRenderer.on("terminal:flush-views", (_event, ids: unknown, token: unknown) => {
  if (
    !Array.isArray(ids) ||
    !ids.every((id: unknown) => typeof id === "string") ||
    typeof token !== "number" ||
    !Number.isSafeInteger(token) ||
    token <= 0
  )
    return;
  queueMicrotask(() => {
    ipcRenderer.send("terminal:views-flushed", ids, token);
  });
});

function windowViews(value: unknown): value is WindowView[] {
  return (
    Array.isArray(value) &&
    value.length <= 8192 &&
    value.every(
      (item: unknown) =>
        object(item) &&
        typeof item["id"] === "string" &&
        item["id"].length <= 200 &&
        typeof item["window"] === "number" &&
        Number.isSafeInteger(item["window"]),
    )
  );
}
function audioState(value: unknown): value is WindowAudioState {
  return (
    object(value) &&
    typeof value["enabled"] === "boolean" &&
    (value["focusedId"] === null ||
      (typeof value["focusedId"] === "string" && value["focusedId"].length <= 200))
  );
}
const windowArgument = (name: string) =>
  process.argv.find((arg) => arg.startsWith(`--foom-${name}=`))?.split("=")[1];
const desktop: DesktopApi = {
  windows: {
    audio: {
      state: async () => {
        const value: unknown = await ipcRenderer.invoke("windows:audio-state");
        return audioState(value) ? value : { enabled: false, focusedId: null };
      },
      focus: (id) => ipcRenderer.invoke("windows:audio-focus", id),
      refuse: () => ipcRenderer.invoke("windows:refuse"),
      onChanged: (callback) => {
        const listener = (_event: IpcRendererEvent, value: unknown) => {
          if (audioState(value)) callback(value);
        };
        ipcRenderer.on("windows:audio", listener);
        return () => {
          ipcRenderer.removeListener("windows:audio", listener);
        };
      },
      onRefuse: (callback) => {
        const listener = () => {
          callback();
        };
        ipcRenderer.on("windows:refuse", listener);
        return () => {
          ipcRenderer.removeListener("windows:refuse", listener);
        };
      },
    },
    id: windowArgument("window-id") ?? "main",
    number: Number(windowArgument("window-number") ?? 0),
    initialSession: windowArgument("initial-session"),
    sync: (ids) => ipcRenderer.invoke("windows:sync", ids),
    select: (id) => ipcRenderer.invoke("windows:select", id),
    popout: (id) => ipcRenderer.invoke("windows:popout", id),
    snapshot: async () => {
      const value: unknown = await ipcRenderer.invoke("windows:views");
      return windowViews(value) ? value : [];
    },
    onChanged: (callback) => {
      const listener = (_event: IpcRendererEvent, value: unknown) => {
        if (windowViews(value)) callback(value);
      };
      ipcRenderer.on("windows:changed", listener);
      return () => {
        ipcRenderer.removeListener("windows:changed", listener);
      };
    },
    onRemoved: (callback) => {
      const listener = (_event: IpcRendererEvent, id: unknown) => {
        if (typeof id === "string" && id.length > 0 && id.length <= 200) callback(id);
      };
      ipcRenderer.on("windows:removed", listener);
      return () => {
        ipcRenderer.removeListener("windows:removed", listener);
      };
    },
  },
  sounds: {
    onChange(callback) {
      const listener = () => {
        callback();
      };
      ipcRenderer.on("sound:changed", listener);
      return () => {
        ipcRenderer.removeListener("sound:changed", listener);
      };
    },
    list: () => ipcRenderer.invoke("sound:list"),
    read: (request) => ipcRenderer.invoke("sound:read", request),
    openFolder: () => ipcRenderer.invoke("sound:open-folder"),
    notices: () => ipcRenderer.invoke("sound:notices"),
  },
  confirmations: {
    onDialog(callback) {
      const listener = () => {
        callback();
      };
      ipcRenderer.on("confirmation:dialog", listener);
      return () => {
        ipcRenderer.removeListener("confirmation:dialog", listener);
      };
    },
    subscribe(callback) {
      const listener = (_event: IpcRendererEvent, value: unknown, accepted: unknown) => {
        if (value === null) callback(null, accepted === true);
        else if (
          object(value) &&
          typeof value["nonce"] === "string" &&
          typeof value["target"] === "string" &&
          typeof value["label"] === "string"
        )
          callback({ nonce: value["nonce"], target: value["target"], label: value["label"] });
      };
      ipcRenderer.on("confirmation:armed", listener);
      return () => {
        ipcRenderer.removeListener("confirmation:armed", listener);
      };
    },
    confirm: (arm) => ipcRenderer.invoke("confirmation:confirm", arm.nonce, arm.target),
    cancel: () => ipcRenderer.invoke("confirmation:cancel"),
  },
  isDevelopment: process.argv.includes("--foom-development"),
  appMenu: {
    platform: process.platform,
    setView: (state) => ipcRenderer.invoke("app-menu:view", state),
    commands: () => ipcRenderer.invoke("app-menu:list"),
    execute: (id) => ipcRenderer.invoke("app-menu:execute", id),
    onOpen(callback) {
      const listener = () => {
        callback();
      };
      ipcRenderer.on("app-menu:open", listener);
      return () => {
        ipcRenderer.removeListener("app-menu:open", listener);
      };
    },
    onSession(callback) {
      const listener = (_event: IpcRendererEvent, id: unknown) => {
        if (typeof id === "string" && id.length > 0 && id.length <= 256) callback(id);
      };
      ipcRenderer.on("app-menu:session", listener);
      return () => {
        ipcRenderer.removeListener("app-menu:session", listener);
      };
    },
  },
  onBoardCommand(callback) {
    const listener = (_event: IpcRendererEvent, command: unknown) => {
      if (
        command === "sidebar" ||
        command === "next-waiting" ||
        command === "settings" ||
        command === "new-worktree" ||
        command === "preset-one" ||
        command === "preset-columns" ||
        command === "preset-rows" ||
        command === "preset-grid" ||
        command === "preset-main2" ||
        command === "preset-main3" ||
        command === "maximize" ||
        command === "left" ||
        command === "right" ||
        command === "up" ||
        command === "down" ||
        command === "split-right" ||
        command === "split-down" ||
        command === "close-tile" ||
        command === "hide-session" ||
        command === "swap-left" ||
        command === "swap-right" ||
        command === "swap-up" ||
        command === "swap-down" ||
        command === "tile-1" ||
        command === "tile-2" ||
        command === "tile-3" ||
        command === "tile-4" ||
        command === "tile-5" ||
        command === "tile-6" ||
        command === "tile-7" ||
        command === "tile-8" ||
        command === "tile-9"
      )
        callback(command);
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
  input(id, data, origin) {
    for (let offset = 0; offset < data.length; ) {
      let end = Math.min(offset + 65536, data.length);
      // IPC limits use UTF-16 code units. Keep a surrogate pair in the same write.
      const before = data.charCodeAt(end - 1);
      const after = data.charCodeAt(end);
      if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
        end -= 1;
      }
      if (origin === undefined) ipcRenderer.send("terminal:input", id, data.slice(offset, end));
      else ipcRenderer.send("terminal:input", id, data.slice(offset, end), origin);
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
  panelFacts: (repository, worktree) =>
    ipcRenderer.invoke("workspace:panel-facts", repository, worktree),
  sidebarInventory: () => ipcRenderer.invoke("workspace:sidebar"),
  sidebarCommand: (command) => ipcRenderer.invoke("workspace:sidebar-command", command),
  workspace: () => ipcRenderer.invoke("workspace:snapshot"),
  addRepository: () => ipcRenderer.invoke("workspace:add-repository"),
  worktrees: (repository) => ipcRenderer.invoke("workspace:worktrees", repository),
  createWorktree: (repository, branch, location) =>
    ipcRenderer.invoke("workspace:create-worktree", repository, branch, location),
  changeAgyPlugin: (action) => ipcRenderer.invoke("agents:agy-plugin", action),
  scanAgents: (refresh) => ipcRenderer.invoke("agents:scan", refresh),
  launchAgent: (request) => ipcRenderer.invoke("agents:launch", request),
  listThemes: () => ipcRenderer.invoke("theme:list"),
  openThemesFolder: (kind) => ipcRenderer.invoke("theme:open-folder", kind),
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
  onExecution(callback) {
    const listener = (_event: IpcRendererEvent, event: unknown) => {
      if (executionTransition(event)) callback(event);
    };
    ipcRenderer.on("agent:execution", listener);
    return () => {
      ipcRenderer.removeListener("agent:execution", listener);
    };
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
  onTerminalAvailability(callback) {
    const listener = (
      _event: IpcRendererEvent,
      ids: unknown,
      available: unknown,
      reset?: unknown,
    ) => {
      if (!Array.isArray(ids) || typeof available !== "boolean") return;
      const values: unknown[] = ids;
      if (!values.every((id) => typeof id === "string" && id.length > 0 && id.length <= 200))
        return;
      for (const id of values)
        if (typeof id === "string") {
          if (reset === true) callback(id, available, true);
          else callback(id, available);
        }
    };
    ipcRenderer.on("terminal:availability", listener);
    return () => {
      ipcRenderer.removeListener("terminal:availability", listener);
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
