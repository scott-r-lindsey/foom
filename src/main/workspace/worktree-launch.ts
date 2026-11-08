import { worktreeReservation } from "./worktree-reservations";
import type { ParentIdentity } from "../control/orchestration.d";
import { canRestoreControl } from "./session-restore";
import { locationId } from "../control/metadata";
import type { RemoteTarget } from "../../shared/remote-host";
import { LaunchFailure } from "../../shared/launch-failure";
import { remoteAgentTarget, remoteSpikeTarget } from "../terminals/remote-bootstrap";
import { ControlError } from "../../shared/control-validation";
import type { AgentId, AgentLaunch, AgentLaunched } from "../../shared/agents";
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
import type { AgentSetupContext, WorktreeLaunchContext } from "./workspace-capabilities";
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
    const key = worktreeReservation(request.repository, request.worktree, tree?.branch);
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
    | "control"
    | "prompt"
    | "conversationId"
    | "pinConversation"
    | "beforeSpawn"
    | "prepareSpawn"
    | "loop"
    | "pressure"
    | "selection"
    | "remoteCheckout"
  > = {},
): Promise<{ id: string; attention: "hooks" | "evaluator" }> {
  return this.withRepository(request.repository, async () => {
    if (this.enabled[request.agent] === false) throw new LaunchFailure("agent_disabled");
    // Scan once so launches don't each probe the login shell.
    if (!extra.remoteCheckout && !remoteAgentTarget(process.argv, request.worktree))
      await this.scanAgents(false);
    // Look up the branch before spawning, so nothing can fail between spawn and tracking.
    const tree = extra.remoteCheckout
      ? {
          branch: `${extra.remoteCheckout.branch === "HEAD" ? "Detached HEAD" : extra.remoteCheckout.branch} · ${extra.remoteCheckout.target.host}`,
        }
      : (await this.deps.worktrees.listWorktrees(request.repository)).find(
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
      ...(replacement && !this.launched.get(replacement.id)?.remote ? { localOnly: true } : {}),
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
      ...(result.remote ? { remote: true } : {}),
      placement: result.placement ?? { kind: "local" },
      ...(result.providerOrigin ? { providerOrigin: result.providerOrigin } : {}),
      startedAt: this.now(),
      launchFlags: [...(result.launchFlags ?? defaultArguments)],
      ...(extra.selection ? { selection: extra.selection } : {}),
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
    if (extra.remoteCheckout)
      this.sessions.rememberRemote(result.id, {
        repository: extra.remoteCheckout.repository,
        path: extra.remoteCheckout.worktree,
        branch: extra.remoteCheckout.branch,
        identity: extra.remoteCheckout.identity,
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
  checkout?: Awaited<ReturnType<WorktreeLaunchContext["orchestration"]["remoteCheckout"]>>,
  remoteOverride?: RemoteTarget,
  validateLaunch?: () => void,
  signal?: AbortSignal,
): Promise<string> {
  const remote =
    remoteOverride ??
    (checkout
      ? {
          ...checkout.target,
          checkout: {
            repository: checkout.repository,
            path: checkout.worktree,
            identity: checkout.identity,
          },
        }
      : location.home
        ? remoteSpikeTarget(process.argv)
        : undefined);
  const environment = remote ? { env: {}, names: [] } : await this.shellEnvironment(pathFirst);
  if (restoreId !== undefined) this.executionOwner.reset(restoreId);
  await checkout?.validate();
  validateLaunch?.();
  const id = await this.deps.terminals.create({
    ...(signal ? { signal } : {}),
    ...(restoreId === undefined ? {} : { id: restoreId }),
    ...(remote
      ? {
          remote: {
            ...remote,
            ...(checkout
              ? {
                  context: {
                    repository: location.repository,
                    worktree: location.worktree,
                    branch: checkout.branch,
                    agent: "shell",
                  },
                }
              : {}),
          },
        }
      : {}),
    command: remote ? `ssh ${remote.host}` : shellPath(),
    args: process.platform === "win32" ? ["-NoLogo"] : ["-l"],
    shellIntegration: true,
    env: { ...environment.env, ...configEnvironment },
    cwd: checkout?.worktree ?? location.worktree,
    cols: 80,
    rows: 24,
  });
  this.launched.set(id, {
    ...this.replacementVersion(restoreId),
    id,
    kind: "shell",
    agent: "shell",
    ...location,
    ...(remote ? { remote: true, placement: { kind: "remote" as const, host: remote.host } } : {}),
    ...(checkout ? { branch: `${checkout.branch} · ${checkout.target.host}` } : {}),
    ...(environment.names.length ? { environment: environment.names } : {}),
    attention: "evaluator",
    state: null,
    startedAt: this.now(),
  });
  this.executionOwner.ensure(id);
  if (checkout)
    this.sessions.rememberRemote(id, {
      repository: checkout.repository,
      path: checkout.worktree,
      identity: checkout.identity,
      branch: checkout.branch,
    });
  this.persist();
  this.refresh();
  return id;
}

/** Human-owned sessions outside repository control, with the user's ordinary CLI defaults. */
export async function startMachine(
  this: WorktreeLaunchContext,
  host: string | null,
  run: AgentId,
  restoreId?: string,
  location?: Pick<WorkspaceTerminal, "repository" | "worktree" | "branch">,
  conversation?: string,
  confirm?: ConfirmWorkspace,
  validateLaunch?: () => void,
  signal?: AbortSignal,
  heldReservation?: string,
): Promise<string | undefined> {
  let reservation: string | undefined;
  const perform = async (): Promise<string | undefined> => {
    const ensureOpen = () => {
      validateLaunch?.();
      if (this.closed) throw new Error("Workspace is closed");
      if (this.enabled[run] === false) throw new LaunchFailure("agent_disabled");
    };
    ensureOpen();
    const hosts = this.deps.hosts;
    let remote: RemoteTarget | undefined;
    let trackedLocation = location;
    let launchHome = homeDirectory;
    let command = shellPath();
    const args =
      run === "shell"
        ? process.platform === "win32"
          ? ["-NoLogo"]
          : ["-l"]
        : [...(this.defaultArguments[run] ?? [])];
    if (host !== null) {
      if (conversation && run !== "shell") args.push(...resumeArguments(run, conversation));
      const registered = hosts?.registered(host);
      if (!registered || !hosts?.shellTarget) throw new LaunchFailure("remote_host_unreachable");
      if (run !== "shell") await hosts.requireAgent(host, run);
      hosts.registered(host, registered.codeFolder);
      const repositoryTarget =
        location && location.repository === location.worktree
          ? await hosts.repositoryTarget?.(host, location.repository)
          : undefined;
      const checkout =
        location && !repositoryTarget
          ? await this.orchestration.remoteCheckout(location.worktree, run)
          : undefined;
      if (location && !checkout && !repositoryTarget)
        throw new LaunchFailure("remote_worktree_unavailable");
      remote = {
        ...(repositoryTarget ?? hosts.shellTarget(host)),
        ...(checkout
          ? {
              checkout: {
                repository: checkout.repository,
                path: checkout.worktree,
                identity: checkout.identity,
              },
            }
          : {}),
        context: {
          repository: location?.repository ?? homeDirectory,
          worktree: location?.worktree ?? homeDirectory,
          branch: location?.branch ?? null,
          agent: run,
          ...(!location ? { machine: true } : {}),
        },
        ...(!location
          ? {
              machineHome: (home: string) => {
                launchHome = home;
              },
            }
          : {}),
        machine: {
          ...repositoryTarget?.machine,
          codeFolder: registered.codeFolder,
          ...(run === "shell" ? {} : { agent: run, defaults: args }),
        },
      };
      if (repositoryTarget?.machine?.repository && location) {
        const path = `${registered.codeFolder}/${repositoryTarget.machine.repository.directory}`;
        trackedLocation = {
          ...location,
          worktree: `/foom-remote/${locationId(JSON.stringify([host, path]))}`,
          branch: "Main checkout",
        };
        remote.context = {
          repository: path,
          worktree: trackedLocation.worktree,
          branch: trackedLocation.branch,
          agent: run,
        };
      }
      command = `ssh ${host}`;
    } else if (run !== "shell") {
      const scan = await this.scanAgents(false);
      const installation = scan.agents.find((agent) => agent.id === run);
      if (!installation?.path) throw new LaunchFailure("agent_unavailable");
      command = installation.path;
    }
    // startExisting already holds the linked-checkout lock and confirmation.
    // Direct human launches supply confirm; main clones always require this gate.
    if (
      run !== "shell" &&
      trackedLocation &&
      (confirm || trackedLocation.branch === "Main checkout")
    ) {
      const key =
        trackedLocation.branch === "Main checkout"
          ? `remote-main\0${trackedLocation.worktree}`
          : `${trackedLocation.repository}\0:remote:${trackedLocation.worktree}`;
      if (this.busyWorktrees.has(key) && key !== heldReservation)
        throw new Error("This worktree is busy");
      if (key !== heldReservation) this.busyWorktrees.add(key);
      reservation = key;
      if (
        !(await this.confirmAgentLaunch(
          trackedLocation.worktree,
          confirm ?? (() => Promise.resolve(false)),
        ))
      )
        return;
    }
    if (location && !remote)
      await this.deps.worktrees.launchIdentity(location.repository, location.worktree);
    const environment = remote
      ? { env: {}, names: [] }
      : buildLaunchEnvironment({
          layers: this.deps.environment?.(run) ?? [],
          base: inheritedEnvironment(),
        });
    ensureOpen();
    if (host !== null) hosts?.registered(host, remote?.machine?.codeFolder);
    if (restoreId) {
      await this.queues.get(restoreId);
      const previous = this.launched.get(restoreId);
      if (previous && this.executionOwner.view(restoreId).exitCode === undefined)
        throw new Error("Session is still running");
      if (previous?.remote && previous.placement?.kind === "remote")
        await this.deps.terminals.kill(restoreId, previous.placement.host);
      else if (previous && !previous.dormant) await this.deps.terminals.kill(restoreId);
      if (previous) previous.dormant = true;
      this.executionOwner.reset(restoreId);
      this.deps.verdicts.forget(restoreId);
    }
    ensureOpen();
    if (host !== null) hosts?.registered(host, remote?.machine?.codeFolder);
    try {
      let agentResult: AgentLaunched | undefined;
      if (host === null && run !== "shell" && !location) {
        agentResult = await this.agents.launch({
          agent: run,
          repository: homeDirectory,
          worktree: homeDirectory,
          humanHome: true,
          ...(validateLaunch ? { beforeSpawn: validateLaunch } : {}),
          localOnly: true,
          sharedCheckout: true,
          cols: 80,
          rows: 24,
          defaultArguments: args,
          ...(conversation ? { conversationId: conversation } : {}),
          ...(restoreId ? { terminalId: restoreId } : {}),
          ...(this.deps.environment ? { environment: this.deps.environment(run) } : {}),
        });
      }
      const id =
        agentResult?.id ??
        (await this.deps.terminals.create({
          ...(signal ? { signal } : {}),
          ...(restoreId ? { id: restoreId } : {}),
          command,
          args,
          cwd: location?.worktree ?? homeDirectory,
          cols: 80,
          rows: 24,
          env: environment.env,
          ...(remote ? { remote } : {}),
          ...(run === "shell" ? { shellIntegration: true } : {}),
        }));
      const conversationId = agentResult?.conversationId ?? conversation;
      this.launched.set(id, {
        ...this.replacementVersion(restoreId),
        id,
        kind: run === "shell" ? "shell" : "agent",
        agent: run,
        repository: launchHome,
        worktree: launchHome,
        branch: null,
        ...(trackedLocation ?? { home: true, machine: true }),
        attention: agentResult?.attention ?? "evaluator",
        ...(conversationId ? { conversationId } : {}),
        state: null,
        placement: remote ? { kind: "remote", host: remote.host } : { kind: "local" },
        ...(remote ? { remote: true } : {}),
        launchFlags: args,
        ...(agentResult?.providerOrigin ? { providerOrigin: agentResult.providerOrigin } : {}),
        ...((agentResult?.environment ?? environment.names).length
          ? { environment: agentResult?.environment ?? environment.names }
          : {}),
        bypass: agentResult?.bypass ?? (run !== "shell" && hasBypassArgument(run, args)),
        startedAt: this.now(),
      });
      this.executionOwner.launched(id);
      this.persist();
      this.refresh();
      return id;
    } catch (error) {
      if (restoreId) {
        this.executionOwner.markExited(restoreId, -1);
        this.refresh();
      }
      throw error;
    }
  };
  try {
    return await (location ? this.withRepository(location.repository, perform) : perform());
  } finally {
    if (reservation !== undefined && reservation !== heldReservation)
      this.busyWorktrees.delete(reservation);
  }
}

export async function startHomeShell(
  this: WorktreeLaunchContext,
  restoreId?: string,
  remote?: RemoteTarget,
  validateLaunch?: () => void,
  signal?: AbortSignal,
): Promise<string> {
  return this.startShell(
    { home: true, repository: homeDirectory, worktree: homeDirectory, branch: null },
    restoreId,
    undefined,
    undefined,
    undefined,
    remote,
    validateLaunch,
    signal,
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
    if (remoteAgentTarget(process.argv, checkout.worktree))
      throw new Error("Resume remote children through their local orchestrator");
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
  authorityIdentity?: ParentIdentity,
  pastedId?: string,
  validateLaunch?: () => void,
  signal?: AbortSignal,
  heldReservation?: string,
): Promise<string | undefined> {
  return this.withRepository(repository, async () => {
    let reservation: string | undefined;
    let resumeSlot:
      | Exclude<ReturnType<WorktreeLaunchContext["orchestration"]["reserve"]>, { existing: string }>
      | undefined;
    let finishResume: (() => void) | undefined;
    let resumeRuntime: Awaited<WorktreeLaunchContext["control"]> = undefined;
    const oldParent = replacement ? this.launched.get(replacement.id) : undefined;
    let resumeGuard =
      !restoring &&
      !control &&
      replacement?.conversationId &&
      oldParent?.agent === run &&
      oldParent.repository === repository &&
      oldParent.worktree === worktree &&
      !oldParent.remote
        ? this.orchestration.resumeGuard(oldParent.id, repository)
        : undefined;
    try {
      const registeredHost = this.orchestration.worktreeHost(worktree);
      if (registeredHost !== undefined) {
        const candidate = `${repository}\0:remote:${worktree}`;
        if (this.busyWorktrees.has(candidate) && candidate !== heldReservation)
          throw new Error("This worktree is busy");
        if (candidate !== heldReservation) this.busyWorktrees.add(candidate);
        reservation = candidate;
      }
      const mappedRemote =
        registeredHost !== undefined || remoteAgentTarget(process.argv, worktree) !== undefined;
      // Capture the live parent before inventory probes; a later re-grant cannot authorize this resume.
      const remoteParentGuard =
        mappedRemote && control && "parentId" in control
          ? this.orchestration.remoteParentGuard(control.parentId)
          : undefined;
      const registeredRemote = await this.orchestration.remoteCheckout(worktree, run);
      const isRemote = registeredRemote !== undefined || mappedRemote;
      const tree = (await this.worktrees(repository)).find((item) => item.path === worktree);
      if (!tree) throw new Error("Worktree was removed. Choose another checkout.");
      if (tree.bare || tree.prunable || tree.locked) throw new Error("Worktree is unavailable");
      if (reservation === undefined) {
        const candidate = worktreeReservation(repository, worktree, tree.branch);
        if (this.busyWorktrees.has(candidate) && candidate !== heldReservation)
          throw new Error("This worktree is busy");
        if (candidate !== heldReservation) this.busyWorktrees.add(candidate);
        reservation = candidate;
      }
      const identity =
        registeredRemote?.identity ??
        (await this.deps.worktrees.launchIdentity(repository, worktree));
      if (
        authorityIdentity !== undefined &&
        (identity !== authorityIdentity.worktree ||
          (await this.deps.worktrees.launchIdentity(repository, repository)) !==
            authorityIdentity.repository)
      )
        throw new Error("Repository identity changed during restore");
      if (run !== "shell" && !restoring && !(await this.confirmAgentLaunch(worktree, confirm)))
        return;
      if (registeredRemote && !control && run !== "shell") {
        const location = {
          repository,
          worktree,
          branch: tree.branch,
        };
        return await this.startMachine(
          registeredRemote.target.host,
          run,
          replacement?.id,
          location,
          undefined,
          undefined,
          validateLaunch,
          signal,
          heldReservation,
        );
      }
      validateLaunch?.();
      if (run !== "shell") {
        const report = !isRemote ? await this.scanAgents(false) : undefined;
        const agent = report?.agents.find((entry) => entry.id === run);
        if (resumeGuard && !canRestoreControl(oldParent, agent)) resumeGuard = undefined;
        if (resumeGuard && replacement) {
          const rootIdentity = await this.deps.worktrees.launchIdentity(repository, repository);
          const parentIdentity = this.orchestration.identity(replacement.id);
          if (rootIdentity !== parentIdentity?.repository || identity !== parentIdentity.worktree)
            throw new Error("Repository identity changed during resume");
          resumeRuntime = await this.control;
          resumeGuard();
          const slot = this.orchestration.reserve(repository, undefined, true, parentIdentity);
          if ("existing" in slot) throw new Error("The orchestrator changed. Try again.");
          resumeSlot = slot;
          control = { role: "orchestrator" };
        }
        if (replacement) {
          const old = this.launched.get(replacement.id);
          if (old?.remote && !isRemote)
            throw new Error("Remote mapping is required to resume this child");
          if (!old || this.executionOwner.view(old.id).exitCode === undefined)
            throw new Error("Session is no longer exited");
          if (!restoring)
            this.orchestration.relaunched(
              replacement.id,
              old.remote && control && "parentId" in control ? control.parentId : undefined,
              resumeGuard !== undefined,
            );
          await this.queues.get(old.id);
          if (old.remote && old.placement?.kind === "remote")
            await this.deps.terminals.kill(old.id, old.placement.host);
          else if (!old.dormant) await this.deps.terminals.kill(old.id);
          old.dormant = true;
          this.executionOwner.reset(old.id);
          this.deps.verdicts.forget(old.id);
        }
        if (resumeGuard && replacement)
          finishResume = this.orchestration.observeParentResume(replacement.id);
        const childParentId = control && "parentId" in control ? control.parentId : undefined;
        try {
          const resumed = await this.launchAgent(
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
              ...(registeredRemote ? { remoteCheckout: registeredRemote } : {}),
              ...(validateLaunch || resumeGuard
                ? {
                    beforeSpawn: () => {
                      validateLaunch?.();
                      resumeGuard?.();
                    },
                  }
                : {}),
              ...(isRemote && childParentId !== undefined
                ? {
                    beforeSpawn: () => {
                      validateLaunch?.();
                      remoteParentGuard?.();
                      const parent = this.orchestration.view(childParentId);
                      const child = replacement
                        ? this.orchestration.view(replacement.id)
                        : undefined;
                      if (
                        parent?.role !== "orchestrator" ||
                        !parent.active ||
                        (replacement &&
                          (child?.role !== "child" ||
                            child.parentId !== childParentId ||
                            child.takenOver))
                      )
                        throw new Error("Remote child ownership changed");
                    },
                  }
                : {}),
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
          );
          // A human revoke may finish while the host is spawning. Keep the new
          // process ordinary and live rather than restoring cancelled authority.
          if (resumeGuard) {
            try {
              resumeGuard();
            } catch {
              resumeRuntime?.setRole?.(resumed.id, "agent");
              return resumed.id;
            }
          }
          resumeSlot?.bind(resumed.id);
          return resumed.id;
        } catch (error) {
          if (replacement) {
            this.executionOwner.markExited(replacement.id, -1);
            if (this.launched.get(replacement.id)?.remote)
              this.orchestration.exited(replacement.id);
          }
          this.deps.onChange?.();
          throw error;
        }
      } else {
        if (
          !registeredRemote &&
          (await this.deps.worktrees.launchIdentity(repository, worktree)) !== identity
        )
          throw new Error("Worktree has changed. Select it and try again.");
        return await this.startShell(
          { repository, worktree, branch: tree.branch },
          replacement?.id,
          undefined,
          undefined,
          registeredRemote,
          undefined,
          validateLaunch,
          signal,
        );
      }
    } finally {
      finishResume?.();
      resumeSlot?.release();
      if (reservation !== undefined && reservation !== heldReservation)
        this.busyWorktrees.delete(reservation);
    }
  });
}

function resumeSupport(report: AgentReport | undefined): string {
  return JSON.stringify(
    (report?.agents ?? [])
      .filter((agent) => canRestoreControl({ agent: agent.id }, agent))
      .map((agent) => agent.id)
      .sort(),
  );
}

export async function scanAgents(
  this: AgentSetupContext,
  refresh: boolean,
  agent?: string,
): Promise<AgentReport> {
  if (refresh || this.scannedProviders !== providerRevision()) this.scanned = undefined;
  this.scannedProviders = providerRevision();
  const pending = (this.scanned ??=
    agent === undefined ? this.agents.scan(this.enabled) : this.agents.scan(this.enabled, agent));
  try {
    const { warning, agents, checkedAt } = await pending;
    const report = {
      ...(checkedAt === undefined ? {} : { checkedAt }),
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
    if (this.scanned === pending) {
      const previous = resumeSupport(this.agentReport);
      this.agentReport = report;
      if (previous !== resumeSupport(report)) this.deps.onChange?.();
    }
    return report;
  } catch (error) {
    if (this.scanned === pending) {
      const previous = resumeSupport(this.agentReport);
      this.agentReport = undefined;
      if (previous !== resumeSupport(undefined)) this.deps.onChange?.();
      this.scanned = undefined;
    }
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
  } catch (error) {
    if (!service.result) throw error;
  } finally {
    this.scanned = undefined;
  }
  this.deps.onChange?.();
  const updated = await this.scanAgents(true);
  return {
    ...updated,
    agents: updated.agents.map((agent) =>
      agent.id === id && agent.setup && service.result
        ? { ...agent, setup: { ...agent.setup, result: service.result } }
        : agent,
    ),
  };
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
