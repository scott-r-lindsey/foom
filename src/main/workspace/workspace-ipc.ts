import { ApplicationError } from "../../shared/application-errors";
import { knownAgentId } from "../agents/providers/registry";
import type { PreviewOpenAction, PreviewRecord } from "../../shared/previews";
import { conversationId } from "../../shared/conversation";
import type { WindowIpc } from "../window/window-ipc";
import type { ExecutionTransition } from "../../shared/execution";
import { ConfirmationArming } from "../confirmations/arming";
import type { DialogContent, ConfirmWorkspace } from "../../shared/confirmation";
import { dialog, ipcMain, shell } from "electron";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { AgentId } from "../../shared/agents";
import type { VerdictAction } from "../../shared/evaluator";
import type { LaunchRequest, TerminalState, SidebarCommand } from "../../shared/workspace";
import type { Workspace } from "./workspace";

const APP_URL = "app://bundle/index.html";
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
  return knownAgentId(value);
}
function action(value: unknown): value is VerdictAction {
  return actions.some((name) => name === value);
}
function launchRequest(value: unknown): LaunchRequest {
  if (!record(value)) throw new Error("Invalid launch request");
  const { agent: id, repository, worktree, cols, rows } = value;
  if (
    !agent(id) ||
    !text(repository) ||
    !text(worktree) ||
    !dimension(cols, 500) ||
    !dimension(rows, 300)
  )
    throw new Error("Invalid launch request");
  // Copy known fields only; nothing else in the payload reaches the launcher.
  return {
    agent: id,
    repository,
    worktree,
    cols,
    rows,
  };
}

function sidebarCommand(value: unknown): SidebarCommand {
  if (!record(value)) throw new Error("Invalid sidebar command");
  const kind = value["kind"];
  if (kind === "home-shell" || kind === "copy-home-path" || kind === "copy-config-path") {
    if (Object.keys(value).length !== 1) throw new Error("Invalid home shell request");
    return { kind };
  }
  if (kind === "open-handoff-link") {
    const { id, seq, index } = value;
    if (
      Object.keys(value).length !== 4 ||
      !conversationId(id) ||
      typeof seq !== "number" ||
      !Number.isSafeInteger(seq) ||
      seq < 1 ||
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= 10
    )
      throw new Error("Invalid handoff link");
    return { kind, id, seq, index };
  }
  if (kind === "resume-id") {
    const checkout = value["checkout"];
    if (
      Object.keys(value).some((key) => !["kind", "checkout", "agent", "id"].includes(key)) ||
      !record(checkout) ||
      Object.keys(checkout).length !== 2 ||
      !text(checkout["repository"]) ||
      !text(checkout["worktree"]) ||
      !agent(value["agent"]) ||
      !conversationId(value["id"])
    )
      throw new Error("Invalid resume request");
    return {
      kind,
      checkout: { repository: checkout["repository"], worktree: checkout["worktree"] },
      agent: value["agent"],
      id: value["id"],
    };
  }
  if (kind === "config-launch") {
    const run = value["run"];
    if (
      Object.keys(value).some((key) => !["kind", "run"].includes(key)) ||
      (run !== "shell" && !agent(run))
    )
      throw new Error("Invalid config launch");
    return { kind, run };
  }
  if (
    kind === "stop" ||
    kind === "close" ||
    kind === "restart" ||
    kind === "resume" ||
    kind === "new-conversation" ||
    kind === "copy-session-id" ||
    kind === "take-over" ||
    kind === "make-orchestrator" ||
    kind === "revoke-orchestrator"
  ) {
    if (!text(value["id"])) throw new Error("Invalid terminal ID");
    return { kind, id: value["id"] };
  }
  if (!text(value["repository"])) throw new Error("Invalid repository");
  const repository = value["repository"];
  if (
    (kind === "prune-worktree" || kind === "cleanup-worktree") &&
    (Object.keys(value).length !== 3 ||
      Object.keys(value).some((key) => !["kind", "repository", "worktree"].includes(key)))
  )
    throw new Error("Invalid prune request");
  if (kind === "remove-repository" || kind === "delete-merged-worktrees")
    return { kind, repository };
  if (!text(value["worktree"])) throw new Error("Invalid worktree");
  const worktree = value["worktree"];
  if (
    kind === "remove-worktree" ||
    kind === "cleanup-worktree" ||
    kind === "prune-worktree" ||
    kind === "copy-worktree-path" ||
    kind === "open-pull-request"
  )
    return { kind, repository, worktree };
  if (kind === "launch" && (value["run"] === "shell" || agent(value["run"])))
    return { kind, repository, worktree, run: value["run"] };
  throw new Error("Invalid sidebar command");
}

