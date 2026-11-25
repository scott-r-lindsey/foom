const { createRequire } = require("node:module");
const path = require("node:path");

function install(entry, { holdDiscovery, failChildChecks }) {
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
      await gate;
      return rows;
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
