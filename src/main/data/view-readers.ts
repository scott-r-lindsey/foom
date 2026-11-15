import type { DataViews } from "../../shared/data-views";
import type { ViewReader } from "./view-registry";

export interface ViewOwners {
  settings: () => DataViews["settings"] | Promise<DataViews["settings"]>;
  hosts: () => DataViews["hosts"];
  prepareHosts?: () => Promise<void>;
  agents: () => Promise<DataViews["agents"]>;
  repositories: () => DataViews["repositories"];
  worktrees: (repository: string) => Promise<DataViews["worktrees"]>;
  sessions: () => DataViews["sessions"];
  environment: () => DataViews["environment"];
  config: () => DataViews["config"];
  fonts: () => Promise<DataViews["fonts"]>;
  sounds: () => Promise<DataViews["sounds"]>;
  readiness: () => Promise<DataViews["readiness"]>;
}
/** Owners retain authorization and effects. A subscription cannot probe a remote machine. */
export function createViewReader(owners: ViewOwners): ViewReader {
  return (view, params) => {
    switch (view) {
      case "settings":
        return owners.settings();
      case "hosts":
        return owners.prepareHosts?.().then(owners.hosts) ?? owners.hosts();
      case "agents": {
        if (!params.machine || params.machine === "local") return owners.agents();
        const row = owners.hosts().hosts.find((entry) => `host:${entry.host}` === params.machine);
        if (!row) throw new Error("Unknown machine");
        const observed = row.result ?? row.observation?.lastAgents?.result;
        return {
          warning: null,
          agents: observed?.ok
            ? observed.facts.agents.map((agent) => ({
                id: agent.id,
                path: agent.details?.path ?? null,
                version: agent.details?.version ?? null,
                hooks: false,
                reason: agent.state,
              }))
            : [],
          machine: { hosts: [row], locations: [] },
        };
      }
      case "repositories":
        return owners.repositories();
      case "worktrees": {
        if (
          !params.repository ||
          !owners.repositories().some((entry) => entry.path === params.repository)
        )
          throw new Error("Unknown repository");
        return owners.worktrees(params.repository);
      }
      case "sessions":
        return owners.sessions();
      case "environment":
        return owners.environment();
      case "config":
        return owners.config();
      case "fonts":
        return owners.fonts();
      case "sounds":
        return owners.sounds();
      case "readiness":
        return owners.readiness();
    }
  };
}
