const { createRequire } = require("node:module");
const path = require("node:path");

function install(entry, { holdDiscovery, failChildChecks, holdShell, holdAgent, failShutdown }) {
  const load = createRequire(path.join(entry, "package.json"));
  const { Workspace } = load("./build/main/workspace/workspace.js");
  const restart = Workspace.prototype.restartSaved;
  const state = { captured: [], completed: false, failedChecks: [] };
  globalThis.restoreFixture = state;
  Workspace.prototype.restartSaved = function () {
    const work = restart.call(this);
    void work.then(
      () => {
        state.completed = true;
      },
      () => {
        state.completed = true;
      },
    );
    return work;
  };
  if (holdDiscovery) {
    const { Hosts } = load("./build/main/setup/hosts.js");
    const sessions = Hosts.prototype.sessions;
    const gate = new Promise((resolve) => {
      state.release = resolve;
    });
    Hosts.prototype.sessions = async function () {
      const rows = await sessions.call(this);
      state.captured = rows.map(({ session }) => session.id).sort();
      state.discoveryWaiting = true;
      await gate;
      return rows;
    };
  }
  if (holdShell) {
    const launches = load("./build/main/workspace/worktree-launch.js");
    const shellEnvironment = launches.shellEnvironment;
    let shells = 0;
    const gate = new Promise((resolve) => {
      state.releaseShell = resolve;
    });
    launches.shellEnvironment = async function (...args) {
      const held = ++shells === holdShell;
      if (held) {
        state.shellWaiting = true;
        await gate;
      }
      const environment = await shellEnvironment.apply(this, args);
      if (held) state.shellPrepared = true;
      return environment;
    };
  }
  if (holdAgent) {
    const { AgentService } = load("./build/main/agents/agents.js");
    const { SessionOwner } = load("./build/main/workspace/session-owner.js");
    const launch = AgentService.prototype.launch;
    const spawnPause = SessionOwner.prototype.restoreSpawnPause;
    const gate = new Promise((resolve) => {
      state.releaseAgent = resolve;
    });
    AgentService.prototype.launch = function (request) {
      if (request.terminalId !== holdAgent) return launch.call(this, request);
      return launch.call(this, {
        ...request,
        prepareSpawn: async () => {
          await request.prepareSpawn?.();
          state.agentPrepared = true;
          await gate;
        },
      });
    };
    SessionOwner.prototype.restoreSpawnPause = function (id) {
      const pause = spawnPause.call(this, id);
      if (id === holdAgent && pause) state.agentPaused = true;
      return pause;
    };
  }
  if (failShutdown) {
    const { dialog } = require("electron");
    const { TerminalHostClient } = load("./build/main/terminals/terminal-host-client.js");
    const create = TerminalHostClient.prototype.create;
    state.spawns = [];
    TerminalHostClient.prototype.create = function (spec) {
      state.spawns.push(spec.id);
      return create.call(this, spec);
    };
    const shutdown = TerminalHostClient.prototype.shutdown;
    TerminalHostClient.prototype.shutdown = function () {
      if (state.shutdownWaiting) return shutdown.call(this);
      state.shutdownWaiting = true;
      return new Promise((_, reject) => {
        state.failShutdown = () => reject(new Error("Fixture shutdown failure"));
      });
    };
    dialog.showErrorBox = () => {
      state.quitFailed = true;
    };
  }
  if (failChildChecks) {
    const { WorktreeService } = load("./build/main/workspace/worktrees.js");
    const launchIdentity = WorktreeService.prototype.launchIdentity;
    WorktreeService.prototype.launchIdentity = function (repository, worktree) {
      if (failChildChecks.includes(worktree) && !state.failedChecks.includes(worktree)) {
        state.failedChecks.push(worktree);
        return Promise.reject(
          Object.assign(new Error("Fixture inspection timed out"), { killed: true }),
        );
      }
      return launchIdentity.call(this, repository, worktree);
    };
  }
}

module.exports = { install };
