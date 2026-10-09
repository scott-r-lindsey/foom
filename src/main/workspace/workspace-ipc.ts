import type { WindowIpc } from "../window/window-ipc";
import type { ExecutionTransition } from "../../shared/execution";
import { ConfirmationArming } from "../confirmations/arming";
import type { DialogContent, ConfirmWorkspace } from "../../shared/confirmation";
import { dialog, ipcMain } from "electron";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { AgentId } from "../../shared/agents";
import type { VerdictAction } from "../../shared/evaluator";
import type { LaunchRequest, TerminalState, SidebarCommand } from "../../shared/workspace";
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

function sidebarCommand(value: unknown): SidebarCommand {
  if (!record(value)) throw new Error("Invalid sidebar command");
  const kind = value["kind"];
  if (
    kind === "stop" ||
    kind === "close" ||
    kind === "restart" ||
    kind === "resume" ||
    kind === "new-conversation" ||
    kind === "copy-session-id"
  ) {
    if (!text(value["id"])) throw new Error("Invalid terminal ID");
    return { kind, id: value["id"] };
  }
  if (!text(value["repository"])) throw new Error("Invalid repository");
  const repository = value["repository"];
  if (kind === "remove-repository" || kind === "delete-merged-worktrees")
    return { kind, repository };
  if (!text(value["worktree"])) throw new Error("Invalid worktree");
  const worktree = value["worktree"];
  if (kind === "remove-worktree") return { kind, repository, worktree };
  if (kind === "launch" && (value["run"] === "shell" || agent(value["run"])))
    return { kind, repository, worktree, run: value["run"] };
  throw new Error("Invalid sidebar command");
}

/**
 * Renderer access to the workspace. The renderer names repositories, worktrees and
 * agents by values main gave it; main resolves executables and picks new paths itself.
 */
export function attachWorkspace(
  window: BrowserWindow,
  workspace: Workspace,
  owns: (id: string) => boolean,
  requestDialog: (content: DialogContent) => Promise<boolean>,
  ipc: WindowIpc = ipcMain,
): {
  sendExecution(event: ExecutionTransition): void;
  sendState(state: TerminalState): void;
  sendChanged(): void;
  dispose(): void;
} {
  const contents = window.webContents;
  const trusted = (event: IpcMainInvokeEvent) =>
    event.sender === contents &&
    event.senderFrame !== null &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame.url === APP_URL;
  const arming = new ConfirmationArming((arm, accepted) => {
    if (!contents.isDestroyed() && contents.mainFrame.url === APP_URL)
      contents.send("confirmation:armed", arm, accepted);
  });
  const labels = {
    remove: "Click again to remove",
    stop: "Click again to stop",
    "shared-agent": "Click again for two agents here",
    notifier: "Click again to replace notifier",
  } satisfies Record<
    Exclude<Parameters<ConfirmWorkspace>[0]["kind"], "dirty-worktree" | "merged-worktrees">,
    string
  >;
  const confirmation = (target: string): ConfirmWorkspace => {
    const generation = arming.begin();
    return (request): Promise<boolean> => {
      if (request.kind === "merged-worktrees") {
        if (contents.isDestroyed() || contents.mainFrame.url !== APP_URL)
          return Promise.resolve(false);
        contents.send("confirmation:dialog");
        return requestDialog({
          title: "Delete merged worktrees?",
          accept: "Delete",
          worktrees: request.worktrees,
        });
      }
      if (request.kind === "dirty-worktree") {
        const { title, changes } = request;
        const records = changes.split("\0");
        let count = 0;
        for (let index = 0; index < records.length; index++) {
          const status = records[index];
          if (!status) continue;
          count++;
          // Porcelain -z adds a second pathname for renames and copies.
          if (/[RC]/u.test(status.slice(0, 2))) index++;
        }
        if (contents.isDestroyed() || contents.mainFrame.url !== APP_URL)
          return Promise.resolve(false);
        contents.send("confirmation:dialog");
        return requestDialog({
          title,
          changes,
          accept: `Discard ${String(count)} ${count === 1 ? "change" : "changes"} and remove`,
        });
      }
      return arming.ask(generation, target, labels[request.kind]);
    };
  };
  const disarm = () => {
    arming.cancel();
  };
  contents.on("did-start-navigation", disarm);
  contents.on("render-process-gone", disarm);
  const handlers = new Map<string, (...args: unknown[]) => unknown>([
    [
      "confirmation:confirm",
      (nonce, target) => {
        arming.confirm(nonce, target);
      },
    ],
    ["confirmation:cancel", disarm],
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
        return workspace.startWorktree(
          {
            repository: request["repository"],
            branch: request["branch"],
            run: request["run"],
            acknowledgeCodexNotifierReplacement: request["acknowledgeCodexNotifierReplacement"],
          },
          confirmation(JSON.stringify(request)),
        );
      },
    ],
    [
      "workspace:remove",
      (id) => {
        if (!text(id)) throw new Error("Invalid terminal ID");
        if (!owns(id)) throw new Error("Unknown or foreign terminal ID");
        const confirm = confirmation(JSON.stringify(["remove", id]));
        return workspace.removeWorktree(id, (branch, changes) =>
          confirm(
            changes
              ? { kind: "dirty-worktree", title: `Remove ${branch}?`, changes }
              : { kind: "remove" },
          ),
        );
      },
    ],
    ["workspace:sidebar", () => workspace.sidebarInventory()],
    [
      "workspace:sidebar-command",
      (value) => {
        const command = sidebarCommand(value);
        if ("id" in command && !owns(command.id) && !workspace.ownsSession(command.id))
          throw new Error("Unknown or foreign terminal ID");
        return workspace.sidebarCommand(command, confirmation(JSON.stringify(command)));
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
    [
      "agents:agy-plugin",
      (...args) => {
        const [action] = args;
        if (
          args.length !== 1 ||
          (action !== "install" &&
            action !== "update" &&
            action !== "remove" &&
            action !== "enable")
        )
          throw new Error("Invalid plugin request");
        return workspace.changeAgyPlugin(action);
      },
    ],
    [
      "agents:launch",
      (request) => {
        const launch = launchRequest(request);
        return workspace.launch(launch, confirmation(JSON.stringify(launch)));
      },
    ],
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
    ipc.handle(channel, (event, ...args: unknown[]) => {
      if (!trusted(event)) throw new Error("Untrusted IPC sender");
      return handler(...args);
    });
  return {
    sendExecution(event) {
      if (!contents.isDestroyed() && contents.mainFrame.url === APP_URL && owns(event.terminalId))
        contents.send("agent:execution", event);
    },
    sendChanged() {
      if (!contents.isDestroyed() && contents.mainFrame.url === APP_URL)
        contents.send("workspace:changed");
    },
    sendState(state) {
      if (contents.isDestroyed() || contents.mainFrame.url !== APP_URL || !owns(state.id)) return;
      contents.send("terminal:state", state);
    },
    dispose() {
      disarm();
      contents.removeListener("did-start-navigation", disarm);
      contents.removeListener("render-process-gone", disarm);
      for (const channel of handlers.keys()) ipc.removeHandler(channel);
    },
  };
}
