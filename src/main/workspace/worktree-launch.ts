import { ControlError } from "../../node-common/control-validation";
import type { AgentId, AgentLaunch } from "../../shared/agents";
import type { AgyPluginAction } from "../../shared/agy-plugin";
import type { ConfirmWorkspace, DialogContent } from "../../shared/confirmation";
import { builtinAgent } from "../../shared/providers/catalog";
import type {
  AgentReport,
  LaunchRequest,
  SidebarCommand,
  StartWorktreeRequest,
  WorkspaceTerminal,
} from "../../shared/workspace";
import { loginPath } from "../agents/agents";
import { resumeArguments } from "../agents/conversation";
import { hasBypassArgument } from "../agents/default-arguments";
import { PluginSetup } from "../agents/plugin-setup";
import { stagePlugin } from "../agents/plugin-staging";
import { observerHealth } from "../agents/providers/installed-observers";
import { agentProvider, knownAgentId, providerRevision } from "../agents/providers/registry";
import { buildLaunchEnvironment, inheritedEnvironment } from "../setup/environment";
import type { AgentSetupContext, WorktreeLaunchContext } from "./feature-context";
import { homeDirectory, shellPath } from "./home-shell";

export async function confirmAgentLaunch(
  this: WorktreeLaunchContext,
  worktree: string,
  confirm: ConfirmWorkspace,
): Promise<boolean> {
  const active = [...this.launched.values()].some(
    (entry) =>
      entry.worktree === worktree &&
      entry.kind === "agent" &&
      this.executionOwner.view(entry.id).exitCode === undefined,
  );
  return !active || confirm({ kind: "shared-agent" });
}

export async function launch(
  this: WorktreeLaunchContext,
  request: LaunchRequest,
  confirm: ConfirmWorkspace = () => Promise.resolve(false),
): Promise<{ id: string; attention: "hooks" | "evaluator" } | null> {
  return this.withRepository(request.repository, async () => {
    const tree = (await this.worktrees(request.repository)).find(
      (item) => item.path === request.worktree,
    );
    const key = `${request.repository}\0${tree?.branch ?? ""}`;
    if (this.busyWorktrees.has(key)) throw new Error("This worktree is busy");
    this.busyWorktrees.add(key);
    try {
      const identity = await this.deps.worktrees.launchIdentity(
        request.repository,
        request.worktree,
      );
      if (!(await this.confirmAgentLaunch(request.worktree, confirm))) return null;
      return await this.launchAgent(request, false, true, identity);
    } finally {
      this.busyWorktrees.delete(key);
    }
  });
}

export async function launchAgent(
  this: WorktreeLaunchContext,
  request: LaunchRequest,
  mainCheckout = false,
  sharedCheckout = false,
  checkoutIdentity?: string,
  replacement?: { id: string; conversationId?: string },
  extra: Pick<
    AgentLaunch,
    "control" | "prompt" | "conversationId" | "pinConversation" | "beforeSpawn" | "loop"
  > = {},
): Promise<{ id: string; attention: "hooks" | "evaluator" }> {
  return this.withRepository(request.repository, async () => {
    if (this.enabled[request.agent] === false)
      throw new Error("This agent is turned off in preflight");
    // Scan once so launches don't each probe the login shell.
    await this.scanAgents(false);
    // Look up the branch before spawning, so nothing can fail between spawn and tracking.
    const tree = (await this.deps.worktrees.listWorktrees(request.repository)).find(
      (entry) => entry.path === request.worktree,
    );
    // Children use the user's defaults as written, but never bypass: an orchestrator
    // cannot pass on the user's acknowledgement for manual launches.
    const child = extra.control !== undefined && "parentId" in extra.control;
    const defaultArguments = this.defaultArguments[request.agent] ?? [];
    if (child && hasBypassArgument(request.agent, defaultArguments))
      throw new ControlError("forbidden");
    const result = await this.agents.launch({
      ...request,
      ...extra,
      defaultArguments,
      ...(replacement
        ? {
            terminalId: replacement.id,
            ...(replacement.conversationId === undefined
              ? {}
              : { conversationId: replacement.conversationId }),
          }
        : {}),
      mainCheckout,
      sharedCheckout,
      ...(checkoutIdentity !== undefined ? { checkoutIdentity } : {}),
      ...(this.deps.environment ? { environment: this.deps.environment(request.agent) } : {}),
    });
    const launchVersion = replacement
      ? (this.launched.get(replacement.id)?.launchVersion ?? 0) + 1
      : undefined;
    if (extra.control && "role" in extra.control && checkoutIdentity !== undefined)
      this.sessions.rememberIdentity(request.repository, checkoutIdentity);
    this.launched.set(result.id, {
      ...(launchVersion === undefined ? {} : { launchVersion }),
      id: result.id,
      ...(extra.loop
        ? {
            review:
              "authorId" in extra.loop
                ? extra.loop
                : { ...extra.loop, authorId: result.id, round: 0, phase: "building" as const },
          }
        : {}),
      ...(result.providerOrigin ? { providerOrigin: result.providerOrigin } : {}),
      startedAt: this.now(),
      launchFlags: [...defaultArguments],
      ...(result.environment?.length ? { environment: [...result.environment] } : {}),
      kind: "agent",
      agent: request.agent,
      repository: request.repository,
      worktree: request.worktree,
      branch: tree?.branch ?? null,
      attention: result.attention,
      ...((replacement?.conversationId ?? extra.conversationId) === undefined
        ? {}
        : { conversationId: replacement?.conversationId ?? extra.conversationId }),
      ...(result.conversationId ? { conversationId: result.conversationId } : {}),
      bypass: result.bypass ?? hasBypassArgument(request.agent, defaultArguments),
      state: null,
    });
    this.executionOwner.launched(result.id);
    this.persist();
    this.refresh();
    return { id: result.id, attention: result.attention };
  });
}

