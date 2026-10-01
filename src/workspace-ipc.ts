import { dialog, ipcMain } from "electron";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { AgentId } from "./shared/agents";
import type { VerdictAction } from "./shared/evaluator";
import type { LaunchRequest, TerminalState } from "./shared/workspace";
import type { Workspace } from "./workspace";

const APP_URL = "app://bundle/index.html";
const agents: readonly AgentId[] = ["claude", "codex", "agy"];
const actions: readonly VerdictAction[] = ["replied", "dismissed", "ignored"];

function text(value: unknown, max = 4096): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0")
  );
}
function dimension(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 2 && value <= max;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function agent(value: unknown): value is AgentId {
  return agents.some((id) => id === value);
}
function action(value: unknown): value is VerdictAction {
  return actions.some((name) => name === value);
}
function launchRequest(value: unknown): LaunchRequest {
  if (!record(value)) throw new Error("Invalid launch request");
  const { agent: id, repository, worktree, cols, rows } = value;
  const acknowledge = value["acknowledgeCodexNotifierReplacement"];
  if (
    !agent(id) ||
    !text(repository) ||
    !text(worktree) ||
    !dimension(cols, 500) ||
    !dimension(rows, 300) ||
    (acknowledge !== undefined && typeof acknowledge !== "boolean")
  )
    throw new Error("Invalid launch request");
  // Copy known fields only; nothing else in the payload reaches the launcher.
  return {
    agent: id,
    repository,
    worktree,
    cols,
    rows,
    ...(acknowledge === undefined ? {} : { acknowledgeCodexNotifierReplacement: acknowledge }),
  };
}

/**
 * Renderer access to the workspace. The renderer names repositories, worktrees and
 * agents by values main gave it; main resolves executables and picks new paths itself.
 */
export function attachWorkspace(
  window: BrowserWindow,
  workspace: Workspace,
  owns: (id: string) => boolean,
): { sendState(state: TerminalState): void; sendChanged(): void; dispose(): void } {
  const contents = window.webContents;
  const trusted = (event: IpcMainInvokeEvent) =>
    event.sender === contents &&
    event.senderFrame !== null &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame.url === APP_URL;
  const handlers = new Map<string, (...args: unknown[]) => unknown>([
    [
      "workspace:start",
      (request) => {
        if (
          !record(request) ||
          !text(request["repository"]) ||
          !text(request["branch"], 255) ||
          !(request["run"] === "shell" || agent(request["run"])) ||
          typeof request["acknowledgeCodexNotifierReplacement"] !== "boolean"
        )
          throw new Error("Invalid worktree launch");
        return workspace.startWorktree({
          repository: request["repository"],
          branch: request["branch"],
          run: request["run"],
          acknowledgeCodexNotifierReplacement: request["acknowledgeCodexNotifierReplacement"],
        });
      },
    ],
    [
      "workspace:remove",
      (id) => {
        if (!text(id)) throw new Error("Invalid terminal ID");
        return workspace.removeWorktree(id, async (branch, changes) => {
          const result = await dialog.showMessageBox(window, {
            type: "warning",
            title: "Remove worktree",
            message: `Remove ${branch}?`,
            detail: changes
              ? `Stop its terminals and permanently discard these uncommitted changes:\n${changes.split("\0").join("\n")}`
              : "Stop its terminals and remove the worktree folder. The branch is kept.",
            buttons: ["Cancel", changes ? "Discard changes and remove" : "Remove worktree"],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          });
          return result.response === 1;
        });
      },
    ],
    ["workspace:snapshot", () => workspace.snapshot()],
    [
      "workspace:add-repository",
      async () => {
        const result = await dialog.showOpenDialog(window, {
          title: "Add a repository",
          properties: ["openDirectory"],
        });
        const path = result.filePaths[0];
        if (result.canceled || !path) return null;
        return workspace.addRepository(path);
      },
    ],
    [
      "workspace:worktrees",
      (repository) => {
        if (!text(repository)) throw new Error("Invalid repository");
        return workspace.worktrees(repository);
      },
    ],
    [
      "workspace:create-worktree",
      (repository, branch, location) => {
        if (
          !text(repository) ||
          !text(branch, 255) ||
          (location !== "root" && location !== "adjacent")
        )
          throw new Error("Invalid worktree request");
        return workspace.createWorktree(repository, branch, location);
      },
    ],
    [
      "agents:scan",
      (refresh) => {
        if (typeof refresh !== "boolean") throw new Error("Invalid scan request");
        return workspace.scanAgents(refresh);
      },
    ],
    ["agents:launch", (request) => workspace.launch(launchRequest(request))],
    [
      "terminal:feedback",
      async (id, verdictId, next) => {
        if (
          !text(id) ||
          !owns(id) ||
          !(verdictId === null || text(verdictId, 128)) ||
          !action(next)
        )
          throw new Error("Invalid feedback");
        await workspace.feedback(id, verdictId, next);
      },
    ],
  ]);
  for (const [channel, handler] of handlers)
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!trusted(event)) throw new Error("Untrusted IPC sender");
      return handler(...args);
    });
  return {
    sendChanged() {
      if (!contents.isDestroyed() && contents.mainFrame.url === APP_URL)
        contents.send("workspace:changed");
    },
    sendState(state) {
      if (contents.isDestroyed() || contents.mainFrame.url !== APP_URL || !owns(state.id)) return;
      contents.send("terminal:state", state);
    },
    dispose() {
      for (const channel of handlers.keys()) ipcMain.removeHandler(channel);
    },
  };
}
