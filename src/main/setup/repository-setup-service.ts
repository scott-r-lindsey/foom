import { setupSelectedTools } from "../../shared/repository-setup-catalog";
import { selectedToolchainBins } from "../../node-common/repository-toolchain";
import { setupVersionMatches, setupCatalog } from "../../shared/repository-setup-catalog";
import { join } from "node:path";
import { homedir } from "node:os";
import { RepositorySetup } from "./repository-setup";
import type { SettingsStore } from "./settings";
import type { WorktreeService } from "../workspace/worktrees";
import type { Hosts } from "./hosts";
import { loginPath } from "../agents/agents";
import { inspectSetupSources } from "../../node-common/repository-setup-sources";
import {
  checkSetupList,
  repositorySetupEnvironment,
  setupProbeDependencies,
} from "../../node-common/repository-setup-check";
const services = new WeakMap<object, RepositorySetup>();
const prefixes = new WeakMap<object, string>();
export function repositorySetupFor(store: object): RepositorySetup {
  const service = services.get(store);
  if (!service) throw new Error("Repository setup unavailable");
  return service;
}
export function repositoryToolchainPrefix(store: object): string {
  const prefix = prefixes.get(store);
  if (!prefix) throw new Error("Repository toolchains unavailable");
  return prefix;
}
export async function openRepositorySetup(
  store: Pick<SettingsStore, "get">,
  profile: string,
  worktrees: Pick<
    WorktreeService,
    | "listRepositories"
    | "registrationIdentity"
    | "persistRegistrationIdentities"
    | "launchIdentity"
    | "listWorktrees"
    | "onRemoved"
  >,
  hosts: Pick<Hosts, "repositorySetup" | "onRemoved">,
): Promise<RepositorySetup> {
  const current = services.get(store);
  if (current) return current;
  const prefix = join(profile, "repository-setup", "toolchains");
  const service = await RepositorySetup.open(profile, {
    beforeApprove: () => worktrees.persistRegistrationIdentities(),
    repositories: () => worktrees.listRepositories(),
    identity: (repository) => worktrees.registrationIdentity(repository),
    hosts: () => store.get().registeredHosts ?? [],
    sources: async (repository, checkout, paths, host) => {
      if (host !== null) {
        const result = await hosts.repositorySetup(
          host,
          repository,
          { requirements: [], evidence: [] },
          paths,
          checkout,
        );
        return {
          ...(result.sources ? { sources: result.sources } : {}),
          root: result.root,
          checkout: result.sourcePath,
          head: result.head ?? "",
        };
      }
      const selected = checkout ?? repository;
      const identity = await worktrees.launchIdentity(repository, selected);
      const sources = await inspectSetupSources(selected, paths);
      const tree = (await worktrees.listWorktrees(repository)).find(
        (tree) => tree.path === selected,
      );
      if (!tree?.head || (await worktrees.launchIdentity(repository, selected)) !== identity)
        throw new Error("Checkout changed");
      return { sources, checkout: selected, head: tree.head };
    },
    bins: (list) =>
      selectedToolchainBins(
        prefix,
        list.requirements.flatMap((item) =>
          item.kind === "toolchain" &&
          setupVersionMatches(setupCatalog[item.tool].version, item.version)
            ? [item.tool]
            : [],
        ),
      ),
    check: async (host, list, checkout, repository) => {
      if (host !== null) {
        if (!repository) throw new Error("Repository required");
        return (await hosts.repositorySetup(host, repository, list, [], checkout)).check;
      }
      const login = await loginPath();
      const env = await repositorySetupEnvironment(
        { PATH: login.path },
        checkout,
        prefix,
        setupSelectedTools(list),
      );
      return checkSetupList(
        list,
        await setupProbeDependencies(env, homedir(), undefined, checkout),
      );
    },
  });
  services.set(store, service);
  prefixes.set(store, prefix);
  hosts.onRemoved((host) => service.forgetHost(host));
  worktrees.onRemoved((repository) => service.forgetRepository(repository));
  return service;
}
