import type { ForgeWorktree, ForgeInspection } from "../control/forge.d";
import { ControlError } from "../../shared/control-validation";
import { UncertainEffect } from "../workspace/worktree-outcome";
import { LaunchFailure } from "../../shared/launch-failure";
import { providerRevision } from "../agents/providers/registry";
import { loginPath } from "../agents/agents";
import { resolveForgeExecutable } from "../control/forge-process";
import { agentProviders } from "../agents/providers/registry";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { devNull } from "node:os";
import { hostsAction, gitOrigin, hostResult } from "../../shared/registered-hosts";
import type {
  HostManagement,
  HostFacts,
  HostResult,
  HostsState,
  RepositoryLocation,
} from "../../shared/registered-hosts.d";
import type { SettingsStore } from "./settings";
import type { Repository } from "../../shared/worktrees";
import { remoteManagement } from "../terminals/remote-transport";
import { sshEnvironment } from "../terminals/remote-bootstrap";

/** Profile-owned registrations only. Developer mappings never enter this service. */
export class Hosts {
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
        pending = this.run(host, {
          type: "manage",
          operation: "inspect",
          codeFolder: registration.codeFolder,
        });
        this.inventoryReads.set(host, pending);
      }
      let result: HostResult;
      try {
        result = await pending;
      } finally {
        if (this.inventoryReads.get(host) === pending) this.inventoryReads.delete(host);
      }

      this.registered(host, registration.codeFolder);
      this.results.set(host, result);
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
    const result = await this.inventory(host);
    if (!result.ok) throw new LaunchFailure("remote_host_unreachable");
    if (result.facts.agents.find((entry) => entry.id === agent)?.state !== "ready")
      throw new LaunchFailure("remote_agent_unavailable");
  }
  async fleet(): Promise<readonly { host: string; result: HostResult }[]> {
    return Promise.all(
      (this.store.get().registeredHosts ?? []).map(async ({ host }) => ({
        host,
        result: await this.inventory(host),
      })),
    );
  }
  async worktree(
    host: string,
    repository: string,
    action:
      | { operation: "create-worktree"; branch: string; fromOrigin?: boolean }
      | {
          operation: "inspect-worktree" | "remove-worktree";
          path: string;
          identity: string;
          changes?: string;
        },
  ) {
    const entry = this.registered(host);
    if (!this.repositories().some((repo) => repo.path === repository))
      throw new ControlError("not_found");
    const source = await this.repository(host, entry.codeFolder, repository, false);
    this.registered(host, entry.codeFolder);
    if (!source.ok || !source.checkout || source.checkout.state === "absent")
      throw new LaunchFailure("remote_worktree_unavailable");
    const origin = await this.origin(repository);
    this.registered(host, entry.codeFolder);
    try {
      const result = await this.run(host, {
        type: "manage",
        codeFolder: entry.codeFolder,
        directory: source.checkout.path.slice(entry.codeFolder.length + 1),
        origin,
        ...action,
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
      return { repository: source.checkout.path, ...result.worktree, sourceOrigin: origin };
    } catch (error) {
      // Preflight above cannot create a checkout. After dispatch, even a failed
      // reply may follow a partial creation or a failed final identity check.
      if (action.operation === "create-worktree") throw new UncertainEffect();
      throw error;
    }
  }
  /** Saved observations never authorize a host or change the selected local origin. */
  async inspectForge(tree: ForgeWorktree): Promise<ForgeInspection | undefined> {
    const binding = tree.remoteCheckout;
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
  private readonly results = new Map<string, HostResult>();
  private locations: RepositoryLocation[] = [];
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly store: Pick<SettingsStore, "get" | "update">,
    private readonly repositories: () => readonly Repository[],
    version: string,
    private readonly execute: (host: string, request: HostManagement) => Promise<HostResult> = (
      host,
      request,
    ) => remoteManagement({ host }, version, request, this.cancellation.signal),
  ) {}
  state(result?: HostResult): HostsState {
    return {
      hosts: (this.store.get().registeredHosts ?? []).map((host) => ({
        ...host,
        ...(this.results.get(host.host) ? { result: this.results.get(host.host) } : {}),
      })),
      locations: this.locations.filter(
        (location) =>
          this.store.get().registeredHosts?.some((host) => host.host === location.host) &&
          this.repositories().some((repo) => repo.path === location.repository),
      ),
      ...(result ? { result } : {}),
    };
  }
  action(input: unknown): Promise<HostsState> {
    if (!hostsAction(input)) return Promise.reject(new Error("Invalid host action"));
    const work = this.pending
      .catch(() => undefined)
      .then(async () => {
        const hosts = this.store.get().registeredHosts ?? [];
        if (input.action === "list") {
          for (const host of hosts)
            if (!this.results.has(host.host))
              this.results.set(
                host.host,
                await this.run(host.host, {
                  type: "manage",
                  operation: "inspect",
                  codeFolder: host.codeFolder,
                }),
              );
          return this.state();
        }
        if (input.action === "add" || input.action === "test") {
          if (hosts.length >= 32 || hosts.some((host) => host.host === input.host))
            throw new Error("Host already registered or limit reached");
          const result = await this.run(input.host, {
            type: "manage",
            operation: "inspect",
            codeFolder: input.codeFolder,
          });
          if (result.ok && input.action === "add") {
            await this.store.update({
              registeredHosts: [
                ...hosts,
                { host: input.host, codeFolder: result.facts.codeFolder },
              ],
            });
            this.results.set(input.host, result);
          }
          return this.state(result);
        }
        if (input.action === "locations") {
          this.locations = [];
          for (const repo of this.repositories())
            for (const host of hosts)
              this.locations.push({
                repository: repo.path,
                host: host.host,
                result: await this.repository(host.host, host.codeFolder, repo.path, false),
              });
          return this.state();
        }
        const host = hosts.find((entry) => entry.host === input.host);
        if (!host) throw new Error("Host is not registered");
        if (input.action === "remove") {
          // Forget only. Never send stop/kill or close a remote session connection.
          await this.store.update({
            registeredHosts: hosts.filter((entry) => entry.host !== host.host),
          });
          this.results.delete(host.host);
          return this.state();
        }
        if (input.action === "refresh") {
          this.results.set(
            host.host,
            await this.run(host.host, {
              type: "manage",
              operation: "inspect",
              codeFolder: host.codeFolder,
            }),
          );
          return this.state();
        }
        if (!this.repositories().some((repo) => repo.path === input.repository))
          throw new Error("Repository is not registered");
        const result = await this.repository(host.host, host.codeFolder, input.repository, true);
        this.locations = this.locations.filter(
          (entry) => entry.host !== host.host || entry.repository !== input.repository,
        );
        this.locations.push({ repository: input.repository, host: host.host, result });
        return this.state();
      });
    this.pending = work;
    return work;
  }
  private async run(host: string, request: HostManagement): Promise<HostResult> {
    try {
      const revision = providerRevision();
      const enabled = JSON.stringify(this.store.get().agents);
      const providers = agentProviders().filter(
        (provider) => this.store.get().agents[provider.id] !== false,
      );
      for (const provider of providers) await provider.validate?.();
      const probes = providers.map((provider) => ({
        id: provider.id,
        executables: provider.executableNames,
      }));
      const result: unknown = await this.execute(host, {
        ...request,
        agents: probes,
      });
      if (
        !hostResult(result) ||
        (result.ok &&
          request.codeFolder.startsWith("/") &&
          result.facts.codeFolder !== request.codeFolder)
      )
        return { ok: false, reason: "unreachable" };
      if (!result.ok) return result;
      if (providerRevision() !== revision || JSON.stringify(this.store.get().agents) !== enabled)
        return { ok: false, reason: "unreachable" };
      if (request.operation === "inspect")
        this.observed.set(host, {
          at: Date.now(),
          revision,
          enabled,
        });
      return {
        ...result,
        facts: {
          ...result.facts,
          agents: probes.map<HostFacts["agents"][number]>((probe) => ({
            id: probe.id,
            state: result.facts.agents.find((agent) => agent.id === probe.id)?.state ?? "unable",
          })),
        },
      };
    } catch {
      return { ok: false, reason: "unreachable" };
    }
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
      return origin;
    } catch {
      throw new Error("Origin unavailable");
    }
  }
  private async repository(
    host: string,
    codeFolder: string,
    repository: string,
    clone: boolean,
  ): Promise<HostResult> {
    let origin: string;
    try {
      origin = await this.origin(repository);
    } catch {
      return { ok: false, reason: "origin-unavailable" };
    }
    const directory = `repository-${createHash("sha256").update(origin).digest("hex").slice(0, 24)}`;
    const result = await this.run(host, {
      type: "manage",
      operation: clone ? "clone" : "repository",
      codeFolder,
      origin,
      directory,
    });
    if (result.ok && (!result.checkout || result.checkout.path !== `${codeFolder}/${directory}`))
      return { ok: false, reason: "checkout-refused" };
    return result;
  }
}

const services = new WeakMap<object, Hosts>();
export function hostsForStore(
  store: Pick<SettingsStore, "get" | "update">,
  repositories: () => readonly Repository[],
  version: string,
  onQuit?: (dispose: () => void) => void,
): Hosts {
  let hosts = services.get(store);
  if (!hosts) {
    hosts = new Hosts(store, repositories, version);
    services.set(store, hosts);
    onQuit?.(hosts.dispose.bind(hosts));
  }
  return hosts;
}
