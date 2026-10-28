import { LaunchFailure } from "../../shared/launch-failure";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { AgentId, AgentLaunched } from "../../shared/agents";
import type { ConfirmWorkspace } from "../../shared/confirmation";
import type { SidebarCommand, SidebarInventory, TerminalState } from "../../shared/workspace";
import type { CreateOutcome, Worktree } from "../../shared/worktrees";
import { conversationId, resumeArguments } from "../agents/conversation";
import { hasBypassArgument } from "../agents/default-arguments";
import { ProbeHttp } from "../agents/probe-http";
import { AgentProbes } from "../agents/probes";
import type {
  ConfigLaunchContext,
  RepositoryOperationsContext,
  SidebarCommandsContext,
} from "./workspace-capabilities";
import { homeDirectory, homeShellFacts } from "./home-shell";

export async function sidebarInventory(this: SidebarCommandsContext): Promise<SidebarInventory> {
  return {
    previews: [],
    home: await (this.homeFacts ??= homeShellFacts()),
    repositories: await Promise.all(
      this.deps.worktrees.listRepositories().map(async (repository) => {
        // Display failure is distinct from a successful, empty membership read.
        // Authorization continues to use the rejecting worktrees capability.
        let worktrees: readonly Worktree[];
        try {
          worktrees = await this.worktrees(repository.path);
        } catch {
          return { ...repository, unavailable: true, worktrees: [] };
        }
        if (this.deps.forge?.boardEnabled) {
          const tracked = await Promise.all(
            worktrees
              .filter((tree) => tree.branch && !tree.bare && !tree.prunable)
              .map(async (tree) => {
                const identity = await this.deps.worktrees
                  .launchIdentity(repository.path, tree.path)
                  .catch(() => undefined);
                return identity && tree.branch
                  ? {
                      repository: repository.path,
                      path: tree.path,
                      identity,
                      branch: tree.branch,
                    }
                  : undefined;
              }),
          );
          this.deps.forge.sync(
            repository.path,
            tracked.filter((tree) => tree !== undefined),
          );
        }
        const { removedWorktrees, ...eligibility } = this.cleanup.inventory(
          repository.path,
          worktrees,
        );
        return {
          ...repository,
          worktrees: [
            ...worktrees.map((tree) => {
              const pullRequest = this.deps.forge?.readBoard(repository.path, tree.path);
              return pullRequest ? { ...tree, pullRequest } : tree;
            }),
            ...removedWorktrees,
          ],
          ...eligibility,
        };
      }),
    ),
    shell:
      process.platform === "win32"
        ? "powershell.exe"
        : basename(process.env["SHELL"] || "/bin/bash"),
  };
}

