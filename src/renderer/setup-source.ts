import type { SetupSource } from "./setup-source.d";

export function createSetupSource(): SetupSource {
  const desktop = window.desktop;
  return {
    state: () => desktop.setupState(),
    save: (patch) => desktop.saveSetup(patch),
    setKey: (provider, key) => desktop.setInferenceKey(provider, key),
    removeKey: (provider) => desktop.removeInferenceKey(provider),
    check: (config) => desktop.checkInference(config),
    scanAgents: (refresh) => desktop.scanAgents(refresh),
    repositories: async () => (await desktop.workspace()).repositories,
    addRepository: () => desktop.addRepository(),
  };
}
