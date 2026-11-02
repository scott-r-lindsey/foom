"use strict";
// A windowless disposable hub. Import only built production services; no GUI
// startup, config scanner, update checks, user profile or real agent discovery.
const { app } = require("electron");
const process = require("node:process");
const { setTimeout, clearTimeout } = require("node:timers");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const config = JSON.parse(readFileSync(process.env.FOOM_SMOKE_CONFIG, "utf8"));
app.setPath("userData", config.profile);
if (config.fixtureGuard)
  require(join(config.root, "tests/electron/agent-isolation.js")).guardAgentProbes(
    config.fixtureGuard.directories,
    config.fixtureGuard.log,
  );
const built = (name) => require(join(config.root, "build", name));
// Host origin lookup needs the current explicit PATH, not the user's shell rc.
// This adapter belongs only to this disposable driver process.
built("main/login-shell.js").readLoginShell = async () => ({
  stdout: `\0FOOM_PATH\0${process.env.PATH}\0`,
  stderr: "",
});
const { SettingsStore } = built("main/setup/settings.js");
const { Hosts } = built("main/setup/hosts.js");
const { agentProviders } = built("main/agents/providers/registry.js");
const { RemoteTransport, remoteInventory, remoteManagement } = built(
  "main/terminals/remote-transport.js",
);
const version = JSON.parse(readFileSync(join(config.root, "package.json"), "utf8")).version;
const transports = new Set();
let request = 0;
function ask(transport, id, message) {
  return new Promise((resolve, reject) => {
    const number = ++request;
    const timer = setTimeout(
      () => finish(new Error("request-timed-out")),
      message.type === "create" ? 125000 : 10000,
    );
    const receive = (reply) => {
      if (reply.request === number)
        finish(reply.type === "error" ? new Error("request-refused") : undefined, reply);
    };
    const exited = () => finish(new Error("transport-closed"));
    function finish(error, reply) {
      clearTimeout(timer);
      transport.off("message", receive);
      transport.off("exit", exited);
      if (error) reject(error);
      else resolve(reply);
    }
    transport.on("message", receive);
    transport.once("exit", exited);
    try {
      transport.postMessage({ ...message, id, request: number });
    } catch (error) {
      finish(error);
    }
  });
}
async function open(host, profile, id, tree, reattach = false, cleanup = false) {
  const transport = new RemoteTransport(
    {
      host,
      profile,
      ...(reattach ? { reattach: true } : {}),
      ...(cleanup ? { cleanup: true } : {}),
      ...(tree
        ? { checkout: { repository: tree.repository, path: tree.path, identity: tree.identity } }
        : {}),
    },
    version,
  );
  transports.add(transport);
  try {
    await ask(transport, id, {
      type: "create",
      spec: { command: "/bin/sh", args: [], cwd: "/", cols: 120, rows: 30 },
    });
    return transport;
  } catch (error) {
    transport.kill();
    throw error;
  }
}
async function tail(transport, id) {
  return (await ask(transport, id, { type: "tail", lines: 40 })).lines.join("\n");
}
async function until(read, pattern) {
  const deadline = Date.now() + 10000;
  do {
    const text = await read();
    if (pattern.test(text)) return text;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error("marker-missing");
}
globalThis.smokeHub = app.whenReady().then(async () => {
  const store = await SettingsStore.open(config.profile);
  await store.update({ agents: Object.fromEntries(agentProviders().map(({ id }) => [id, false])) });
  const profile = store.profileTag();
  const hosts = new Hosts(
    store,
    () => [{ path: config.repository, name: "smoke" }],
    version,
    undefined,
    profile,
  );
  const action = (action, extra = {}) => hosts.action({ action, host: config.host, ...extra });
  const inventory = (tag = profile) =>
    remoteInventory({ host: config.host }, version, { type: "inventory", profile: tag });
  return {
    preflight: async ({ codeFolder }) => (await action("preflight", { codeFolder })).preflight,
    enroll: async ({ codeFolder }) => (await action("add", { codeFolder })).result,
    clone: async () =>
      (await action("clone", { repository: config.repository })).locations.find(
        (location) => location.host === config.host && location.repository === config.repository,
      )?.result,
    worktree: async ({ branch }) =>
      hosts.worktree(config.host, config.repository, { operation: "create-worktree", branch }),
    launch: async ({ id, marker, tree }) => {
      const transport = await open(config.host, profile, id, tree);
      // Fixed POSIX fixture: no files or agent executables. The shell PID and
      // live challenge survive disconnect; echoed input cannot satisfy either.
      const program = `printf '${marker}:%s\\n' "$$"; while IFS= read -r line; do case "$line" in ping) printf 'PONG:%s\\n' "$$";; esac; done`;
      await ask(transport, id, {
        type: "write",
        data: `exec /bin/sh -c '${program.replaceAll("'", "'\\''")}'\r`,
      });
      return until(() => tail(transport, id), new RegExp(`(?:^|\\n)${marker}:\\d+\\r?(?:\\n|$)`));
    },
    verify: async ({ id, marker, pid, tree }) => {
      assert.ok((await inventory()).own.some((session) => session.id === id));
      const transport = await open(config.host, profile, id, tree, true);
      assert.match(await tail(transport, id), new RegExp(`(?:^|\\n)${marker}:${pid}\\r?(?:\\n|$)`));
      await ask(transport, id, { type: "write", data: "ping\r" });
      await until(() => tail(transport, id), new RegExp(`(?:^|\\n)PONG:${pid}\\r?(?:\\n|$)`));
    },
    foreign: async ({ foreignId }) => {
      const otherProfile = randomBytes(16).toString("hex");
      const transport = await open(config.host, otherProfile, foreignId);
      transport.kill();
      const before = await inventory();
      assert.ok(!before.own.some((session) => session.id === foreignId));
      const foreign = before.foreign.find(
        (session) => session.id === foreignId && session.count === undefined,
      );
      assert.ok(foreign);
      // Only the newly created fixture incarnation, never the user's foreign or legacy sessions.
      await remoteInventory({ host: config.host }, version, {
        type: "end-sessions",
        profile,
        ids: [foreign],
      });
      const after = await inventory();
      assert.ok(!after.foreign.some((session) => session.id === foreignId));
      assert.deepEqual(after.own, before.own);
    },
    cleanup: async ({ id, foreignId, tree, branch, creating, launching }) => {
      if (!store.get().registeredHosts?.some(({ host }) => host === config.host)) return;
      const failures = [];
      const attempt = async (work) => {
        try {
          await work();
        } catch {
          failures.push(true);
        }
      };
      // Inventory also reconciles a lost create reply; never replay creation.
      if (launching)
        await attempt(async () => {
          const sessions = await inventory();
          for (const session of sessions.own.filter((session) => session.id === id)) {
            const transport = await open(config.host, profile, session.id, undefined, false, true);
            transport.kill();
          }
          const foreign = sessions.foreign.filter(
            (session) => session.id === foreignId && session.count === undefined,
          );
          if (foreign.length)
            await remoteInventory({ host: config.host }, version, {
              type: "end-sessions",
              profile,
              ids: foreign,
            });
        });
      await attempt(async () => {
        const trees = tree ? [tree] : [];
        if (!tree && creating) {
          const registration = store
            .get()
            .registeredHosts?.find(({ host }) => host === config.host);
          assert.ok(registration);
          const result = await remoteManagement({ host: config.host }, version, {
            type: "manage",
            operation: "list-worktrees",
            codeFolder: registration.codeFolder,
            profile,
          });
          if (!result.ok || !result.inventory) throw new Error("cleanup-failed");
          trees.push(...result.inventory.own.filter((entry) => entry.branch === branch));
        }
        for (const entry of trees) {
          const current = await hosts.worktree(config.host, config.repository, {
            operation: "inspect-worktree",
            path: entry.path,
            identity: entry.identity,
          });
          if (current.changes !== "") throw new Error("checkout-refused");
          await hosts.worktree(config.host, config.repository, {
            operation: "remove-worktree",
            path: entry.path,
            identity: entry.identity,
            changes: "",
          });
        }
      });
      await attempt(() => action("remove"));
      if (failures.length) throw new Error("cleanup-failed");
    },
    dispose: () => {
      for (const transport of transports) transport.kill();
      hosts.dispose();
    },
  };
});