export async function startWorktree(
  this: WorktreeLaunchContext,
  request: StartWorktreeRequest,
  confirm: ConfirmWorkspace = () => Promise.resolve(false),
): Promise<string | null> {
  return this.withRepository(request.repository, async () => {
    // Lock the logical branch before any async operation, including creation.
    const key = `${request.repository}\0${request.branch}`;
    if (this.busyWorktrees.has(key)) throw new Error("This worktree is busy");
    this.busyWorktrees.add(key);
    try {
      await this.deps.worktrees.validateBranch(request.repository, request.branch);
      const trees = await this.worktrees(request.repository);
      const existing = trees.find((tree) => tree.branch === request.branch);
      const tree =
        existing ?? (await this.addWorktree(request.repository, request.branch, this.location));
      if (tree.bare || tree.locked || tree.prunable) throw new Error("Worktree is unavailable");
      const identity = await this.deps.worktrees.launchIdentity(request.repository, tree.path);
      if (request.run !== "shell") {
        if (!(await this.confirmAgentLaunch(tree.path, confirm))) return null;
        return (
          await this.launchAgent(
            {
              agent: request.run,
              repository: request.repository,
              worktree: tree.path,
              cols: 80,
              rows: 24,
            },
            false,
            true,
            identity,
          )
        ).id;
      }
      if ((await this.deps.worktrees.launchIdentity(request.repository, tree.path)) !== identity)
        throw new Error("Worktree has changed. Select it and try again.");
      return await this.startShell({
        repository: request.repository,
        worktree: tree.path,
        branch: tree.branch,
      });
    } finally {
      this.busyWorktrees.delete(key);
    }
  });
}

export async function shellEnvironment(
  this: WorktreeLaunchContext,
  pathFirst?: string,
): Promise<{ env: Record<string, string>; names: string[] }> {
  const layers = this.deps.environment?.("shell") ?? [];
  const path = pathFirst === undefined ? undefined : (await loginPath()).path;
  return buildLaunchEnvironment({ layers, base: inheritedEnvironment(), pathFirst, path });
}

export async function startShell(
  this: WorktreeLaunchContext,
  location: Pick<WorkspaceTerminal, "repository" | "worktree" | "branch" | "home" | "config">,
  restoreId?: string,
  pathFirst?: string,
  configEnvironment?: Readonly<Record<string, string>>,
): Promise<string> {
  const environment = await this.shellEnvironment(pathFirst);
  if (restoreId !== undefined) this.executionOwner.reset(restoreId);
  const id = await this.deps.terminals.create({
    ...(restoreId === undefined ? {} : { id: restoreId }),
    command: shellPath(),
    args: process.platform === "win32" ? ["-NoLogo"] : ["-l"],
    shellIntegration: true,
    env: { ...environment.env, ...configEnvironment },
    cwd: location.worktree,
    cols: 80,
    rows: 24,
  });
  this.launched.set(id, {
    ...this.replacementVersion(restoreId),
    id,
    kind: "shell",
    agent: "shell",
    ...location,
    ...(environment.names.length ? { environment: environment.names } : {}),
    attention: "evaluator",
    state: null,
    startedAt: this.now(),
  });
  this.executionOwner.ensure(id);
  this.persist();
  this.refresh();
  return id;
}

