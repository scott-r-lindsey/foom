import { createTerminalView } from "../terminal/terminal-view-source";
import type { SetupSource } from "./setup-source.d";

export function createSetupSource(
  createView = createTerminalView,
  closeSession?: (id: string) => Promise<void>,
): SetupSource {
  const desktop = window.desktop;
  const installs = new Map<string, string>();
  const launches = new Set<Promise<unknown>>();
  const exited = new Set<string>();
  const earlyExits = new Set<string>();
  let offExit: (() => void) | undefined;
  const dispose = () => {
    offExit?.();
    offExit = undefined;
    earlyExits.clear();
  };
  const releaseObserver = () => {
    if (!installs.size && !launches.size) dispose();
  };
  let closing = false;
  let launchVersion = 0;
  const settled = async () => {
    while (launches.size) await Promise.allSettled([...launches]);
  };
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
    installs: {
      dispose,
      sessions: () => new Map([...installs].map(([id, host]) => [host, id])),
      hasSessions: () => installs.size > 0 || launches.size > 0,
      running: async () => {
        for (;;) {
          await settled();
          const version = launchVersion;
          const snapshot = await desktop.workspace();
          if (version !== launchVersion) continue;
          return snapshot.terminals.some(
            (row) => installs.has(row.id) && !row.exited && !exited.has(row.id),
          );
        }
      },
      close: async () => {
        closing = true;
        try {
          await settled();
          const snapshot = await desktop.workspace();
          for (const id of installs.keys()) {
            if (snapshot.terminals.some((row) => row.id === id))
              await (closeSession?.(id) ?? desktop.kill(id));
            installs.delete(id);
            exited.delete(id);
          }
          releaseObserver();
        } finally {
          closing = false;
        }
      },
    },
    copyHost: (command) => desktop.copyHost(command),
    hosts: (action) => {
      if (action.action !== "recipe" || action.operation !== "install")
        return desktop.hosts(action);
      if (closing) return Promise.reject(new Error("Settings is closing"));
      launchVersion++;
      offExit ??= desktop.onExit((id) => {
        if (installs.has(id)) exited.add(id);
        else {
          earlyExits.add(id);
          if (earlyExits.size > 256) {
            const oldest = earlyExits.values().next().value;
            if (oldest !== undefined) earlyExits.delete(oldest);
          }
        }
      });
      const work = desktop.hosts(action).then((state) => {
        if (state.recipeSession) {
          installs.set(state.recipeSession, action.host);
          if (earlyExits.delete(state.recipeSession)) exited.add(state.recipeSession);
        }
        return state;
      });
      launches.add(work);
      return work.finally(() => {
        launches.delete(work);
        releaseObserver();
      });
    },
    checkReadiness: () => desktop.checkReadiness(),
    listTerminalFonts: (refresh) => desktop.listTerminalFonts(refresh),
    openThemesFolder: (kind) => desktop.openThemesFolder(kind),
    restartToUpdate: () => desktop.restartToUpdate(),
    state: () => desktop.setupState(),
    save: (patch) => desktop.saveSetup(patch),
    changeAgentSetup: (id, action) => desktop.changeAgentSetup(id, action),
    changeAgyPlugin: (action) => desktop.changeAgyPlugin(action),
    scanAgents: (refresh, agent) =>
      agent === undefined ? desktop.scanAgents(refresh) : desktop.scanAgents(refresh, agent),
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
