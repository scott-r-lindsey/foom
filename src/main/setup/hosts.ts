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
  private readonly cancellation = new AbortController();
  dispose(): void {
    this.cancellation.abort();
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
  private async repository(
    host: string,
    codeFolder: string,
    repository: string,
    clone: boolean,
  ): Promise<HostResult> {
    let origin: string;
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
      origin = result.stdout.trim();
      if (!gitOrigin(origin)) throw new Error("Unsupported origin");
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