export async function startHomeShell(
  this: WorktreeLaunchContext,
  restoreId?: string,
): Promise<void> {
  await this.startShell(
    { home: true, repository: homeDirectory, worktree: homeDirectory, branch: null },
    restoreId,
  );
}

export async function resumeId(
  this: WorktreeLaunchContext,
  command: Extract<SidebarCommand, { kind: "resume-id" }>,
  confirm: ConfirmWorkspace,
): Promise<void> {
  const { checkout, agent, id } = command;
  resumeArguments(agent, id);
  const key = `${agent}\0${id}`;
  // Serialize by conversation across checkouts, including confirmations and spawn.
  const previous = this.resumeStarts.get(key);
  const pending = (async () => {
    if (previous) await previous.catch(() => undefined);
    this.known(checkout.repository);
    await this.deps.worktrees.launchIdentity(checkout.repository, checkout.worktree);
    const scan = await this.scanAgents(false);
    if (
      this.enabled[agent] === false ||
      !scan.agents.some((entry) => entry.id === agent && entry.path)
    )
      throw new Error("Agent is unavailable");
    const running = [...this.launched.values()].find(
      (entry) =>
        entry.agent === agent &&
        entry.conversationId === id &&
        !entry.dormant &&
        this.executionOwner.view(entry.id).exitCode === undefined,
    );
    if (running) {
      this.deps.reveal?.(running.id);
      return;
    }
    await this.startExisting(
      checkout.repository,
      checkout.worktree,
      agent,
      confirm,
      undefined,
      undefined,
      false,
      undefined,
      id,
    );
  })();
  this.resumeStarts.set(key, pending);
  try {
    await pending;
  } finally {
    if (this.resumeStarts.get(key) === pending) this.resumeStarts.delete(key);
  }
}

export async function startExisting(
  this: WorktreeLaunchContext,
  repository: string,
  worktree: string,
  run: AgentId,
  confirm: ConfirmWorkspace,
  replacement?: { id: string; conversationId?: string },
  control?: AgentLaunch["control"],
  restoring = false,
  authorityIdentity?: string,
  pastedId?: string,
): Promise<string | undefined> {
  return this.withRepository(repository, async () => {
    const tree = (await this.worktrees(repository)).find((item) => item.path === worktree);
    if (!tree) throw new Error("Worktree was removed. Choose another checkout.");
    if (tree.bare || tree.prunable || tree.locked) throw new Error("Worktree is unavailable");
    const key = `${repository}\0${tree.branch ?? ""}`;
    if (this.busyWorktrees.has(key)) throw new Error("This worktree is busy");
    this.busyWorktrees.add(key);
    try {
      const identity = await this.deps.worktrees.launchIdentity(repository, worktree);
      if (authorityIdentity !== undefined && identity !== authorityIdentity)
        throw new Error("Repository identity changed during restore");
      if (run !== "shell" && !restoring && !(await this.confirmAgentLaunch(worktree, confirm)))
        return;
      if (run !== "shell") {
        await this.scanAgents(false);
        if (replacement) {
          if (!restoring) this.orchestration.relaunched(replacement.id);
          const old = this.launched.get(replacement.id);
          if (!old || this.executionOwner.view(old.id).exitCode === undefined)
            throw new Error("Session is no longer exited");
          await this.queues.get(old.id);
          if (!old.dormant) await this.deps.terminals.kill(old.id);
          old.dormant = true;
          this.executionOwner.reset(old.id);
          this.deps.verdicts.forget(old.id);
        }
        try {
          return (
            await this.launchAgent(
              {
                agent: run,
                repository,
                worktree,
                cols: 80,
                rows: 24,
              },
              worktree === repository,
              true,
              identity,
              replacement,
              {
                ...(pastedId === undefined
                  ? {}
                  : { conversationId: pastedId, pinConversation: true }),
                ...(control === undefined
                  ? {}
                  : {
                      control,
                      ...("parentId" in control ? { prompt: "Resume your previous task." } : {}),
                    }),
              },
            )
          ).id;
        } catch (error) {
          if (replacement) this.executionOwner.markExited(replacement.id, -1);
          this.deps.onChange?.();
          throw error;
        }
      } else {
        if ((await this.deps.worktrees.launchIdentity(repository, worktree)) !== identity)
          throw new Error("Worktree has changed. Select it and try again.");
        return await this.startShell(
          { repository, worktree, branch: tree.branch },
          replacement?.id,
        );
      }
    } finally {
      this.busyWorktrees.delete(key);
    }
  });
}

