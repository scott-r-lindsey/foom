const { existsSync } = require("node:fs");
const { mkdir, mkdtemp, writeFile } = require("node:fs/promises");
const { execFileSync, spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { tmpdir, userInfo } = require("node:os");
const path = require("node:path");
const { fixtureCleanup, removeAfterApps } = require("./harness.js");

// The explicit #1059 real-client regression uses only a loopback sshd and its
// disposable keys/config. Authentication is disabled: no user shell ever starts.
async function realSshFixture(context) {
  const sshd = ["/usr/sbin/sshd", "/usr/local/sbin/sshd"].find(existsSync);
  if (
    process.platform === "win32" ||
    !sshd ||
    !existsSync("/usr/bin/ssh") ||
    !existsSync("/usr/bin/ssh-keygen")
  ) {
    context.skip("Disposable OpenSSH sshd fixture unavailable");
    return undefined;
  }
  const root = await mkdtemp(path.join(tmpdir(), "foom-real-ssh-"));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const key = path.join(root, "host-key");
  execFileSync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  const reserve = createServer();
  await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const config = path.join(root, "sshd_config");
  await writeFile(
    config,
    `ListenAddress 127.0.0.1\nPort ${port}\nHostKey ${key}\nPidFile ${root}/pid\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication no\nAuthorizedKeysFile none\nUseDNS no\n`,
  );
  const knownHosts = path.join(root, "known_hosts");
  await writeFile(knownHosts, "");
  const client = path.join(root, "client_config");
  await writeFile(
    client,
    `Host loopback-fixture\n HostName 127.0.0.1\n Port ${port}\n User ${userInfo().username}\n UserKnownHostsFile ${knownHosts}\n GlobalKnownHostsFile /dev/null\n IdentityFile none\n IdentityAgent none\n CheckHostIP no\n`,
  );
  // Only this wrapper selects real SSH, always with our explicit client config.
  await writeFile(path.join(bin, "ssh"), `#!/bin/sh\nexec /usr/bin/ssh -F '${client}' "$@"\n`, {
    mode: 0o700,
  });
  const daemon = spawn(sshd, ["-D", "-e", "-f", config], { stdio: ["ignore", "ignore", "pipe"] });
  let diagnostics = "";
  daemon.stderr.on("data", (bytes) => {
    diagnostics = (diagnostics + bytes).slice(-4096);
  });
  fixtureCleanup(context).apps.push(async () => {
    if (daemon.exitCode !== null || daemon.signalCode !== null) return;
    const exited = new Promise((resolve) => daemon.once("exit", resolve));
    daemon.kill();
    await exited;
  });
  const available = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    const done = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    daemon.on("error", () => done(false));
    daemon.on("exit", () => done(false));
    daemon.stderr.on("data", () => {
      if (diagnostics.includes("Server listening")) done(true);
    });
  });
  if (!available) {
    context.skip("Disposable unprivileged sshd cannot listen on this runner");
    return undefined;
  }
  return { bin, knownHosts, port };
}
module.exports = { realSshFixture };
