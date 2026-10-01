import type { SetupSource } from "./setup-source.d";

export function createSetupSource(): SetupSource {
  const desktop = window.desktop;
  return {
    state: () => desktop.setupState(),
    save: (patch) => desktop.saveSetup(patch),
    setKey: (provider, key) => desktop.setInferenceKey(provider, key),
    removeKey: (provider) => desktop.removeInferenceKey(provider),
    check: (id, config, timeoutMs, onUpdate) =>
      desktop.checkInference(id, config, timeoutMs, onUpdate),
    cancel: (id) => desktop.cancelInferenceCheck(id),
    models: (endpoint) => desktop.localModels(endpoint),
    scanAgents: (refresh) => desktop.scanAgents(refresh),
    repositories: async () => (await desktop.workspace()).repositories,
    subscribe: (listener) => desktop.onSetupChange(listener),
    suggestions: () => desktop.codeSuggestions(),
    scan: (id, folder, onProgress) => desktop.scanCode(id, folder, onProgress),
    apply: (selected) => desktop.applyRepositories(selected),
  };
}
