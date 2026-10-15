import type { SetupSource } from "./setup-source.d";

export function createSetupSource(): SetupSource {
  const desktop = window.desktop;
  return {
    listTerminalFonts: (refresh) => desktop.listTerminalFonts(refresh),
    openThemesFolder: (kind) => desktop.openThemesFolder(kind),
    state: () => desktop.setupState(),
    save: (patch) => desktop.saveSetup(patch),
    changeAgentSetup: (id, action) => desktop.changeAgentSetup(id, action),
    changeAgyPlugin: (action) => desktop.changeAgyPlugin(action),
    scanAgents: (refresh) => desktop.scanAgents(refresh),
    repositories: async () => (await desktop.workspace()).repositories,
    subscribe: (listener) => desktop.onSetupChange(listener),
    suggestions: () => desktop.codeSuggestions(),
    scan: (id, folder, onProgress) => desktop.scanCode(id, folder, onProgress),
    apply: (selected) => desktop.applyRepositories(selected),
    environment: {
      environmentState: () => desktop.environmentState(),
      saveEnvironment: (change) => desktop.saveEnvironment(change),
      removeEnvironment: (scope, name) => desktop.removeEnvironment(scope, name),
      readShellEnvironment: () => desktop.readShellEnvironment(),
      importEnvironment: (names) => desktop.importEnvironment(names),
    },
    config: {
      duplicateAgent: (id) => desktop.duplicateAgent(id),
      status: () => desktop.configStatus(),
      decide: (decision, id) => desktop.decideConfig(decision, id),
      revert: (commit) => desktop.revertConfig(commit),
      openFolder: () => desktop.openConfigFolder(),
      subscribe: (listener) => desktop.onConfigChange(listener),
    },
  };
}
