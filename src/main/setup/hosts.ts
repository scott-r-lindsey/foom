import { askpassSupported, trustHostKey } from "./ssh-host-key";
import type { HostOutput } from "../../shared/registered-hosts.d";
import { selectHostRecipe } from "../../shared/registered-host-recipes";
import type { RemoteTarget } from "../../shared/remote-host";
import { bundledAgentData } from "../../shared/bundled-agent-data";
import { parseAgentManifest } from "../../shared/agent-plugin-parser";
import type { ForgeWorktree, ForgeInspection } from "../control/forge.d";
import { ControlError } from "../../shared/control-validation";
import { UncertainEffect } from "../workspace/worktree-outcome";
import { isLaunchReason, LaunchFailure } from "../../shared/launch-failure";
import { providerRevision } from "../agents/providers/registry";
import { loginPath } from "../agents/agents";
import { resolveForgeExecutable } from "../control/forge-process";
import { agentProviders } from "../agents/providers/registry";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { devNull } from "node:os";
import {
  hostsAction,
  gitOrigin,
  hostResult,
  hostRequirements,
  hostNicknameError,
  originSshArgs,
} from "../../shared/registered-hosts";
import type {
  HostCheckTarget,
  RegisteredHost,
  HostFailure,
  HostCheck,
  HostCheckProgress,
  HostPreflight,
  HostManagement,
  HostFacts,
  HostResult,
  HostsState,
  RepositoryLocation,
  RemoteWorktree,
} from "../../shared/registered-hosts.d";
import type { SettingsStore } from "./settings";
import type { Repository, Worktree } from "../../shared/worktrees";
import type { RemoteSavedPlacement } from "../workspace/session-restore.d";
import type { DialogContent } from "../../shared/confirmation";
import type { RemoteSessionInfo, RemoteInventoryResult } from "../../shared/remote-host";
import { locationId } from "../control/metadata";
import { remoteInventory, remoteManagement } from "../terminals/remote-transport";
import { sshEnvironment } from "../terminals/remote-bootstrap";

/** Background inspections carry the same main-classified failure without a checklist. */
function unknownHostKey(result: HostResult | undefined): boolean {
  const ssh = result?.connection?.ssh;
  return ssh
    ? ssh.state === "fail" && ssh.reason === "host-key-unknown"
    : result?.ok === false && result.reason === "host-key-unknown";
}

/** Only the folder observation (including macOS's path warning) changes. */
function folderObservation(facts: HostFacts, result: HostResult): HostFacts {
  const observed = result.ok ? result.facts : undefined;
  const mac = facts.requirements?.mac;
  const observedMac = observed?.requirements?.mac;
  return {
    ...facts,
    folder:
      observed?.folder ??
      (result.ok ? { state: "pass" } : { state: "fail", reason: result.reason }),
    ...(facts.requirements && mac && observedMac
      ? {
          requirements: {
            ...facts.requirements,
            mac: { ...mac, protectedFolder: observedMac.protectedFolder },
          },
        }
      : {}),
  };
}

/** Profile-owned registrations only. Developer mappings never enter this service. */
class HostRowUnavailable extends Error {}
class HostRowSaveFailed extends Error {
  constructor(readonly retry: () => Promise<HostPreflight | undefined>) {
    super("Unable to save host row");
  }
}
interface PendingHostRow {
  target: HostCheckTarget;
  retry?: () => Promise<HostPreflight | undefined>;
  reason?: "save-failed" | "check-failed";
}