const agentNames: Readonly<Record<string, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  agy: "Antigravity",
};

/** Granting orchestration widens permissions, so it always uses the trusted dialog. */
export function orchestratorDisclosure(id: string, replacing?: string): DialogContent {
  return {
    title: `Make ${agentNames[id] ?? id} the Foom orchestrator?`,
    accept: "Make orchestrator",
    glyph: "orbit",
    ...(replacing ? { note: `${replacing} stops orchestrating; its children stay with you.` } : {}),
    sections: [
      {
        label: "It can",
        items: [
          "Create worktrees and run child agents in this repository up to the limit in Settings → General.",
          "Stop them, and ask you to remove worktrees it created.",
          "Send prompts and keys to its own children without asking you, including answering permission, credential and provider prompts.",
          "Close its exited children, discarding their final screens; their worktrees and branches remain.",
          "Keep its own launch flags; children do not inherit them and cannot orchestrate.",
        ],
      },
      {
        label: "It reads",
        items: [
          "The last 40 lines of each child's terminal, with likely secrets redacted.",
          "Child-authored handoff summaries and links, reported when a child finishes, gets blocked or fails.",
          "Those lines and handoffs may be sent to this agent's model provider under its own settings; redaction cannot catch every secret, and repeated reads collect more.",
        ],
      },
      {
        label: "You keep",
        items: [
          "Its actions appear in its panel.",
          "Take over returns a child to you.",
          "Revoke orchestrator ends its access.",
        ],
      },
    ],
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
  requestDialog: (content: DialogContent) => Promise<boolean>,
  ipc: WindowIpc = ipcMain,
  previews: () => readonly PreviewRecord[] = () => [],
  previewActions: () => readonly PreviewOpenAction[] = () => [],
): {
  sendExecution(event: ExecutionTransition): void;
  sendState(state: TerminalState): void;
  sendChanged(): void;
  dispose(): void;
} {
  const contents = window.webContents;
  // Display associations only. Preview opens and worktree actions still validate
  // fresh membership; a failed Git read cannot prove an owned preview was removed.
  const previewRepositories = new Map<string, string>();
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
    "shared-agent": "Click again for multiple agents here",
  } satisfies Record<
    Exclude<
      Parameters<ConfirmWorkspace>[0]["kind"],
      "dirty-worktree" | "merged-worktrees" | "orchestrator"
    >,
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
          ...(request.subject !== undefined ? { subject: request.subject } : {}),
          worktrees: request.worktrees,
          ...(request.feed ? { feed: request.feed } : {}),
        });
      }
      if (request.kind === "orchestrator") {
        if (contents.isDestroyed() || contents.mainFrame.url !== APP_URL)
          return Promise.resolve(false);
        contents.send("confirmation:dialog");
        return requestDialog({
          ...orchestratorDisclosure(request.agent, request.replacing),
          ...(request.subject !== undefined ? { subject: request.subject } : {}),
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
          title: "Remove worktree with uncommitted changes?",
          subject: request.branch ?? title,
          glyph: "branch",
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
          !(request["run"] === "shell" || agent(request["run"]))
        )
          throw new Error("Invalid worktree launch");
        return workspace.startWorktree(
          {
            repository: request["repository"],
            branch: request["branch"],
            run: request["run"],
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
              ? { kind: "dirty-worktree", title: `Remove ${branch}?`, branch, changes }
              : { kind: "remove" },
          ),
        );
      },
    ],
    [
      "workspace:panel-facts",
      (...args) => {
        const [repository, worktree] = args;
        if (args.length !== 2 || !text(repository) || !text(worktree))
          throw new Error("Invalid panel request");
        return workspace.panelFacts(repository, worktree);
      },
    ],
    [
      "workspace:sidebar",
      async () => {
        const inventory = await workspace.sidebarInventory();
        const records = previews();
        const open = new Set(records.map((record) => record.id));
        for (const id of previewRepositories.keys())
          if (!open.has(id)) previewRepositories.delete(id);
        const partial = inventory.repositories.some((entry) => entry.unavailable);
        return {
          ...inventory,
          previewActions: previewActions(),
          previews: records.flatMap((record) => {
            const previous = previewRepositories.get(record.id);
            const repository =
              inventory.repositories.find((entry) =>
                entry.worktrees.some((tree) => tree.path === record.worktree),
              ) ??
              inventory.repositories.find((entry) => entry.unavailable && entry.path === previous);
            if (repository) previewRepositories.set(record.id, repository.path);
            // A new window may not yet know which unavailable repository owns a
            // restored preview. Keep its ID without guessing a repository path.
            return repository || record.bundled === "manual" || (partial && previous === undefined)
              ? [
                  {
                    ...(record.openedBy ? { openedBy: record.openedBy } : {}),
                    id: record.id,
                    repository: repository?.path ?? "",
                    worktree: record.worktree,
                    relativePath: record.relativePath,
                    network: record.network,
                    kind: /\.(md|markdown)$/i.test(record.relativePath) ? "markdown" : "html",
                  },
                ]
              : [];
          }),
        };
      },
    ],
    [
      "workspace:sidebar-command",
      (value) => {
        const command = sidebarCommand(value);
        if (
          command.kind !== "resume-id" &&
          "id" in command &&
          !owns(command.id) &&
          !workspace.ownsSession(command.id)
        )
          throw new Error("Unknown or foreign terminal ID");
        if (command.kind === "open-handoff-link") {
          const link = () =>
            workspace.orchestration.handoffs
              .entries(command.id)
              .find((report) => report.seq === command.seq)?.links[command.index];
          const url = link();
          if (!url || new URL(url).protocol !== "https:")
            throw new Error("Handoff link unavailable");
          return requestDialog({
            title: "Open external link?",
            subject: url,
            detail: "This link was supplied by a child agent. Open it in your browser?",
            accept: "Open link",
          }).then(async (accepted) => {
            if (
              accepted &&
              !contents.isDestroyed() &&
              contents.mainFrame.url === APP_URL &&
              workspace.ownsSession(command.id) &&
              link() === url
            )
              await shell.openExternal(url);
          });
        }
        const confirm = confirmation(JSON.stringify(command));
        return workspace.sidebarCommand(command, confirm);
      },
    ],
    [
      "workspace:message-board",
      (...args) => {
        if (args.length !== 2 || typeof args[0] !== "string")
          throw new Error("Invalid board request");
        return workspace.messageBoard(args[0], args[1]);
      },
    ],
    [
      "workspace:action-log",
      (...args) => {
        if (args.length !== 1) throw new Error("Invalid action log request");
        return workspace.actionLog(args[0]);
      },
    ],
    [
      "workspace:clear-action-log",
      (...args) => {
        if (args.length) throw new Error("Invalid action log request");
        return workspace.clearActionLog();
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
      "workspace:branches",
      (...args) => {
        const [repository] = args;
        if (args.length !== 1 || !text(repository)) throw new Error("Invalid repository");
        return workspace.branches(repository);
      },
    ],
    [
      "workspace:create-worktree",
      (...args) => {
        const [repository, branch, location] = args;
        if (
          args.length > 3 ||
          !text(repository) ||
          !text(branch, 255) ||
          (location !== undefined && location !== "root" && location !== "adjacent")
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
      "agents:setup",
      (...args) => {
        const [id, action] = args;
        if (
          args.length !== 2 ||
          !agent(id) ||
          !text(action, 40) ||
          !/^[a-z][a-z0-9-]*$/u.test(action)
        )
          throw new Error("Invalid setup request");
        return workspace.changeAgentSetup(id, action, (content) => {
          if (contents.isDestroyed() || contents.mainFrame.url !== APP_URL)
            return Promise.resolve(false);
          contents.send("confirmation:dialog");
          return requestDialog(content);
        });
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
        // Keep the old bridge name as an alias, with the same model-owned
        // ownership checks and separate confirmation for every action.
        return workspace.changeAgentSetup("agy", action, (content) => {
          if (contents.isDestroyed() || contents.mainFrame.url !== APP_URL)
            return Promise.resolve(false);
          contents.send("confirmation:dialog");
          return requestDialog(content);
        });
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
      const reject = (error: unknown): never => {
        throw error instanceof ApplicationError ? error : new ApplicationError("operation-failed");
      };
      try {
        if (!trusted(event)) throw new Error("Untrusted IPC sender");
        return Promise.resolve(handler(...args)).catch(reject);
      } catch (error) {
        return reject(error);
      }
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
