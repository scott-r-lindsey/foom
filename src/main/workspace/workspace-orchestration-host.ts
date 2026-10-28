import { localResources } from "../setup/local-host";
import { prepareTail } from "../evaluator/terminal-tail";
import { locationId } from "../control/metadata";
import { LaunchFailure } from "../../shared/launch-failure";
import { UncertainEffect } from "./worktree-outcome";
import { remoteAgentTarget } from "../terminals/remote-bootstrap";
import { ControlError } from "../../shared/control-validation";
import { hasBypassArgument } from "../agents/default-arguments";
import type { OrchestrationHost } from "../control/orchestration.d";
import type { OrchestrationHostContext } from "./workspace-capabilities";
import { reviewSnapshot } from "./review-snapshot";

/** Host adapters share the coordinator's reservations; no lock state lives here. */
export function workspaceOrchestrationHost(caps: OrchestrationHostContext): OrchestrationHost {
  const remote = new Map<
    string,
    {
      host: string;
      codeFolder: string;
      localRepository: string;
      repository: string;
      path: string;
      branch: string;
      identity: string;
    }
  >();
  const hosts = () => {
    if (!caps.deps.hosts) throw new ControlError("not_found");
    return caps.deps.hosts;
  };
  const rememberRemote = (
    repository: string,
    host: string,
    tree: { repository: string; path: string; branch: string; identity: string },
    revalidate?: () => void,
  ) => {
    try {
      revalidate?.();
      const path = `/foom-remote/${locationId(JSON.stringify([host, tree.path]))}`;
      remote.set(path, {
        ...tree,
        host,
        codeFolder: hosts().registered(host).codeFolder,
        localRepository: repository,
      });
      return { path, branch: tree.branch, identity: tree.identity };
    } catch {
      // Creation succeeded; a later refusal cannot prove the checkout is absent.
      throw new UncertainEffect();
    }
  };
  const reserved = async <T>(
    repository: string,
    key: string,
    work: () => Promise<T>,
  ): Promise<T> => {
    const reservation = `${repository}\0:remote:${key}`;
    if (caps.busyWorktrees.has(reservation)) throw new ControlError("conflict");
    caps.busyWorktrees.add(reservation);
    try {
      return await work();
    } finally {
      caps.busyWorktrees.delete(reservation);
    }
  };
  const inspect = async (repository: string, tree: NonNullable<ReturnType<typeof remote.get>>) => {
    const current = await hosts().worktree(tree.host, repository, {
      operation: "inspect-worktree",
      path: tree.path,
      identity: tree.identity,
    });
    if (
      current.identity !== tree.identity ||
      current.repository !== tree.repository ||
      current.path !== tree.path
    )
      throw new LaunchFailure("remote_worktree_unavailable");
    return current;
  };
  return {
    hosts: async () => {
      const local = await localResources().catch(() => undefined);
      const scan = await caps.scanAgents(false);
      const remote = (await caps.deps.hosts?.fleet()) ?? [];
      return [
        {
          host: null,
          resources: local ?? null,
          agents: scan.agents.map((agent) => ({
            id: agent.id,
            state: agent.path ? (agent.version ? "ready" : "unable") : "missing",
          })),
        },
        ...remote.map(({ host, result }) =>
          result.ok
            ? {
                host,
                resources: {
                  cores: result.facts.cores,
                  load: result.facts.load,
                  memoryTotal: result.facts.memoryTotal,
                  memoryAvailable: result.facts.memoryAvailable,
                },
                agents: result.facts.agents,
              }
            : { host, resources: null, agents: [], reason: result.reason },
        ),
      ];
    },
    worktreeHost: (path) => remote.get(path)?.host,
    worktreeLabel: (path) => {
      const tree = remote.get(path);
      return tree ? `${tree.host}:${tree.path}` : path;
    },
    remoteCheckout: async (path, agent) => {
      const tree = remote.get(path);
      if (!tree) return undefined;
      await hosts().requireAgent(tree.host, agent);
      const current = await inspect(tree.localRepository, tree);
      return {
        target: { host: tree.host },
        repository: tree.repository,
        worktree: tree.path,
        branch: current.branch,
        identity: tree.identity,
        validate: () => {
          hosts().registered(tree.host, tree.codeFolder);
          return Promise.resolve();
        },
      };
    },
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
    createWorktree: (repository, branch, host) =>
      caps.withRepository(repository, async () => {
        if (host === undefined) return caps.createChildWorktree(repository, branch);
        hosts().registered(host);
        const tree = await hosts().worktree(host, repository, {
          operation: "create-worktree",
          branch,
        });
        return rememberRemote(repository, host, tree);
      }),
    adoptWorktree: (repository, number, unused, revalidate, review, host) =>
      caps.withRepository(repository, async () => {
        if (host !== undefined) {
          hosts().registered(host);
          if (review) throw new ControlError("remote_review_unsupported");
          const branch = await caps.deps.worktrees.adoptionBranch(repository, number);
          revalidate(undefined, branch);
          const tree = await hosts().worktree(host, repository, {
            operation: "create-worktree",
            branch,
            fromOrigin: true,
          });
          return rememberRemote(repository, host, tree, () => {
            revalidate(undefined, branch);
          });
        }
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
            review,
          );
        } finally {
          caps.busyWorktrees.delete(key);
          if (branchKey !== undefined) caps.busyWorktrees.delete(branchKey);
          caps.refresh();
        }
      }),
    launch: (parentId, repository, worktree, identity, agent, prompt, step) => {
      const tree = remote.get(worktree);
      if (!tree)
        return caps.launchChild(parentId, repository, worktree, identity, agent, prompt, step);
      return caps.withRepository(repository, () =>
        reserved(repository, worktree, async () => {
          if (step?.loop) throw new ControlError("remote_review_unsupported");
          if (identity !== tree.identity) throw new LaunchFailure("remote_worktree_unavailable");
          await hosts().requireAgent(tree.host, agent);
          step?.validate();
          const current = await inspect(repository, tree);
          const result = await caps.launchAgent(
            { repository, worktree, agent, cols: 80, rows: 24 },
            false,
            false,
            identity,
            undefined,
            {
              control: { parentId },
              prompt: prompt ?? "Await your assigned task.",
              ...(step?.selection ? { selection: step.selection } : {}),
              beforeSpawn: () => {
                hosts().registered(tree.host, tree.codeFolder);
                step?.validate();
              },
              remoteCheckout: {
                target: { host: tree.host },
                repository: tree.repository,
                worktree: tree.path,
                branch: current.branch,
                identity: tree.identity,
                // The daemon checks the creation digest during preparation and start.
                // Keep the hub's final grant/registration check independent of another SSH connection.
                validate: () => {
                  hosts().registered(tree.host, tree.codeFolder);
                  step?.validate();
                  return Promise.resolve();
                },
              },
            },
          );
          return result.id;
        }),
      );
    },
    reviewSnapshot: (repository, worktree, identity) =>
      reviewSnapshot(caps.deps.worktrees, repository, worktree, identity),
    reviewAvailable: async (agent, worktree) => {
      if (worktree && (remote.has(worktree) || remoteAgentTarget(process.argv, worktree)))
        throw new ControlError("remote_review_unsupported");
      return (await caps.scanAgents(false)).agents.some(
        (item) => item.id === agent && item.path !== null && item.resume === true,
      );
    },
    bypassDefaults: (agent) => hasBypassArgument(agent, caps.defaultArguments[agent] ?? []),
    restoreWorktree: async (repository, path) => {
      if (path === repository) return undefined;
      const tree = (await caps.deps.worktrees.listWorktrees(repository)).find(
        (item) => item.path === path,
      );
      if (!tree?.managed || tree.bare || tree.locked || tree.prunable) return undefined;
      const branch = tree.branch ?? caps.deps.worktrees.reviewBranch(repository, path, tree.head);
      if (!branch) return undefined;
      const identity = await caps.deps.worktrees.launchIdentity(repository, path);
      return { branch, identity };
    },
    stop: (id) => caps.deps.terminals.stop(id),
    close: async (id, validate, signal) => {
      await caps.sidebarCommand(
        { kind: "close", id },
        () => Promise.resolve(true),
        validate,
        signal,
      );
      return !caps.snapshot().terminals.some((row) => row.id === id);
    },
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
      const tree = remote.get(worktree);
      if (!tree)
        return caps.cleanup.removeOwnedTree(repository, worktree, identity, confirm, revalidate);
      return caps.withRepository(repository, () =>
        reserved(repository, worktree, async () => {
          revalidate();
          if (caps.snapshot().terminals.some((row) => row.worktree === worktree && !row.exited))
            throw new ControlError("conflict");
          const current = await inspect(repository, tree);
          if (
            !(await confirm(
              `${current.branch === "HEAD" ? "Detached HEAD" : current.branch} · ${tree.host}`,
              prepareTail([current.changes]).replace(/[^\P{Cc}\n\t]|\p{Cf}/gu, " "),
            ))
          )
            return false;
          revalidate();
          if (caps.snapshot().terminals.some((row) => row.worktree === worktree && !row.exited))
            throw new ControlError("conflict");
          try {
            await hosts().worktree(tree.host, repository, {
              operation: "remove-worktree",
              path: tree.path,
              identity,
              changes: current.changes,
            });
          } catch {
            // A lost reply or failed post-delete validation cannot prove non-deletion.
            throw new UncertainEffect();
          }
          remote.delete(worktree);
          return true;
        }),
      );
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