export async function sidebarCommand(
  this: SidebarCommandsContext,
  command: Exclude<SidebarCommand, { kind: "open-handoff-link" }>,
  confirm: ConfirmWorkspace,
  validateClose?: () => void,
  closeSignal?: AbortSignal,
): Promise<void> {
  validateClose?.();
  if (this.closed) throw new Error("Workspace is closed");
  if (command.kind === "resume-id") return this.resumeId(command, confirm);
  if (command.kind === "home-shell") return this.startHomeShell();
  if (command.kind === "config-launch") return this.startConfig(command.run);
  if (command.kind === "copy-config-path") {
    if (!this.deps.config) throw new Error("Foom config is unavailable");
    await this.deps.copyText?.(this.deps.config.root);
    return;
  }
  if (command.kind === "copy-home-path") {
    await this.deps.copyText?.(homeDirectory);
    return;
  }
  if (command.kind === "open-pull-request") {
    await this.deps.worktrees.launchIdentity(command.repository, command.worktree);
    const url = this.deps.forge?.readUrl(command.repository, command.worktree);
    if (!url) throw new Error("Pull request unavailable");
    await this.deps.openExternal?.(url);
    return;
  }
  if (command.kind === "copy-worktree-path") {
    await this.deps.worktrees.launchIdentity(command.repository, command.worktree);
    await this.deps.copyText?.(command.worktree);
    return;
  }
  if (command.kind === "take-over") {
    const operationId = randomUUID();
    await this.auditHuman("take_over", command.id, command.id, "running", operationId);
    try {
      this.orchestration.takeOver(command.id);
      (await this.control)?.takeOver?.(command.id);
    } catch (error) {
      await this.auditHuman("take_over", command.id, command.id, "refused", operationId);
      throw error;
    }
    await this.auditHuman("take_over", command.id, command.id, "succeeded", operationId);
    return;
  }
  if (command.kind === "make-orchestrator") return this.makeOrchestrator(command.id, confirm);
  if (command.kind === "revoke-orchestrator") return this.revokeOrchestrator(command.id);
  if ("id" in command && this.busySessions.has(command.id)) throw new Error("Session is busy");
  if (
    command.kind === "resume" ||
    command.kind === "new-conversation" ||
    command.kind === "copy-session-id"
  ) {
    const entry = this.launched.get(command.id);
    if (!entry || entry.agent === "shell") throw new Error("Unknown agent session");
    if (command.kind === "copy-session-id") {
      if (!conversationId(entry.conversationId)) throw new Error("No conversation ID recorded");
      await this.deps.copyText?.(entry.conversationId);
      return;
    }
    if (this.executionOwner.view(entry.id).exitCode === undefined)
      throw new Error("Session is still running");
    if (command.kind === "resume") resumeArguments(entry.agent, entry.conversationId);
    this.busySessions.add(entry.id);
    try {
      const replacement = {
        id: entry.id,
        ...(command.kind === "resume" && entry.conversationId !== undefined
          ? { conversationId: entry.conversationId }
          : {}),
      };
      const remoteRole = entry.remote ? this.orchestration.view(entry.id) : undefined;
      if (entry.remote && (remoteRole?.role !== "child" || remoteRole.takenOver))
        throw new Error("Remote phase 2 requires a local-orchestrator-owned child");
      if (entry.config) await this.startConfig(entry.agent, replacement);
      else
        await this.startExisting(
          entry.repository,
          entry.worktree,
          entry.agent,
          confirm,
          replacement,
          remoteRole?.role === "child" ? { parentId: remoteRole.parentId } : undefined,
        );
    } finally {
      this.busySessions.delete(entry.id);
    }
    return;
  }
  if (command.kind === "stop" || command.kind === "close" || command.kind === "restart") {
    const entry = this.launched.get(command.id);
    if (!entry && command.kind !== "stop" && command.kind !== "close")
      throw new Error("Unknown session");
    const exited = this.executionOwner.view(command.id).exitCode !== undefined;
    if (command.kind === "stop") {
      if (!(await confirm({ kind: "stop" }))) return;
      this.orchestration.stopReviews(command.id);
      if (!exited) await this.deps.terminals.stop(command.id);
      return;
    }
    if (!exited) throw new Error("Session is still running");
    if (
      command.kind === "close" &&
      this.snapshot().terminals.some(
        (row) => row.orchestration?.role === "child" && row.orchestration.parentId === command.id,
      )
    )
      throw new Error("Close the orchestrator's children first to keep their parent context");
    if (command.kind === "restart") {
      if (!entry || entry.kind !== "shell") throw new Error("Only shells can restart");
      if (entry.config) await this.startConfig("shell");
      else if (entry.home) await this.startHomeShell();
      else await this.startExisting(entry.repository, entry.worktree, "shell", confirm);
    }
    const identity =
      command.kind === "close" && entry && !entry.home && !entry.config
        ? this.deps.worktrees.reviewIdentity(entry.repository, entry.worktree)
        : undefined;
    if (entry && identity !== undefined) {
      await this.cleanup.removeOwnedTree(
        entry.repository,
        entry.worktree,
        identity,
        async (branch, changes, automatic) =>
          automatic === true ||
          (await this.deps.dialog?.(
            {
              title: "Remove review worktree?",
              accept: changes ? "Discard changes and remove" : "Remove worktree",
              removal: {
                group: `review-close-${command.id}`,
                item: { id: command.id, branch, path: entry.worktree, changes },
              },
            },
            closeSignal ?? new AbortController().signal,
          )) === true,
        () => {
          validateClose?.();
          if (this.closed || this.launched.get(command.id) !== entry)
            throw new Error("Session changed");
        },
        command.id,
      );
      return;
    }
    if (entry?.remote) {
      const host = entry.placement?.kind === "remote" ? entry.placement.host : undefined;
      if (!host) throw new Error("Remote host placement is unavailable");
      try {
        await this.deps.terminals.kill(command.id, host);
      } catch {
        entry.remoteCleanup = "unreachable";
        this.refresh();
        console.error("Remote child close failed: remote_host_unreachable");
        throw new LaunchFailure("remote_host_unreachable");
      }
    } else if (!entry?.dormant) await this.deps.terminals.kill(command.id);
    this.removed(command.id);
    return;
  }
  this.known(command.repository);
  if (command.kind === "prune-worktree" || command.kind === "cleanup-worktree") {
    await this.withRepository(command.repository, async () => {
      if ([...this.launched.values()].some((entry) => entry.worktree === command.worktree))
        throw new Error("Close this worktree's sessions first");
      const tree = (await this.worktrees(command.repository)).find(
        (tree) => tree.path === command.worktree,
      );
      const key = `${command.repository}\0${tree?.branch ?? ""}`;
      if (this.busyWorktrees.has(key)) throw new Error("This worktree is busy");
      this.busyWorktrees.add(key);
      try {
        if (command.kind === "cleanup-worktree")
          await this.deps.worktrees.cleanupBrokenWorktree(command.repository, command.worktree);
        else await this.deps.worktrees.pruneWorktree(command.repository, command.worktree);
        this.refresh();
      } finally {
        this.busyWorktrees.delete(key);
      }
    });
    return;
  }
  if (command.kind === "delete-merged-worktrees")
    return this.cleanup.deleteMerged(command.repository, confirm);
  if (command.kind === "remove-repository") {
    return this.removeRepository(command.repository, () => confirm({ kind: "remove" }));
  }
  if (command.kind === "launch") {
    await this.startExisting(command.repository, command.worktree, command.run, confirm);
    return;
  }
  const tree = (await this.worktrees(command.repository)).find(
    (item) => item.path === command.worktree,
  );
  if (!tree) throw new Error("Worktree was removed. Choose another checkout.");
  if (tree.path === command.repository)
    throw new Error("Worktree is missing or is the main checkout");
  await this.cleanup.removeIdleTree(command.repository, tree.path, tree.branch, (branch, changes) =>
    confirm(
      changes
        ? { kind: "dirty-worktree", title: `Remove ${branch}?`, branch, changes }
        : { kind: "remove" },
    ),
  );
  this.refresh();
}

