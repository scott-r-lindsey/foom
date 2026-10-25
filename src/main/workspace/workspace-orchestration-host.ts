import { ControlError } from "../../shared/control-validation";
import { hasBypassArgument } from "../agents/default-arguments";
import type { OrchestrationHost } from "../control/orchestration.d";
import type { OrchestrationHostContext } from "./workspace-capabilities";
import { reviewSnapshot } from "./review-snapshot";

/** Host adapters share the coordinator's reservations; no lock state lives here. */
export function workspaceOrchestrationHost(caps: OrchestrationHostContext): OrchestrationHost {
  return {
    ...(caps.deps.forge === undefined ? {} : { forge: caps.deps.forge }),
    terminals: () => caps.snapshot().terminals,
    auditHandoff: async (actor, report) => {
      const audit = (await caps.control)?.audit;
      if (!audit) throw new ControlError("unavailable");
      await audit.handoff(actor, report);
    },
    saveHandoffs: async () => {
      await caps.sessions.save();
    },
    createWorktree: (repository, branch) => caps.createChildWorktree(repository, branch),
    adoptWorktree: (repository, number, unused, revalidate) =>
      caps.withRepository(repository, async () => {
        const key = `${repository}\0:adopt-pr-${String(number)}`;
        if (caps.busyWorktrees.has(key)) throw new ControlError("branch_in_use");
        caps.busyWorktrees.add(key);
        let branchKey: string | undefined;
        try {
          return await caps.deps.worktrees.adoptWorktree(
            repository,
            number,
            unused,
            (path, branch) => {
              if (branchKey === undefined) {
                const candidate = `${repository}\0${branch ?? ""}`;
                if (caps.busyWorktrees.has(candidate)) throw new ControlError("branch_in_use");
                branchKey = candidate;
                caps.busyWorktrees.add(candidate);
              }
              revalidate(path, branch);
              if (caps.snapshot().terminals.some((row) => row.worktree === path && !row.exited))
                throw new ControlError("branch_in_use");
            },
            caps.location,
          );
        } finally {
          caps.busyWorktrees.delete(key);
          if (branchKey !== undefined) caps.busyWorktrees.delete(branchKey);
          caps.refresh();
        }
      }),
    launch: (parentId, repository, worktree, identity, agent, prompt, step) =>
      caps.launchChild(parentId, repository, worktree, identity, agent, prompt, step),
    reviewSnapshot: (repository, worktree, identity) =>
      reviewSnapshot(caps.deps.worktrees, repository, worktree, identity),
    reviewAvailable: async (agent) =>
      (await caps.scanAgents(false)).agents.some(
        (item) => item.id === agent && item.path !== null && item.resume === true,
      ),
    bypassDefaults: (agent) => hasBypassArgument(agent, caps.defaultArguments[agent] ?? []),
    restoreWorktree: async (repository, path) => {
      if (path === repository) return undefined;
      const tree = (await caps.deps.worktrees.listWorktrees(repository)).find(
        (item) => item.path === path,
      );
      if (!tree?.managed || tree.bare || tree.locked || tree.prunable || tree.branch === null)
        return undefined;
      const identity = await caps.deps.worktrees.launchIdentity(repository, path);
      return { branch: tree.branch, identity };
    },
    stop: (id) => caps.deps.terminals.stop(id),
    close: (id) => caps.sidebarCommand({ kind: "close", id }, () => Promise.resolve(true)),
    place: (id, parentId) => {
      if (caps.showNewChildren) caps.deps.placeChild?.(id, parentId);
    },
    starting: (id) => caps.sessions.isRestoring(id),
    reply: async (id, data) => {
      if (!caps.deps.terminals.childInput) throw new Error("Child input adapter unavailable");
      caps.input(id);
      await caps.deps.terminals.childInput(id, data);
    },
    reveal: (id) => caps.deps.reveal?.(id),
    tail: (id, lines) => caps.deps.terminals.tail(id, lines),
    remove: async (repository, worktree, identity, confirm, revalidate) => {
      return caps.cleanup.removeOwnedTree(repository, worktree, identity, confirm, revalidate);
    },
    dialog: (content, signal) => caps.deps.dialog?.(content, signal) ?? Promise.resolve(false),
    changed: () => {
      if (!caps.closed) {
        caps.persist();
        caps.refresh();
      }
    },
  };
}
