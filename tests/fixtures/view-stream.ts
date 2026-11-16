import type { DataView, DataViewApi, DataViews } from "../../src/shared/data-views";
import { setupState } from "./setup";
import type { SetupState } from "../../src/shared/setup";

export function viewStream(initial: SetupState = setupState()) {
  const data: DataViews = {
    settings: initial,
    hosts: { hosts: [], locations: [] },
    agents: { warning: null, agents: [] },
    repositories: [],
    worktrees: [],
    sessions: [],
    environment: {
      lists: { all: [], claude: [], codex: [], agy: [] },
      windows: false,
      secrets: true,
    },
    config: { folder: "/config", available: true, pending: null, rejected: [] },
    fonts: [],
    sounds: [],
    readiness: { git: "ready", platform: "linux", forges: [] },
  };
  let revision = 0;
  const errors = new Set<DataView>();
  const deliveries = new Map<DataView, Set<() => void>>();
  const api: DataViewApi = {
    subscribeView(view, params, receive) {
      let active = true;
      const deliver = () => {
        if (!active) return;
        const base = { id: view, view, params, generation: 1, revision: ++revision };
        receive(
          errors.has(view) ? { ...base, error: "unavailable" } : { ...base, data: data[view] },
        );
      };
      const listeners = deliveries.get(view) ?? new Set<() => void>();
      deliveries.set(view, listeners);
      listeners.add(deliver);
      queueMicrotask(deliver);
      return () => {
        active = false;
        listeners.delete(deliver);
      };
    },
  };
  return {
    api,
    data,
    errors,
    push: (view: DataView) => {
      for (const deliver of deliveries.get(view) ?? []) deliver();
    },
  };
}