export async function scanAgents(this: AgentSetupContext, refresh: boolean): Promise<AgentReport> {
  if (refresh || this.scannedProviders !== providerRevision()) this.scanned = undefined;
  this.scannedProviders = providerRevision();
  this.scanned ??= this.agents.scan(this.enabled);
  try {
    const { warning, agents } = await this.scanned;
    return {
      warning,
      agents: await Promise.all(
        agents.map(async (agent) => {
          if (!knownAgentId(agent.id)) return agent;
          const provider = agentProvider(agent.id);
          if (!agent.path || !provider.model.health) return agent;
          const health = agent.healthSupported
            ? await observerHealth(
                provider.model,
                this.deps.agentPluginDirectory,
                provider.origin === "bundled",
              ).catch(() => undefined)
            : undefined;
          return {
            ...agent,
            ...(agent.healthSupported
              ? {
                  hookState: health?.get() ?? "not-reviewed",
                  healthInstructions: provider.model.health.instructions,
                }
              : {}),
            notifierReplacement: provider.needsNotifier(
              agent,
              undefined,
              health?.get() === "trusted",
            ),
          };
        }),
      ),
    };
  } catch (error) {
    this.scanned = undefined;
    throw error;
  }
}

export async function changeAgentSetup(
  this: AgentSetupContext,
  id: string,
  action: string,
  confirm: (content: DialogContent) => Promise<boolean>,
): Promise<AgentReport> {
  const provider = agentProvider(id);
  const model = provider.model;
  if (!model.setup) throw new Error("Agent setup is unavailable");
  const revision = providerRevision();
  const report = await this.scanAgents(true);
  const executable = report.agents.find((entry) => entry.id === id)?.path;
  if (!executable) throw new Error("Agent is not installed");
  const service = new PluginSetup();
  try {
    await service.change({
      model,
      executable,
      action,
      signal: this.launchAbort.signal,
      facts: (state) =>
        provider.setupFacts?.(executable, {
          hooksEnabled: this.hooksEnabled && this.agentHooks[id] !== false,
          healthTrusted: false,
          setupState: state ?? "unavailable",
        }) ?? {},
      validate: async () => {
        if (this.closed || revision !== providerRevision() || agentProvider(id) !== provider)
          throw new Error("Agent plugin changed. Scan again.");
        await provider.validate?.();
        const current = await this.scanAgents(true);
        if (current.agents.find((entry) => entry.id === id)?.path !== executable)
          throw new Error("Agent executable changed. Scan again.");
      },
      confirm,
      stage: () => {
        if (!this.deps.pluginStagingRoot) throw new Error("Plugin staging is unavailable");
        return stagePlugin(
          model,
          this.deps.pluginStagingRoot,
          provider.setupFacts?.(executable, {
            setupState: report.agents.find((entry) => entry.id === id)?.setup?.state,
            hooksEnabled: this.hooksEnabled && this.agentHooks[id] !== false,
            healthTrusted: false,
          }) ?? {},
        );
      },
    });
  } finally {
    this.scanned = undefined;
  }
  this.deps.onChange?.();
  return this.scanAgents(true);
}

export async function changeAgyPlugin(
  this: AgentSetupContext,
  action: AgyPluginAction,
  confirm: () => Promise<boolean> = () => Promise.resolve(false),
): Promise<AgentReport> {
  const report = await this.scanAgents(true);
  const executable = report.agents.find((agent) => builtinAgent(agent.id)?.pluginSetup)?.path;
  if (!executable) throw new Error("Antigravity is not installed");
  if (action === "install" || action === "update") {
    const accepted = await confirm();
    await this.deps.acknowledgeAgyPluginOffer?.();
    if (!accepted) return report;
  }
  try {
    await this.agyPlugin.change(executable, action);
  } finally {
    this.scanned = undefined;
  }
  this.deps.onChange?.();
  return this.scanAgents(true);
}