export class Hosts {
  private readonly savedPlacements = new Map<
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
  rememberPlacement(
    repository: string,
    worktree: string,
    host: string,
    value: RemoteSavedPlacement,
  ): void {
    const registered = this.store.get().registeredHosts?.find((entry) => entry.host === host);
    if (
      !registered ||
      !this.repositories().some((entry) => entry.path === repository) ||
      worktree !== `/foom-remote/${locationId(JSON.stringify([host, value.path]))}` ||
      !value.path.startsWith(`${registered.codeFolder}/.foom-worktree-`) ||
      value.path.slice(registered.codeFolder.length + 1).includes("/")
    )
      return;
    this.savedPlacements.set(worktree, {
      host,
      codeFolder: registered.codeFolder,
      localRepository: repository,
      repository: value.repository,
      path: value.path,
      branch: value.branch,
      identity: value.identity,
    });
  }
  private readonly worktreeInventories = new Map<
    string,
    { codeFolder: string; own: readonly RemoteWorktree[]; other: number; at: number }
  >();
  private readonly worktreeReads = new Map<
    string,
    { token: symbol; work: Promise<readonly RemoteWorktree[]> }
  >();
  private invalidateWorktrees(host: string): void {
    this.worktreeInventories.delete(host);
    this.worktreeReads.delete(host);
  }
  private async readWorktrees(host: string, fresh = false): Promise<readonly RemoteWorktree[]> {
    const cached = this.worktreeInventories.get(host);
    const registration = this.registered(host);
    if (
      !fresh &&
      cached?.codeFolder === registration.codeFolder &&
      Date.now() >= cached.at &&
      Date.now() - cached.at < 60000
    )
      return cached.own;
    const pending = this.worktreeReads.get(host);
    if (pending) return pending.work;
    const token = Symbol();
    const work = (async () => {
      this.worktreeInventories.delete(host);
      if (!this.profile) return [];
      const result = await this.run(host, {
        type: "manage",
        operation: "list-worktrees",
        codeFolder: registration.codeFolder,
        profile: this.profile,
      });
      // A completed mutation or forgotten registration supersedes this read.
      // Its callers join the current observation; its reply cannot refill the cache.
      if (this.worktreeReads.get(host)?.token !== token) return this.readWorktrees(host);
      this.registered(host, registration.codeFolder);
      if (!result.ok || !result.inventory) return [];
      const own = result.inventory.own.filter(
        (tree) =>
          tree.repository ===
            `${registration.codeFolder}/repository-${createHash("sha256").update(tree.origin).digest("hex").slice(0, 24)}` &&
          tree.path.startsWith(`${registration.codeFolder}/.foom-worktree-`) &&
          !tree.path.slice(registration.codeFolder.length + 1).includes("/"),
      );
      if (new Set(own.map((tree) => tree.path)).size !== own.length) return [];
      this.worktreeInventories.set(host, {
        codeFolder: registration.codeFolder,
        own,
        other: result.inventory.other,
        at: Date.now(),
      });
      return own;
    })();
    this.worktreeReads.set(host, { token, work });
    try {
      return await work;
    } finally {
      if (this.worktreeReads.get(host)?.token === token) this.worktreeReads.delete(host);
    }
  }
  /** Fresh observations only. Discovering a checkout never creates an orchestration grant. */
  async worktrees(repository: string): Promise<readonly Worktree[]> {
    if (!this.repositories().some((repo) => repo.path === repository))
      throw new ControlError("not_found");
    if (!this.store.get().registeredHosts?.length) return [];
    const origin = await this.origin(repository).catch(() => undefined);
    if (!origin) return [];
    const entries = await Promise.all(
      (this.store.get().registeredHosts ?? []).map(async ({ host }) => {
        try {
          const trees = await this.readWorktrees(host);
          this.registered(host);
          if (
            (await this.origin(repository)) !== origin ||
            !this.repositories().some((repo) => repo.path === repository)
          )
            return [];
          return trees
            .filter((tree) => tree.origin === origin)
            .map((tree) => ({
              host,
              path: `/foom-remote/${locationId(JSON.stringify([host, tree.path]))}`,
              branch: tree.branch,
              head: null,
              bare: false,
              locked: false,
              prunable: false,
              managed: false,
            }));
        } catch {
          return [];
        }
      }),
    );
    return entries.flat();
  }
  private readonly sessionInventories = new Map<string, RemoteInventoryResult>();
  async sessions(): Promise<readonly { host: string; session: RemoteSessionInfo }[]> {
    const rows: { host: string; session: RemoteSessionInfo }[] = [];
    for (const registration of this.store.get().registeredHosts ?? []) {
      try {
        const result = await this.readSessions(registration.host);
        rows.push(...result.own.map((session) => ({ host: registration.host, session })));
      } catch {
        /* A host being offline must not prevent the others restoring. */
      }
    }
    return rows;
  }
  private async readSessions(host: string): Promise<RemoteInventoryResult> {
    const registered = this.registered(host);
    if (!this.profile) throw new Error("Profile unavailable");
    const result = await remoteInventory(
      { host },
      this.version,
      {
        type: "inventory",
        profile: this.profile,
        ...(registered.codeFolder.startsWith("/") ? { codeFolder: registered.codeFolder } : {}),
      },
      this.cancellation.signal,
    );
    this.registered(host, registered.codeFolder);
    this.sessionInventories.set(host, result);
    return result;
  }
  private readonly repositoryOrigins = new Map<string, string>();
  placement(worktree: string, repository?: string) {
    for (const [host, inventory] of this.worktreeInventories) {
      const registered = this.store
        .get()
        .registeredHosts?.some(
          (entry) => entry.host === host && entry.codeFolder === inventory.codeFolder,
        );
      if (!registered) continue;
      for (const tree of inventory.own) {
        if (worktree !== `/foom-remote/${locationId(JSON.stringify([host, tree.path]))}`) continue;
        const localRepository = this.repositories().find(
          (repo) =>
            (repository === undefined || repo.path === repository) &&
            this.repositoryOrigins.get(repo.path) === tree.origin,
        )?.path;
        if (localRepository)
          return { ...tree, host, codeFolder: inventory.codeFolder, localRepository };
      }
    }
    const saved = this.savedPlacements.get(worktree);
    if (
      saved &&
      (repository === undefined || saved.localRepository === repository) &&
      this.store
        .get()
        .registeredHosts?.some(
          (entry) => entry.host === saved.host && entry.codeFolder === saved.codeFolder,
        ) &&
      this.repositories().some((entry) => entry.path === saved.localRepository)
    )
      return saved;
    for (const [host, inventory] of this.sessionInventories) {
      const registration = this.registered(host);
      for (const session of inventory.own) {
        const context = session.context;
        const tree = session.checkout;
        if (
          !context ||
          (repository !== undefined && context.repository !== repository) ||
          !tree ||
          context.worktree !== worktree ||
          worktree !== `/foom-remote/${locationId(JSON.stringify([host, tree.path]))}` ||
          !this.repositories().some((repo) => repo.path === context.repository) ||
          !tree.path.startsWith(`${registration.codeFolder}/.foom-worktree-`) ||
          tree.path.slice(registration.codeFolder.length + 1).includes("/")
        )
          continue;
        return {
          host,
          codeFolder: registration.codeFolder,
          localRepository: context.repository,
          repository: tree.repository,
          path: tree.path,
          branch: context.branch ?? "HEAD",
          identity: tree.identity,
        };
      }
    }
    return undefined;
  }
  private readonly inventoryReads = new Map<string, Promise<HostResult>>();
  private readonly cancellation = new AbortController();
  dispose(): void {
    this.cancellation.abort();
  }
  private readonly observed = new Map<string, { at: number; revision: number; enabled: string }>();
  /** No timers: stale or absent observations are refreshed on demand. */
  async inventory(host: string): Promise<HostResult> {
    const registration = this.registered(host);
    const seen = this.observed.get(host);
    const enabled = JSON.stringify(this.store.get().agents);
    if (
      !seen ||
      Date.now() < seen.at ||
      Date.now() - seen.at >= 60000 ||
      seen.revision !== providerRevision() ||
      seen.enabled !== enabled ||
      !this.results.get(host)?.ok
    ) {
      let pending = this.inventoryReads.get(host);
      if (!pending) {
        // Explicit host checks can finish while this background read is in flight.
        const previous = this.results.get(host);
        const current = () => this.results.get(host) === previous;
        pending = this.run(
          host,
          {
            type: "manage",
            operation: "inspect",
            readOnly: true,
            codeFolder: registration.codeFolder,
          },
          { currentObservation: current },
        ).then((result) => {
          this.registered(host, registration.codeFolder);
          if (current()) this.results.set(host, result);
          return result;
        });
        this.inventoryReads.set(host, pending);
      }
      try {
        await pending;
      } finally {
        if (this.inventoryReads.get(host) === pending) this.inventoryReads.delete(host);
      }

      this.registered(host, registration.codeFolder);
    }
    return this.results.get(host) ?? { ok: false, reason: "unreachable" };
  }
  registered(host: string, folder?: string) {
    const entry = this.store.get().registeredHosts?.find((entry) => entry.host === host);
    if (!entry || (folder !== undefined && entry.codeFolder !== folder))
      throw new ControlError("not_found");
    return entry;
  }
  async requireAgent(host: string, agent: string): Promise<void> {
    if (this.store.get().agents[agent] === false) throw new LaunchFailure("agent_disabled");
    if (agentProviders().find((provider) => provider.id === agent)?.origin !== "bundled")
      throw new LaunchFailure("remote_agent_unsupported");
    const result = await this.inventory(host);
    if (!result.ok)
      throw new LaunchFailure(
        result.reason === "facts-unavailable"
          ? "remote_host_facts_unavailable"
          : result.reason === "libc-too-old"
            ? "remote_host_libc_too_old"
            : result.reason === "libc-unsupported"
              ? "remote_host_libc_unsupported"
              : result.reason === "unsupported"
                ? "remote_artifact_mismatch"
                : "remote_host_unreachable",
      );
    if (result.facts.agents.find((entry) => entry.id === agent)?.state !== "ready")
      throw new LaunchFailure("remote_agent_unavailable");
  }
  async fleet(refresh = true): Promise<readonly { host: string; result: HostResult }[]> {
    return Promise.all(
      (this.store.get().registeredHosts ?? []).map(async ({ host }) => ({
        host,
        result: refresh
          ? await this.inventory(host)
          : (this.results.get(host) ?? { ok: false, reason: "facts-unavailable" }),
      })),
    );
  }
  async worktree(
    host: string,
    repository: string,
    action:
      | { operation: "create-worktree"; branch: string; fromOrigin?: boolean }
      | {
          operation: "inspect-worktree" | "snapshot-worktree" | "remove-worktree";
          path: string;
          identity: string;
          changes?: string;
        },
  ) {
    const entry = this.registered(host);
    if (!this.profile) throw new LaunchFailure("remote_worktree_unavailable");
    if (!this.repositories().some((repo) => repo.path === repository))
      throw new ControlError("not_found");
    let sourcePath: string | undefined;
    if (action.operation === "create-worktree") {
      const source = await this.ensureRepository(host, entry.codeFolder, repository);
      this.registered(host, entry.codeFolder);
      if (!source.ok || !source.checkout || source.checkout.state === "absent")
        throw new LaunchFailure("remote_worktree_unavailable");
      sourcePath = source.checkout.path;
    }
    const origin = await this.origin(repository);
    this.registered(host, entry.codeFolder);
    // Existing-worktree management validates the clone and worktree together.
    // A separate repository connection repeats bootstrap and the same Git reads.
    const source =
      sourcePath ??
      `${entry.codeFolder}/repository-${createHash("sha256").update(origin).digest("hex").slice(0, 24)}`;
    try {
      const result = await this.run(host, {
        type: "manage",
        codeFolder: entry.codeFolder,
        directory: source.slice(entry.codeFolder.length + 1),
        origin,
        ...action,
        profile: this.profile,
      }).finally(() => {
        if (action.operation === "create-worktree" || action.operation === "remove-worktree")
          this.invalidateWorktrees(host);
      });
      this.registered(host, entry.codeFolder);
      if (!result.ok || !result.worktree) throw new LaunchFailure("remote_worktree_unavailable");
      if (
        action.operation === "create-worktree"
          ? result.worktree.branch !== action.branch
          : result.worktree.path !== action.path || result.worktree.identity !== action.identity
      )
        throw new LaunchFailure("remote_worktree_unavailable");
      if (
        !result.worktree.path.startsWith(`${entry.codeFolder}/.foom-worktree-`) ||
        result.worktree.path.slice(entry.codeFolder.length + 1).includes("/")
      )
        throw new LaunchFailure("remote_worktree_unavailable");
      if (action.operation === "snapshot-worktree") {
        if (
          !result.worktree.snapshot ||
          result.worktree.head !== result.worktree.snapshot.head ||
          result.worktree.origin !== origin ||
          (await this.origin(repository)) !== origin ||
          !this.repositories().some((repo) => repo.path === repository)
        )
          throw new LaunchFailure("remote_worktree_unavailable");
        this.registered(host, entry.codeFolder);
      }
      return { repository: source, ...result.worktree, sourceOrigin: origin };
    } catch (error) {
      // Preparation above can create only the repository clone. After worktree dispatch, a failed
      // reply may follow a partial creation or a failed final identity check.
      if (action.operation === "create-worktree") {
        // Reconcile by reading; never replay the mutation or release its charged slot.
        await this.readWorktrees(host, true).catch(() => []);
        throw new UncertainEffect();
      }
      throw error;
    }
  }
  /** Saved observations never authorize a host or change the selected local origin. */
  async inspectForge(tree: ForgeWorktree): Promise<ForgeInspection | undefined> {
    const binding = tree.remoteCheckout;
    if (!this.profile) return undefined;
    if (!binding) return undefined;
    this.registered(binding.host, binding.codeFolder);
    if ((await this.origin(tree.repository)) !== binding.origin) return undefined;
    if (!this.repositories().some((repo) => repo.path === tree.repository)) return undefined;
    const directory = `repository-${createHash("sha256").update(binding.origin).digest("hex").slice(0, 24)}`;
    if (binding.repository !== `${binding.codeFolder}/${directory}`) return undefined;
    const result = await this.run(binding.host, {
      type: "manage",
      codeFolder: binding.codeFolder,
      directory,
      origin: binding.origin,
      operation: "inspect-worktree",
      profile: this.profile,
      path: binding.path,
      identity: tree.identity,
    });
    this.registered(binding.host, binding.codeFolder);
    const current = result.ok ? result.worktree : undefined;
    if (
      (await this.origin(tree.repository)) !== binding.origin ||
      !this.repositories().some((repo) => repo.path === tree.repository) ||
      !current ||
      current.path !== binding.path ||
      current.identity !== tree.identity ||
      current.branch !== tree.branch ||
      current.origin !== binding.origin ||
      !current.head
    )
      return undefined;
    this.registered(binding.host, binding.codeFolder);
    return { remote: binding.origin, head: current.head };
  }
  copyValue(input: unknown): string {
    if (!input || typeof input !== "object" || Array.isArray(input) || !("kind" in input))
      throw new Error("Invalid host copy");
    if (input.kind === "copy-checkout-path") {
      if (
        Object.keys(input).length !== 3 ||
        Object.keys(input).some((key) => !["kind", "host", "repository"].includes(key)) ||
        !("repository" in input) ||
        !("host" in input)
      )
        throw new Error("Unknown repository");
      const repository = this.repositories().find((repo) => repo.path === input.repository);
      if (!repository) throw new Error("Unknown repository");
      if (input.host === null) return repository.path;
      if (typeof input.host !== "string") throw new Error("Invalid host");
      const registered = this.registered(input.host);
      const location = this.state().locations.find(
        (entry) => entry.repository === input.repository && entry.host === input.host,
      );
      const path = location?.result.ok ? location.result.checkout?.path : undefined;
      if (!path || !path.startsWith(`${registered.codeFolder}/`))
        throw new Error("Checkout unavailable");
      return path;
    }
    if (
      Object.keys(input).length !== 2 ||
      Object.keys(input).some((key) => !["kind", "host"].includes(key)) ||
      !("host" in input) ||
      typeof input.host !== "string"
    )
      throw new Error("Invalid host copy");
    const registered = this.registered(input.host);
    if (input.kind === "copy-host-alias") return registered.host;
    if (input.kind === "copy-host-ssh-command") return `ssh ${registered.host}`;
    if (input.kind === "copy-host-code-folder") return registered.codeFolder;
    throw new Error("Invalid host copy");
  }
  private readonly results = new Map<string, HostResult>();
  /** Display-only resource replies never seed the launch inventory. */
  private readonly resourceResults = new Map<string, HostResult>();
  private progress: HostCheckProgress | undefined;
  private output: HostOutput | undefined;
  private outputGeneration = 0;
  private appendOutput(text: string, startLine = false): void {
    if (this.output)
      this.output = {
        ...this.output,
        text: (
          this.output.text +
          (startLine && this.output.text && !this.output.text.endsWith("\n") ? "\n" : "") +
          text
        ).slice(-65536),
      };
  }
  private locations: RepositoryLocation[] = [];
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly store: Pick<SettingsStore, "get" | "update">,
    private readonly repositories: () => readonly Repository[],
    private readonly version: string,
    private readonly execute: (
      host: string,
      request: HostManagement,
      output?: (text: string, startLine?: boolean) => void,
    ) => Promise<HostResult> = (host, request, output) =>
      remoteManagement({ host }, version, request, this.cancellation.signal, output),
    private readonly profile?: string,
  ) {}
  private projectedResult(host: string, result = this.results.get(host)): HostResult | undefined {
    const inventory = this.sessionInventories.get(host);
    return result?.ok && inventory
      ? {
          ...result,
          facts: {
            ...result.facts,
            sessions:
              inventory.own.length +
              inventory.foreign.reduce((sum, entry) => sum + (entry.count ?? 1), 0),
          },
        }
      : result;
  }
  private sidebarLocations:
    | { at: number; repositories: string; read: Promise<HostsState> }
    | undefined;
  private repositorySignature(): string {
    return JSON.stringify(
      this.repositories()
        .map((repo) => repo.path)
        .sort(),
    );
  }
  locationsForSidebar(): Promise<HostsState> {
    const repositories = this.repositorySignature();
    if (
      !this.sidebarLocations ||
      this.sidebarLocations.repositories !== repositories ||
      Date.now() - this.sidebarLocations.at > 60_000
    ) {
      this.sidebarLocations = {
        at: Date.now(),
        repositories,
        read: this.action({ action: "locations" }),
      };
    }
    return this.sidebarLocations.read;
  }
  private readonly locationTimes = new WeakMap<RepositoryLocation, number>();
  private rememberLocation(location: RepositoryLocation, at: number): RepositoryLocation {
    this.locationTimes.set(location, at);
    return location;
  }
  private cacheHostLocations(state: HostsState, repositories: string) {
    let oldest = Date.now();
    for (const host of this.store.get().registeredHosts ?? [])
      for (const repo of this.repositories()) {
        const location = state.locations.find(
          (entry) => entry.host === host.host && entry.repository === repo.path,
        );
        const at = location && this.locationTimes.get(location);
        if (at === undefined) {
          this.sidebarLocations = undefined;
          return;
        }
        oldest = Math.min(oldest, at);
      }
    this.sidebarLocations = { at: oldest, repositories, read: Promise.resolve(state) };
  }
  async repositoryTarget(host: string, repository: string): Promise<RemoteTarget> {
    const registration = this.registered(host);
    if (!this.repositories().some((repo) => repo.path === repository))
      throw new ControlError("not_found");
    const result = await this.ensureRepository(host, registration.codeFolder, repository);
    if (!result.ok || !result.checkout || result.checkout.state === "absent")
      throw new LaunchFailure("remote_worktree_unavailable");
    const origin = await this.origin(repository);
    this.registered(host, registration.codeFolder);
    return {
      ...this.shellTarget(host),
      machine: {
        codeFolder: registration.codeFolder,
        repository: {
          directory: result.checkout.path.slice(registration.codeFolder.length + 1),
          origin,
        },
      },
    };
  }
  shellTarget(host: string): RemoteTarget {
    this.registered(host);
    if (!this.profile) throw new ControlError("not_found");
    return { host, profile: this.profile, human: true };
  }
  private recipe(
    host: string,
    tool: string,
    action: "install" | "sign-in" | "install-plugin",
    result: HostResult | undefined,
  ) {
    this.registered(host);
    const system = result?.ok ? result.facts.requirements : undefined;
    if (!hostRequirements(system) || system.distro === "unknown") return undefined;
    if (this.store.get().agents[tool] === false) return undefined;
    const model = bundledAgentData
      .map((data) => parseAgentManifest(JSON.stringify(data), "bundled").model)
      .find((model) => model.id === tool);
    return selectHostRecipe({ tool, action, distro: system.distro }, system, model?.hostSetup);
  }
  state(result?: HostResult, savedOnly = false): HostsState {
    return {
      hosts: (this.store.get().registeredHosts ?? []).map((host) => {
        const rowFailures = (this.pendingRows.get(host.host) ?? []).flatMap((row) =>
          row.reason ? [{ target: row.target, reason: row.reason }] : [],
        );
        // Saved facts provide presentation only; actions select from a fresh inspection below.
        const displayResult =
          (!savedOnly && this.results.get(host.host)) || host.observation?.preflight.result;
        const runtimeResult = savedOnly
          ? undefined
          : (this.resourceResults.get(host.host) ?? this.results.get(host.host));
        return {
          ...host,
          ...(this.hostKeyTrust ? { hostKeyTrust: this.hostKeyTrust } : {}),
          ...(rowFailures.length ? { rowFailures } : {}),
          ...(host.observation
            ? {
                result: host.observation.preflight.result,
                foreignSessions: host.observation.foreignSessions,
                foreignWorktrees: host.observation.foreignWorktrees,
              }
            : {}),
          recipes: [
            "git",
            "gh",
            ...agentProviders()
              .filter((provider) => this.store.get().agents[provider.id] !== false)
              .map((provider) => provider.id),
          ].map((tool) => ({
            tool,
            install: !!this.recipe(host.host, tool, "install", displayResult),
            signIn: !!this.recipe(host.host, tool, "sign-in", displayResult),
            ...(tool === "agy"
              ? { pluginInstall: !!this.recipe(host.host, tool, "install-plugin", displayResult) }
              : {}),
            ...(!this.recipe(host.host, tool, "install", displayResult)
              ? { installReason: "recipe-unavailable" as const }
              : {}),
          })),
          ...(!savedOnly && this.worktreeInventories.has(host.host)
            ? { foreignWorktrees: this.worktreeInventories.get(host.host)?.other ?? 0 }
            : {}),
          ...(!savedOnly && this.sessionInventories.has(host.host)
            ? {
                foreignSessions:
                  this.sessionInventories
                    .get(host.host)
                    ?.foreign.reduce((sum, entry) => sum + (entry.count ?? 1), 0) ?? 0,
              }
            : {}),
          ...(runtimeResult ? { result: this.projectedResult(host.host, runtimeResult) } : {}),
        };
      }),
      locations: this.locations.filter(
        (location) =>
          this.store.get().registeredHosts?.some((host) => host.host === location.host) &&
          this.repositories().some((repo) => repo.path === location.repository),
      ),
      ...(result ? { result } : {}),
      ...(this.progress ? { progress: this.progress } : {}),
      ...(this.output ? { output: this.output } : {}),
    };
  }
  private hostKeyTrust: "askpass" | "manual" | undefined;
  private readonly pendingRows = new Map<string, PendingHostRow[]>();
  private pendingRecipeRefreshes = 0;
  private queueRows(host: string, targets: readonly HostCheckTarget[]) {
    const rows = new Map(
      (this.pendingRows.get(host) ?? []).map((row) => [JSON.stringify(row.target), row]),
    );
    for (const target of targets) rows.set(JSON.stringify(target), { target });
    this.pendingRows.set(host, [...rows.values()]);
  }
  private registeredRow(host: string, target: HostCheckTarget) {
    const registration = this.registered(host);
    if (
      "repository" in target &&
      !this.repositories().some((repo) => repo.path === target.repository)
    )
      throw new HostRowUnavailable("Repository is not registered");
    if (
      "tool" in target &&
      ![
        "git",
        "gh",
        ...agentProviders()
          .filter((provider) => this.store.get().agents[provider.id] !== false)
          .map((provider) => provider.id),
      ].includes(target.tool)
    )
      throw new HostRowUnavailable("Tool is not enabled");
    return registration;
  }
  private async updateChecklist(host: string, change: (previous: HostPreflight) => HostPreflight) {
    const registration = this.registered(host);
    const previous = registration.observation?.preflight;
    const saved = previous ? change(previous) : undefined;
    if (saved)
      await this.updateRegistrations((hosts) =>
        hosts.map((entry) =>
          entry.host === host && entry.observation
            ? { ...entry, observation: { ...entry.observation, preflight: saved } }
            : entry,
        ),
      );
    let preflight = saved;
    // Update only the changed fields of an existing live inventory. Saved facts
    // never populate that cache, and a scoped read never renews its timestamp.
    const current = this.results.get(host);
    if (current) {
      const base: HostPreflight = previous ?? {
        ...(current.connection ?? {
          ssh: { state: "not-checked" },
          platform: { state: "not-checked" },
          artifact: { state: "not-checked" },
        }),
        repositories: [],
        result: current,
      };
      const updated = change({ ...base, result: current });
      if (!this.inventoryReads.has(host)) this.results.set(host, updated.result);
      // Return a transient display update even when enrollment has no saved
      // checklist. This neither saves an observation nor invents Last checked.
      preflight ??= updated;
    }
    return preflight;
  }
  private async reloadRow(
    host: string,
    target: HostCheckTarget,
    output = false,
  ): Promise<HostPreflight | undefined> {
    const registration = this.registeredRow(host, target);
    let result: HostResult;
    if ("repository" in target) {
      if (target.kind === "checkout") {
        result = await this.repository(host, registration.codeFolder, target.repository, false);
      } else {
        try {
          const origin = await this.origin(target.repository);
          result = await this.run(host, {
            type: "manage",
            operation: "origin",
            codeFolder: registration.codeFolder,
            origin,
            directory: `repository-${createHash("sha256").update(origin).digest("hex").slice(0, 24)}`,
          });
        } catch {
          result = { ok: false, reason: "origin-unavailable" };
        }
      }
    } else {
      result = await this.run(
        host,
        {
          type: "manage",
          operation: "inspect",
          readOnly: true,
          partial: true,
          codeFolder: registration.codeFolder,
          ...(target.kind === "tool" && !["git", "gh"].includes(target.tool)
            ? { agentDetails: true as const }
            : {}),
          target,
        },
        { output },
      );
    }
    if (
      (target.kind === "power" || target.kind === "command-line-tools") &&
      (!result.ok || !result.facts.requirements?.mac)
    )
      throw new HostRowUnavailable("Unable to check host row");
    const previous = registration.observation?.preflight;
    const displayed = previous?.result ?? this.results.get(host);
    const connectionRow = ["ssh", "platform", "artifact"].includes(target.kind);
    if (
      (!previous && (!displayed?.ok || "repository" in target)) ||
      ("repository" in target &&
        !previous?.repositories.some((repo) => repo.repository === target.repository)) ||
      (!connectionRow && !("repository" in target) && !displayed?.ok) ||
      ("tool" in target &&
        displayed?.ok &&
        ![...displayed.facts.agents, ...(displayed.facts.tools ?? [])].some(
          (entry) => entry.id === target.tool,
        )) ||
      ((target.kind === "power" || target.kind === "command-line-tools") &&
        displayed?.ok &&
        !displayed.facts.requirements?.mac)
    )
      throw new HostRowUnavailable("Unable to display host row without a full check");
    const check: HostCheck = result.ok
      ? { state: "pass" }
      : { state: "fail", reason: result.reason };
    const change = (previous: HostPreflight): HostPreflight => {
      if ("repository" in target)
        return {
          ...previous,
          repositories: previous.repositories.map((repo) =>
            repo.repository === target.repository
              ? {
                  ...repo,
                  ...(target.kind === "origin" ? { origin: check } : { checkout: result }),
                }
              : repo,
          ),
        };
      if (target.kind === "ssh") {
        const ssh = result.connection?.ssh ?? check;
        return {
          ...previous,
          ssh,
          result: {
            ...previous.result,
            connection: {
              ssh,
              platform: previous.platform,
              artifact: previous.artifact,
            },
          },
        };
      }
      if (target.kind === "platform" || target.kind === "artifact")
        return { ...previous, [target.kind]: result.connection?.[target.kind] ?? check };
      if (!previous.result.ok) return previous;
      const facts = previous.result.facts;
      const observed = result.ok ? result.facts : undefined;
      let next = facts;
      if (target.kind === "folder") next = folderObservation(facts, result);
      if (
        (target.kind === "command-line-tools" || target.kind === "power") &&
        facts.requirements?.mac &&
        observed?.requirements?.mac
      ) {
        const key = target.kind === "power" ? "staysAwake" : "commandLineTools";
        next = {
          ...facts,
          requirements: {
            ...facts.requirements,
            mac: { ...facts.requirements.mac, [key]: observed.requirements.mac[key] },
          },
        };
      }
      if ("tool" in target) {
        const merge = (items: HostFacts["agents"], observations: HostFacts["agents"]) =>
          items.map((item) => {
            if (item.id !== target.tool) return item;
            const found = observations.find((entry) => entry.id === target.tool);
            return target.kind === "sign-in"
              ? { ...item, signIn: found?.signIn ?? "unknown" }
              : {
                  ...item,
                  state: found?.state ?? "unable",
                  ...(found?.details ? { details: found.details } : {}),
                };
          });
        next = {
          ...facts,
          agents: merge(facts.agents, observed?.agents ?? []),
          ...(facts.tools
            ? {
                tools: facts.tools.map((item) => {
                  const found = observed?.tools?.find((entry) => entry.id === target.tool);
                  return item.id !== target.tool
                    ? item
                    : target.kind === "sign-in"
                      ? { ...item, signIn: found?.signIn ?? "unknown" }
                      : { ...item, state: found?.state ?? "unable" };
                }),
              }
            : {}),
        };
      }
      return { ...previous, result: { ...previous.result, facts: next } };
    };
    const save = () => {
      if (this.registeredRow(host, target).codeFolder !== registration.codeFolder)
        return Promise.reject(new HostRowUnavailable("Folder changed"));
      return this.updateChecklist(host, change);
    };
    try {
      return await save();
    } catch (error) {
      if (error instanceof HostRowUnavailable) throw error;
      throw new HostRowSaveFailed(save);
    }
  }
  private profilePending: Promise<void> = Promise.resolve();
  /** Re-read registrations after earlier profile writes, independently of remote checks. */
  private updateRegistrations(
    change: (hosts: readonly RegisteredHost[]) => readonly RegisteredHost[],
  ): Promise<void> {
    const work = this.profilePending
      .catch(() => undefined)
      .then(async () => {
        await this.store.update({
          registeredHosts: change(this.store.get().registeredHosts ?? []),
        });
      });
    this.profilePending = work;
    return work;
  }
  action(
    input: unknown,
    confirm?: (content: DialogContent, signal?: AbortSignal) => Promise<boolean>,
    launchRecipe?: (target: RemoteTarget, finished?: () => void) => Promise<unknown>,
    trustSignal?: AbortSignal,
  ): Promise<HostsState> {
    if (!hostsAction(input)) return Promise.reject(new Error("Invalid host action"));
    if (input.action === "cancel-trust") return Promise.resolve(this.state());
    if (input.action === "trust-host-key") {
      const host = input.host;
      const signal = trustSignal
        ? AbortSignal.any([this.cancellation.signal, trustSignal])
        : this.cancellation.signal;
      const work = this.pending
        .catch(() => undefined)
        .then(async () => {
          const registration = this.registered(host);
          const latest = this.results.get(host) ?? registration.observation?.preflight.result;
          const cancelled = () => signal.aborted;
          if (cancelled() || !unknownHostKey(latest) || !confirm) return false;
          const supported = await askpassSupported(undefined, signal);
          if (cancelled()) return false;
          this.hostKeyTrust = supported ? "askpass" : "manual";
          if (!supported) return false;
          this.registered(host, registration.codeFolder);
          return trustHostKey(host, (content, signal) => confirm(content, signal), signal);
        });
      this.pending = work;
      return work.then(async (accepted) => {
        const registration = this.registered(host);
        // Prior successes survive failed checks through lastAgents (#1061).
        const observation = registration.observation;
        if (
          accepted &&
          !signal.aborted &&
          !observation?.preflight.result.ok &&
          !observation?.lastAgents
        )
          return this.action({ action: "preflight", host, codeFolder: registration.codeFolder });
        return this.state();
      });
    }
    if (input.action === "dismiss-output") {
      if (!this.output?.running) this.output = undefined;
      return Promise.resolve(this.state());
    }
    if (input.action === "progress") return Promise.resolve(this.state());
    if (input.action === "list" && !this.pendingRows.size && !this.pendingRecipeRefreshes)
      return this.trustState(this.state(undefined, true), trustSignal);
    if (input.action === "rename")
      return this.updateRegistrations((hosts) => {
        this.registered(input.host);
        const error = hostNicknameError(hosts, input.host, input.nickname);
        if (error) throw new Error(error);
        return hosts.map((entry) => {
          if (entry.host !== input.host) return entry;
          const registration = { ...entry };
          delete registration.nickname;
          return input.nickname ? { ...registration, nickname: input.nickname } : registration;
        });
      }).then(() => this.state());
    if (
      [
        "add",
        "remove",
        "clone",
        "change-folder",
        "create-folder",
        "preflight",
        "locations",
      ].includes(input.action)
    )
      this.sidebarLocations = undefined;
    const showOutput = [
      "add",
      "test",
      "preflight",
      "draft-preflight",
      "reload",
      "refresh",
    ].includes(input.action);
    const work = this.pending
      .catch(() => undefined)
      .then(async () => {
        if (input.action === "recipe") this.output = undefined;
        if (showOutput && "host" in input) {
          this.outputGeneration++;
          this.output = { host: input.host, text: "", running: true, failed: false };
        }
        if (input.action === "list") {
          for (const [host, rows] of [...this.pendingRows]) {
            const retained: PendingHostRow[] = [];
            if (this.store.get().registeredHosts?.some((entry) => entry.host === host))
              for (const row of rows) {
                try {
                  this.registeredRow(host, row.target);
                  if (row.retry) await row.retry();
                  else await this.reloadRow(host, row.target);
                } catch (error) {
                  if (error instanceof HostRowUnavailable) continue;
                  if (error instanceof HostRowSaveFailed) row.retry = error.retry;
                  row.reason = row.retry ? "save-failed" : "check-failed";
                  retained.push(row);
                }
              }
            if (retained.length) this.pendingRows.set(host, retained);
            else this.pendingRows.delete(host);
          }
          return this.state(undefined, true);
        }
        if (input.action === "reload") {
          // Supersede any queued observation even when this reload cannot be saved.
          this.queueRows(input.host, [input.target]);
          const preflight = await this.reloadRow(input.host, input.target, true);
          const remaining = (this.pendingRows.get(input.host) ?? []).filter(
            (row) => JSON.stringify(row.target) !== JSON.stringify(input.target),
          );
          if (remaining.length) this.pendingRows.set(input.host, remaining);
          else this.pendingRows.delete(input.host);
          return { ...this.state(), ...(preflight ? { preflight } : {}) };
        }
        const hosts = this.store.get().registeredHosts ?? [];
        const repositories = this.repositorySignature();
        const observedAt = Date.now();
        if (input.action === "trust-origin") {
          const registration = this.registered(input.host);
          if (!this.repositories().some((repo) => repo.path === input.repository))
            throw new Error("Repository is not registered");
          const origin = await this.origin(input.repository);
          this.registered(input.host, registration.codeFolder);
          if (!originSshArgs(origin) || !launchRecipe || !this.profile)
            return { ...this.state(), recipeFailure: "recipe-unavailable" as const };
          await launchRecipe({
            host: input.host,
            profile: this.profile,
            human: true,
            trustOrigin: origin,
          });
          this.queueRows(input.host, [
            { kind: "origin", repository: input.repository },
            { kind: "checkout", repository: input.repository },
          ]);
          return this.state();
        }
        if (input.action === "recipe") {
          this.registered(input.host);
          if (
            input.operation === "install-plugin" &&
            !(await confirm?.({
              title: "Install Foom plugin on host?",
              accept: "Install plugin",
              subject: input.host,
              detail:
                "Stages Foom’s bundled Antigravity lifecycle plugin with foom-host --stage-plugin agy, then runs agy plugin install with the printed directory. The agy CLI changes its global plugin installation. Foom launches supply private lifecycle credentials; ordinary agy launches remain inert. This host uses screen rules without the plugin. Remove it with agy plugin uninstall foom.",
            }))
          )
            return this.state();
          const registration = this.registered(input.host);
          this.results.set(
            input.host,
            await this.run(input.host, {
              type: "manage",
              operation: "inspect",
              readOnly: true,
              partial: true,
              codeFolder: registration.codeFolder,
            }),
          );
          this.registered(input.host, registration.codeFolder);
          await this.expandRegistration(input.host);
          const recipe = this.recipe(
            input.host,
            input.tool,
            input.operation,
            this.results.get(input.host),
          );
          if (!recipe || !launchRecipe || !this.profile)
            return { ...this.state(), recipeFailure: "recipe-unavailable" as const };
          const targets: HostCheckTarget[] = [
            ...(["install", "install-plugin"].includes(input.operation)
              ? [{ kind: "tool" as const, tool: input.tool }]
              : []),
            ...(input.tool !== "git" ? [{ kind: "sign-in" as const, tool: input.tool }] : []),
          ];
          const recipeSession = await launchRecipe(
            {
              host: input.host,
              profile: this.profile,
              human: true,
              recipe: {
                tool: recipe.tool,
                action: recipe.action,
                distro: recipe.distro,
                digest: createHash("sha256").update(JSON.stringify(recipe.steps)).digest("hex"),
              },
            },
            () => {
              this.pendingRecipeRefreshes++;
              const queued = this.pending
                .catch(() => undefined)
                .then(() => {
                  this.queueRows(input.host, targets);
                })
                .finally(() => {
                  this.pendingRecipeRefreshes--;
                });
              this.pending = queued;
              void queued
                .then(() => this.action({ action: "list" }))
                .catch(() => {
                  console.warn("Recipe row refresh failed");
                });
            },
          );
          if (typeof recipeSession !== "string") this.queueRows(input.host, targets);
          return {
            ...this.state(),
            ...(input.operation === "install" && typeof recipeSession === "string"
              ? { recipeSession }
              : {}),
          };
        }
        if (input.action === "end") {
          const before = await this.readSessions(input.host);
          if (!before.foreign.length) return this.state();
          if (
            !(await confirm?.({
              title: "End remote sessions?",
              accept: "End sessions",
              glyph: "power",
              subject: input.host,
              detail: `Sessions from other profiles or without a profile tag: ${String(before.foreign.reduce((sum, entry) => sum + (entry.count ?? 1), 0))}. Ending them stops their processes.${before.foreign.some((entry) => entry.count !== undefined) ? " All sessions in the older host daemon will end, including any started before you confirm." : ""}`,
            }))
          )
            return this.state();
          this.registered(input.host);
          if (!this.profile) throw new Error("Profile unavailable");
          const result = await remoteInventory(
            { host: input.host },
            this.version,
            { type: "end-sessions", profile: this.profile, ids: before.foreign },
            this.cancellation.signal,
          );
          this.registered(input.host);
          this.sessionInventories.set(input.host, result);
          return this.state();
        }
        if (input.action === "preflight" || input.action === "draft-preflight") {
          const registration =
            input.action === "preflight"
              ? this.registered(input.host, input.codeFolder)
              : hosts.find((entry) => entry.host === input.host);
          if (registration && registration.codeFolder !== input.codeFolder)
            throw new Error("Folder changed");
          this.progress = {
            host: input.host,
            phase: "inspect",
            repositories: this.repositories().map((repo) => ({ repository: repo.path })),
          };
          try {
            const preflight = await this.preflight(input.host, input.codeFolder);
            if (registration) {
              this.resourceResults.delete(input.host);
              this.results.set(input.host, preflight.result);
              await this.expandRegistration(input.host);
              if (this.profile && preflight.result.ok) {
                await this.readSessions(input.host).catch(() => undefined);
                await this.readWorktrees(input.host, true);
              }
              const row = this.state().hosts.find((entry) => entry.host === input.host);
              await this.updateRegistrations((hosts) =>
                hosts.map((entry) =>
                  entry.host === input.host
                    ? {
                        ...entry,
                        observation: {
                          ...(!preflight.result.ok && entry.observation
                            ? {
                                lastAgents: entry.observation.preflight.result.ok
                                  ? {
                                      checkedAt: entry.observation.checkedAt,
                                      result: entry.observation.preflight.result,
                                    }
                                  : entry.observation.lastAgents,
                              }
                            : {}),
                          checkedAt: Date.now(),
                          preflight: { ...preflight, result: row?.result ?? preflight.result },
                          ...(row?.foreignSessions !== undefined
                            ? { foreignSessions: row.foreignSessions }
                            : {}),
                          ...(row?.foreignWorktrees !== undefined
                            ? { foreignWorktrees: row.foreignWorktrees }
                            : {}),
                        },
                      }
                    : entry,
                ),
              );
              this.pendingRows.delete(input.host);
            }
            this.progress = undefined;
            if (registration)
              this.locations = [
                ...this.locations.filter((entry) => entry.host !== input.host),
                ...preflight.repositories.map((repo) =>
                  this.rememberLocation(
                    {
                      host: input.host,
                      repository: repo.repository,
                      result: repo.checkout,
                    },
                    observedAt,
                  ),
                ),
              ];
            const state = { ...this.state(), preflight };
            if (registration) this.cacheHostLocations(state, repositories);
            return state;
          } finally {
            this.progress = undefined;
          }
        }
        if (input.action === "create-folder" || input.action === "change-folder") {
          const registration = this.registered(input.host);
          const codeFolder =
            input.action === "change-folder" ? input.codeFolder : registration.codeFolder;
          const result = await this.run(
            input.host,
            input.action === "create-folder"
              ? { type: "manage", operation: "create-folder", codeFolder }
              : {
                  type: "manage",
                  operation: "inspect",
                  readOnly: true,
                  partial: true,
                  codeFolder,
                  target: { kind: "folder" },
                },
          );
          if (result.ok) {
            await this.updateRegistrations((hosts) =>
              hosts.map((entry) =>
                entry.host === input.host
                  ? { ...entry, codeFolder: result.facts.codeFolder }
                  : entry,
              ),
            );
            this.locations = [
              ...this.locations.filter((entry) => entry.host !== input.host),
              ...this.repositories().map(
                (repo): RepositoryLocation => ({
                  host: input.host,
                  repository: repo.path,
                  result: { ok: true, facts: { ...result.facts, agents: [] } },
                }),
              ),
            ];
            this.invalidateWorktrees(input.host);
          }
          const preflight =
            result.ok || input.action === "create-folder"
              ? await this.updateChecklist(input.host, (previous) => ({
                  ...previous,
                  result: previous.result.ok
                    ? {
                        ...previous.result,
                        facts: {
                          ...folderObservation(previous.result.facts, result),
                          codeFolder: result.ok
                            ? result.facts.codeFolder
                            : previous.result.facts.codeFolder,
                        },
                      }
                    : previous.result,
                  repositories: result.ok
                    ? previous.repositories.map((repo) => ({
                        ...repo,
                        origin: { state: "not-checked" },
                        checkout: { ok: true, facts: { ...result.facts, agents: [] } },
                      }))
                    : previous.repositories,
                }))
              : undefined;
          const state = { ...this.state(result), ...(preflight ? { preflight } : {}) };
          this.cacheHostLocations(state, repositories);
          return state;
        }
        if (input.action === "add" || input.action === "test") {
          if (hosts.length >= 32 || hosts.some((host) => host.host === input.host))
            throw new Error("Host already registered or limit reached");
          const nickname = input.action === "add" ? (input.nickname ?? "") : "";
          const validateName = (hosts: readonly RegisteredHost[]) => {
            const error = hostNicknameError(hosts, input.host, nickname);
            if (error) throw new Error(error);
          };
          validateName(hosts);
          const result = await this.run(
            input.host,
            {
              type: "manage",
              operation: "inspect",
              readOnly: true,
              partial: true,
              codeFolder: input.codeFolder,
            },
            { output: true },
          );
          if (
            input.action === "add" &&
            !(
              !result.ok &&
              ["cancelled", "invalid-reply", "provider-invalid", "configuration-changed"].includes(
                result.reason,
              )
            )
          ) {
            await this.updateRegistrations((hosts) => {
              validateName(hosts);
              return [
                ...hosts,
                {
                  host: input.host,
                  codeFolder: result.ok ? result.facts.codeFolder : input.codeFolder,
                  ...(nickname ? { nickname } : {}),
                },
              ];
            });
            this.resourceResults.delete(input.host);
            this.results.set(input.host, result);
          }
          return this.state(result);
        }
        if (input.action === "locations") {
          this.locations = [];
          for (const repo of this.repositories())
            for (const host of hosts)
              this.locations.push(
                this.rememberLocation(
                  {
                    repository: repo.path,
                    host: host.host,
                    result: await this.repository(host.host, host.codeFolder, repo.path, false),
                  },
                  observedAt,
                ),
              );
          return this.state();
        }
        const host = hosts.find((entry) => entry.host === input.host);
        if (!host) throw new Error("Host is not registered");
        if (input.action === "remove") {
          // Forget only. Never send stop/kill or close a remote session connection.
          await this.updateRegistrations((hosts) =>
            hosts.filter((entry) => entry.host !== host.host),
          );
          this.locations = this.locations.filter((entry) => entry.host !== host.host);
          this.results.delete(host.host);
          this.resourceResults.delete(host.host);
          this.pendingRows.delete(host.host);
          this.sessionInventories.delete(host.host);
          this.invalidateWorktrees(host.host);
          for (const [path, entry] of this.savedPlacements)
            if (entry.host === host.host) this.savedPlacements.delete(path);
          return this.state();
        }
        if (input.action === "refresh") {
          if (this.profile) {
            await this.readSessions(host.host);
            await this.readWorktrees(host.host, true);
          }
          const result = await this.run(
            host.host,
            {
              type: "manage",
              operation: "inspect",
              readOnly: true,
              partial: true,
              target: { kind: "facts" },
              codeFolder: host.codeFolder,
            },
            { output: true },
          );
          const live = this.results.get(host.host);
          const previous = live ?? host.observation?.preflight.result;
          const refreshed: HostResult =
            result.ok && previous?.ok
              ? {
                  ...result,
                  facts: {
                    ...previous.facts,
                    version: result.facts.version,
                    sessions: result.facts.sessions,
                    cores: result.facts.cores,
                    load: result.facts.load,
                    memoryTotal: result.facts.memoryTotal,
                    memoryAvailable: result.facts.memoryAvailable,
                  },
                }
              : result;
          this.resourceResults.set(host.host, refreshed);
          if (result.ok && live?.ok && !this.inventoryReads.has(host.host))
            this.results.set(host.host, refreshed);
          await this.expandRegistration(host.host, result);
          return this.state();
        }
        if (!this.repositories().some((repo) => repo.path === input.repository))
          throw new Error("Repository is not registered");
        const result = await this.repository(host.host, host.codeFolder, input.repository, true);
        this.locations = this.locations.filter(
          (entry) => entry.host !== host.host || entry.repository !== input.repository,
        );
        this.locations.push(
          this.rememberLocation(
            { repository: input.repository, host: host.host, result },
            observedAt,
          ),
        );
        await this.updateChecklist(host.host, (previous) => ({
          ...previous,
          repositories: previous.repositories.map((repo) =>
            repo.repository === input.repository ? { ...repo, checkout: result } : repo,
          ),
        }));
        const state = this.state();
        this.cacheHostLocations(state, repositories);
        return state;
      })
      .finally(() => {
        if (showOutput && this.output) this.output = { ...this.output, running: false };
      })
      .then((state) => ({ ...state, ...(this.output ? { output: this.output } : {}) }));
    this.pending = work;
    return work.then((state) => this.trustState(state, trustSignal));
  }
  private async trustState(state: HostsState, signal?: AbortSignal): Promise<HostsState> {
    const cancellation = signal
      ? AbortSignal.any([this.cancellation.signal, signal])
      : this.cancellation.signal;
    const cancelled = () => cancellation.aborted;
    if (cancelled() || !state.hosts.some((row) => unknownHostKey(row.result))) return state;
    const supported = await askpassSupported(undefined, cancellation);
    if (cancelled()) return state;
    this.hostKeyTrust = supported ? "askpass" : "manual";
    return {
      ...state,
      hosts: state.hosts.map((row) => ({ ...row, hostKeyTrust: supported ? "askpass" : "manual" })),
    };
  }
  private async run(
    host: string,
    request: HostManagement,
    options: {
      currentObservation?: () => boolean;
      output?: boolean;
      beforeDispatch?: () => boolean;
    } = {},
  ): Promise<HostResult> {
    const currentObservation = options.currentObservation ?? (() => true);
    const failed = (
      reason: HostFailure,
      step: "providers" | "connection" | "reply" | "configuration" | "cancellation",
    ): HostResult => {
      if (
        options.output &&
        this.output?.running &&
        this.output.host === host &&
        !this.output.failed
      ) {
        this.output.failed = true;
        this.appendOutput(`Failed · ${reason}\n`, true);
      }
      console.warn(`Host check failed: reason=${reason} step=${step}`);
      return { ok: false, reason };
    };
    const cancelled = () => this.cancellation.signal.aborted;
    for (let attempt = 0; ; attempt++) {
      if (cancelled()) return failed("cancelled", "cancellation");
      const revision = providerRevision();
      const enabled = JSON.stringify(this.store.get().agents);
      const changed = () =>
        providerRevision() !== revision || JSON.stringify(this.store.get().agents) !== enabled;
      const providers = agentProviders().filter(
        (provider) => this.store.get().agents[provider.id] !== false,
      );
      try {
        for (const provider of providers) await provider.validate?.();
      } catch {
        if (cancelled()) return failed("cancelled", "cancellation");
        if (changed()) {
          if (request.operation === "inspect" && attempt === 0) continue;
          return failed("configuration-changed", "configuration");
        }
        return failed("provider-invalid", "providers");
      }
      if (cancelled()) return failed("cancelled", "cancellation");
      // Only inspection is safe to retry. Never replay a repository mutation.
      if (changed()) {
        if (request.operation === "inspect" && attempt === 0) continue;
        return failed("configuration-changed", "configuration");
      }
      const probes = providers.map((provider) => ({
        id: provider.id,
        executables: provider.executableNames,
      }));
      let result: unknown;
      // Provider preparation can await. Revoke stale mutation authority before dispatch.
      if (options.beforeDispatch?.() === false) return failed("checkout-refused", "configuration");
      try {
        const generation = this.outputGeneration;
        const output =
          options.output &&
          this.output?.running &&
          this.output.host === host &&
          request.operation === "inspect"
            ? (text: string, startLine = false) => {
                if (this.outputGeneration === generation) this.appendOutput(text, startLine);
              }
            : undefined;
        result = output
          ? await this.execute(host, { ...request, agents: probes }, output)
          : await this.execute(host, { ...request, agents: probes });
        if (output && hostResult(result)) {
          output(result.ok ? "Done\n" : `Failed · ${result.reason}\n`, true);
          if (this.output && !result.ok) this.output.failed = true;
        }
      } catch {
        return cancelled()
          ? failed("cancelled", "cancellation")
          : failed("unreachable", "connection");
      }
      if (cancelled()) return failed("cancelled", "cancellation");
      if (
        !hostResult(result) ||
        (result.ok &&
          request.codeFolder.startsWith("/") &&
          result.facts.codeFolder !== request.codeFolder)
      )
        return failed("invalid-reply", "reply");
      if (!result.ok)
        return {
          ...failed(result.reason, "connection"),
          ...(result.connection ? { connection: result.connection } : {}),
        };
      if (changed()) {
        if (request.operation === "inspect" && attempt === 0) continue;
        return failed("configuration-changed", "configuration");
      }
      if (request.operation === "inspect" && !request.target && currentObservation())
        this.observed.set(host, { at: Date.now(), revision, enabled });
      return {
        ...result,
        facts: {
          ...result.facts,
          agents: probes.map<HostFacts["agents"][number]>((probe) => {
            const found = result.facts.agents.find((agent) => agent.id === probe.id);
            return {
              id: probe.id,
              ...(found?.details ? { details: found.details } : {}),
              signIn:
                providers.find((provider) => provider.id === probe.id)?.origin === "bundled"
                  ? (result.facts.agents.find((agent) => agent.id === probe.id)?.signIn ??
                    "unknown")
                  : "unknown",
              state:
                providers.find((provider) => provider.id === probe.id)?.origin === "bundled"
                  ? (result.facts.agents.find((agent) => agent.id === probe.id)?.state ?? "unable")
                  : "unable",
            };
          }),
        },
      };
    }
  }
  private async expandRegistration(host: string, result = this.results.get(host)): Promise<void> {
    const registration = this.registered(host);
    if (!registration.codeFolder.startsWith("~/") || !result?.ok) return;
    await this.updateRegistrations((hosts) =>
      hosts.map((entry) =>
        entry.host === host ? { ...entry, codeFolder: result.facts.codeFolder } : entry,
      ),
    );
    this.locations = this.locations.filter((entry) => entry.host !== host);
    this.invalidateWorktrees(host);
  }
  private async preflight(host: string, codeFolder: string): Promise<HostPreflight> {
    const result = await this.run(
      host,
      {
        type: "manage",
        operation: "inspect",
        agentDetails: true,
        codeFolder,
        readOnly: true,
        partial: true,
      },
      { output: true },
    );
    const pass: HostCheck = { state: "pass" };
    const unknown: HostCheck = { state: "not-checked" };
    const fail = (reason: HostFailure): HostCheck => ({ state: "fail", reason });
    const reason = result.ok ? undefined : result.reason;
    const platformFailure =
      reason === "unsupported" || reason === "libc-too-old" || reason === "libc-unsupported";
    const requirements = result.ok ? result.facts.requirements : undefined;
    const platform: HostCheck = platformFailure
      ? fail(reason)
      : result.ok
        ? requirements?.libc === "too-old"
          ? fail("libc-too-old")
          : requirements?.libc === "unsupported"
            ? fail("libc-unsupported")
            : pass
        : unknown;
    const connection = {
      ssh:
        result.connection?.ssh ??
        (result.ok || platformFailure || reason === "facts-unavailable"
          ? pass
          : reason === "unreachable"
            ? fail(reason)
            : unknown),
      platform: result.connection?.platform ?? platform,
      artifact:
        result.connection?.artifact ??
        (result.ok ? pass : reason === "artifact-unavailable" ? fail(reason) : unknown),
    };
    const repositories: HostPreflight["repositories"][number][] = [];
    const planned = this.progress?.repositories ?? [];
    const update = (phase: "origin" | "checkout", repository: string, origin?: HostCheck) => {
      this.progress = {
        host,
        phase,
        repository,
        result: { ...result, connection },
        repositories: planned.map((repo) => {
          const completed = repositories.find((item) => item.repository === repo.repository);
          return (
            completed ?? (repo.repository === repository && origin ? { ...repo, origin } : repo)
          );
        }),
      };
    };
    for (const repo of planned) {
      update("origin", repo.repository);
      let origin: HostCheck;
      const git = result.ok ? result.facts.tools?.find((tool) => tool.id === "git") : undefined;
      try {
        if (git && git.state !== "ready") {
          update("checkout", repo.repository, unknown);
          repositories.push({
            repository: repo.repository,
            origin: unknown,
            checkout: await this.repository(
              host,
              result.ok ? result.facts.codeFolder : codeFolder,
              repo.repository,
              false,
            ),
          });
          continue;
        }
        const url = await this.origin(repo.repository);
        const access = await this.run(host, {
          type: "manage",
          operation: "origin",
          codeFolder,
          origin: url,
          directory: `repository-${createHash("sha256").update(url).digest("hex").slice(0, 24)}`,
        });
        origin = access.ok ? pass : fail(access.reason);
      } catch {
        origin = fail("origin-unavailable");
      }
      update("checkout", repo.repository, origin);
      const checkout = await this.repository(
        host,
        result.ok ? result.facts.codeFolder : codeFolder,
        repo.repository,
        false,
      );
      repositories.push({ repository: repo.repository, origin, checkout });
    }
    return { ...connection, result, repositories };
  }
  private async origin(repository: string): Promise<string> {
    try {
      const { path } = await loginPath();
      const { executable } = await resolveForgeExecutable(["git"], path);
      const result = await promisify(execFile)(
        executable,
        ["--no-optional-locks", "config", "--local", "--get", "remote.origin.url"],
        {
          cwd: repository,
          shell: false,
          timeout: 5000,
          maxBuffer: 4096,
          encoding: "utf8",
          env: {
            ...sshEnvironment(),
            PATH: path,
            GIT_CONFIG_GLOBAL: devNull,
            GIT_CONFIG_NOSYSTEM: "1",
          },
          signal: this.cancellation.signal,
        },
      );
      const origin = result.stdout.trim();
      if (!gitOrigin(origin)) throw new Error("Unsupported origin");
      this.repositoryOrigins.set(repository, origin);
      return origin;
    } catch {
      throw new Error("Origin unavailable");
    }
  }
  private readonly preparingRepositories = new Map<string, Promise<HostResult>>();
  private async ensureRepository(
    host: string,
    folder: string,
    repository: string,
  ): Promise<HostResult> {
    const origin = await this.origin(repository);
    this.registered(host, folder);
    const key = JSON.stringify([host, folder, origin]);
    let pending = this.preparingRepositories.get(key);
    if (!pending) {
      pending = this.repository(host, folder, repository, false)
        .then(async (result) => {
          if (!result.ok || result.checkout?.state !== "absent") return result;
          const currentOrigin = await this.origin(repository);
          this.registered(host, folder);
          if (
            !this.repositories().some((entry) => entry.path === repository) ||
            currentOrigin !== origin
          )
            throw new LaunchFailure("remote_worktree_unavailable");
          const cloned = await this.repository(host, folder, repository, true, origin);
          console.info(`Host clone attempt: reason=${cloned.ok ? "completed" : cloned.reason}`);
          return cloned;
        })
        .finally(() => {
          this.preparingRepositories.delete(key);
          this.sidebarLocations = undefined;
        });
      this.preparingRepositories.set(key, pending);
    }
    const result = await pending;
    const currentOrigin = await this.origin(repository);
    this.registered(host, folder);
    if (!this.repositories().some((entry) => entry.path === repository) || currentOrigin !== origin)
      throw new LaunchFailure("remote_worktree_unavailable");
    if (!result.ok)
      throw new LaunchFailure(
        isLaunchReason(result.reason) ? result.reason : "remote_worktree_unavailable",
      );
    return result;
  }
  private async repository(
    host: string,
    codeFolder: string,
    repository: string,
    clone: boolean,
    expectedOrigin?: string,
  ): Promise<HostResult> {
    let origin: string;
    try {
      origin = await this.origin(repository);
    } catch {
      return { ok: false, reason: "origin-unavailable" };
    }
    const authorized = () =>
      this.store
        .get()
        .registeredHosts?.some(
          (entry) => entry.host === host && entry.codeFolder === codeFolder,
        ) === true &&
      this.repositories().some((entry) => entry.path === repository) &&
      this.repositoryOrigins.get(repository) === origin &&
      (expectedOrigin === undefined || origin === expectedOrigin);
    if (clone && !authorized()) return { ok: false, reason: "checkout-refused" };
    const directory = `repository-${createHash("sha256").update(origin).digest("hex").slice(0, 24)}`;
    const result = await this.run(
      host,
      {
        type: "manage",
        operation: clone ? "clone" : "repository",
        codeFolder,
        origin,
        directory,
      },
      clone ? { beforeDispatch: authorized } : {},
    );
    if (result.ok && (!result.checkout || result.checkout.path !== `${codeFolder}/${directory}`))
      return { ok: false, reason: "checkout-refused" };
    return result;
  }
}

const services = new WeakMap<object, Hosts>();
export function hostsForStore(
  store: Pick<SettingsStore, "get" | "update"> & Partial<Pick<SettingsStore, "profileTag">>,
  repositories: () => readonly Repository[],
  version: string,
  onQuit?: (dispose: () => void) => void,
): Hosts {
  let hosts = services.get(store);
  if (!hosts) {
    hosts = new Hosts(store, repositories, version, undefined, store.profileTag?.());
    services.set(store, hosts);
    onQuit?.(hosts.dispose.bind(hosts));
  }
  return hosts;
}