export function revokeConfig(this: ConfigLaunchContext, id: string): void {
  const token = this.configTokens.get(id);
  if (!token) return;
  this.configTokens.delete(id);
  void this.probes?.revoke(token).catch(() => undefined);
}

export function ensureProbeOpen(this: ConfigLaunchContext): void {
  if (this.closed) throw new Error("Foom config unavailable");
}

export async function configCredential(
  this: ConfigLaunchContext,
): Promise<{ token: string; env: Record<string, string> }> {
  const config = this.deps.config;
  if (!config || this.closed) throw new Error("Foom config unavailable");
  this.probes ??= new AgentProbes(
    {
      configStatus: async () => {
        if (!config.status) throw new Error("Foom config status unavailable");
        return config.status();
      },
      waitingChanged: () => {
        this.refresh();
      },
      create: async (spec) => {
        if (spec.id) this.probeIds.add(spec.id);
        try {
          return await this.deps.terminals.create(spec);
        } catch (error) {
          if (spec.id) this.probeIds.delete(spec.id);
          throw error;
        }
      },
      stop: async (id) => {
        await this.deps.terminals.stop(id);
      },
      kill: (id) => this.deps.terminals.kill(id),
      reply: async (id, data) => {
        if (!this.deps.terminals.reply) throw new Error("Probe input unavailable");
        this.input(id);
        await this.deps.terminals.reply(id, data);
      },
      screen: async (id) => {
        if (!this.deps.terminals.screen) throw new Error("Probe screen unavailable");
        return this.deps.terminals.screen(id);
      },
      show: async (id, agent, conversationId, owner, cwd, assertActive) => {
        const note = (await config.probeNotice?.(agent)) ?? false;
        assertActive();
        if (this.closed) throw new Error("Foom config unavailable");
        if (this.executionOwner.view(id).exitCode !== undefined)
          throw new Error("Probe exited during startup");
        const parent = [...this.configTokens].find(([, token]) => token === owner)?.[0];
        this.launched.set(id, {
          id,
          ...(parent ? { probeOwner: parent } : {}),
          kind: "agent",
          agent,
          config: true,
          probe: true,
          probeNote: note,
          repository: config.root,
          worktree: cwd,
          branch: null,
          attention: "evaluator",
          state: null,
          startedAt: this.now(),
          ...(conversationId === undefined ? {} : { conversationId }),
        });
        this.executionOwner.launched(id);
        this.refresh();
        if (parent) this.deps.placeChild?.(id, parent);
      },
      removed: (id) => {
        this.removed(id);
      },
    },
    config.root,
    undefined,
    undefined,
    this.deps.probeWaitingMs,
    this.now,
  );
  this.probeHttp ??= ProbeHttp.listen(this.probes).catch((error: unknown) => {
    this.probeHttp = undefined;
    throw error;
  });
  const http = await this.probeHttp;
  this.ensureProbeOpen();
  const token = this.probes.grant();
  return { token, env: { FOOM_CONFIG_TOKEN: token, FOOM_CONFIG_URL: http.url } };
}

