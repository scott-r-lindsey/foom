const path = require("node:path");

/** Hold a stale daemon reply across the real workspace IPC Close and save. */
function deferRestoreDaemonInventory(appPath) {
  const { Hosts } = require(path.join(appPath, "build/main/setup/hosts.js"));
  const { TerminalHostClient } = require(
    path.join(appPath, "build/main/terminals/terminal-host-client.js"),
  );
  const inventory = Promise.withResolvers();
  const fixture = { requested: false, closed: false, release: inventory.resolve };
  globalThis.restoreDaemon = fixture;
  Hosts.prototype.sessions = () => {
    fixture.requested = true;
    return inventory.promise;
  };
  Hosts.prototype.fleet = async () => [];
  const kill = TerminalHostClient.prototype.kill;
  TerminalHostClient.prototype.kill = function (id, host, profile) {
    if (id === "remote-saved" && host === "fixture-host") {
      fixture.closed = true;
      return Promise.resolve();
    }
    return kill.call(this, id, host, profile);
  };
}

module.exports = { deferRestoreDaemonInventory };
