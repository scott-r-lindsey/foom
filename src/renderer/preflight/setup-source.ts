import type { SetupSource } from "./setup-source.d";

export function createSetupSource(): SetupSource {
  const desktop = window.desktop;
  return {
    openThemesFolder: (kind) => desktop.openThemesFolder(kind),
    state: () => desktop.setupState(),
    save: (patch) => desktop.saveSetup(patch),
    changeAgyPlugin: (action) => desktop.changeAgyPlugin(action),
    scanAgents: (refresh) => desktop.scanAgents(refresh),
    repositories: async () => (await desktop.workspace()).repositories,
    subscribe: (listener) => desktop.onSetupChange(listener),
    suggestions: () => desktop.codeSuggestions(),
    scan: (id, folder, onProgress) => desktop.scanCode(id, folder, onProgress),
    apply: (selected) => desktop.applyRepositories(selected),
  };
}