export async function startConfig(
  this: ConfigLaunchContext,
  run: AgentId,
  replacement?: { id: string; conversationId?: string },
): Promise<void> {
  const config = this.deps.config;
  if (!config) throw new Error("Foom config is unavailable");
  await config.check();
  if (run === "shell") {
    const credential = await this.configCredential();
    try {
      const id = await this.startShell(
        { config: true, repository: config.root, worktree: config.root, branch: null },
        replacement?.id,
        config.cliDirectory,
        credential.env,
      );
      this.bindConfig(id, credential.token);
    } catch (error) {
      await this.probes?.revoke(credential.token);
      throw error;
    }
    return;
  }
  if (this.enabled[run] === false) throw new Error("This agent is turned off in preflight");
  await this.scanAgents(false);
  if (replacement) {
    const old = this.launched.get(replacement.id);
    if (!old || this.executionOwner.view(old.id).exitCode === undefined)
      throw new Error("Session is no longer exited");
    await this.queues.get(old.id);
    if (!old.dormant) await this.deps.terminals.kill(old.id);
    old.dormant = true;
    this.executionOwner.reset(old.id);
    this.deps.verdicts.forget(old.id);
  }
  const defaultArguments = this.defaultArguments[run] ?? [];
  let result: AgentLaunched;
  const credential = await this.configCredential();
  try {
    result = await this.agents.launch({
      agent: run,
      configEnvironment: credential.env,
      repository: config.root,
      worktree: config.root,
      cols: 80,
      rows: 24,
      defaultArguments,
      configCli: config.cliDirectory,
      sharedCheckout: true,
      ...(this.deps.environment ? { environment: this.deps.environment(run) } : {}),
      ...(replacement
        ? {
            terminalId: replacement.id,
            ...(replacement.conversationId === undefined
              ? {}
              : { conversationId: replacement.conversationId }),
          }
        : {}),
    });
  } catch (error) {
    await this.probes?.revoke(credential.token);
    if (replacement) this.executionOwner.markExited(replacement.id, -1);
    this.deps.onChange?.();
    throw error;
  }
  this.bindConfig(result.id, credential.token);
  const launchVersion = replacement
    ? (this.launched.get(replacement.id)?.launchVersion ?? 0) + 1
    : undefined;
  this.launched.set(result.id, {
    ...(launchVersion === undefined ? {} : { launchVersion }),
    id: result.id,
    ...(result.providerOrigin ? { providerOrigin: result.providerOrigin } : {}),
    startedAt: this.now(),
    launchFlags: [...defaultArguments],
    ...(result.environment?.length ? { environment: [...result.environment] } : {}),
    kind: "agent",
    agent: run,
    config: true,
    repository: config.root,
    worktree: config.root,
    branch: null,
    attention: result.attention,
    ...(replacement?.conversationId === undefined
      ? {}
      : { conversationId: replacement.conversationId }),
    ...(result.conversationId ? { conversationId: result.conversationId } : {}),
    bypass: result.bypass ?? hasBypassArgument(run, defaultArguments),
    state: null,
  });
  this.executionOwner.launched(result.id);
  this.persist();
  this.refresh();
}

export function probeState(
  this: ConfigLaunchContext,
  id: string,
  state: TerminalState | null,
): TerminalState | null {
  if (state?.state === "needs_input") return state;
  const token = this.configTokens.get(id);
  const at = token ? this.probes?.waitingAt(token) : undefined;
  return at === undefined
    ? state
    : {
        id,
        execution: this.executionOwner.view(id).execution,
        verdictId: null,
        state: "needs_input",
        reason: "Probe waiting",
        signal: "probe:waiting",
        confidence: 1,
        timestamp: at,
        attentionKind: "unknown",
      };
}

export async function createWorktree(
  this: RepositoryOperationsContext,
  repository: string,
  branch: string,
  location: "root" | "adjacent" = this.location,
): Promise<Worktree & { outcome: CreateOutcome }> {
  return this.withRepository(repository, async () => {
    const key = `${repository}\0${branch}`;
    if (this.busyWorktrees.has(key)) throw new Error("This worktree is busy");
    this.busyWorktrees.add(key);
    try {
      const created = await this.addWorktree(repository, branch, location);
      this.refresh();
      return created;
    } finally {
      this.busyWorktrees.delete(key);
    }
  });
}

export async function addWorktree(
  this: RepositoryOperationsContext,
  repository: string,
  branch: string,
  location: "root" | "adjacent",
): Promise<Worktree & { outcome: CreateOutcome }> {
  const { path, outcome } = await this.deps.worktrees.createWorktree(repository, branch, {
    location,
  });
  const created = (await this.deps.worktrees.listWorktrees(repository)).find(
    (tree) => tree.path === path,
  );
  if (!created) throw new Error("Created worktree is missing");
  return { ...created, outcome };
}

export async function removeWorktree(
  this: RepositoryOperationsContext,
  id: string,
  confirm: (branch: string, changes: string) => Promise<boolean>,
): Promise<boolean> {
  const entry = this.launched.get(id);
  if (!entry) throw new Error("Unknown worktree terminal");
  return this.cleanup.removeIdleTree(entry.repository, entry.worktree, entry.branch, confirm);
}
