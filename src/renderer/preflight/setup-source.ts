import { createTerminalView } from "../terminal/terminal-view-source";
import type { SetupSource } from "./setup-source.d";

export function createSetupSource(createView = createTerminalView): SetupSource {
  const desktop = window.desktop;
  return {
    hostTerminal: {
      createView: () => createView(),
      observe: (id, listener) => {
        let active = true;
        let generation = 0;
        let ended = false;
        const refresh = async () => {
          const current = ++generation;
          const snapshot = await desktop.workspace().catch(() => undefined);
          if (!active || ended || current !== generation) return;
          const row = snapshot?.terminals.find((row) => row.id === id);
          if (row)
            listener({
              exited: row.exited === true,
              ...(row.exitCode === undefined ? {} : { code: row.exitCode }),
            });
        };
        const off = desktop.onWorkspaceChange(() => {
          void refresh();
        });
        const offExit = desktop.onExit((exitedId, code) => {
          if (exitedId !== id || !active) return;
          ended = true;
          generation++;
          listener({ exited: true, code });
        });
        void refresh();
        return () => {
          active = false;
          off();
          offExit();
        };
      },
    },
    copyHost: (command) => desktop.copyHost(command),
    hosts: (action) => desktop.hosts(action),
    checkReadiness: () => desktop.checkReadiness(),
    listTerminalFonts: (refresh) => desktop.listTerminalFonts(refresh),
    openThemesFolder: (kind) => desktop.openThemesFolder(kind),
    restartToUpdate: () => desktop.restartToUpdate(),
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
      status: () => desktop.configStatus(),
      decide: (decision, id) => desktop.decideConfig(decision, id),
      openFolder: () => desktop.openConfigFolder(),
      subscribe: (listener) => desktop.onConfigChange(listener),
    },
  };
}
