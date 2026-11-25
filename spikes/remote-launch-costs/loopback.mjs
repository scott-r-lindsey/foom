// Isolated OpenSSH transport for the manual Linux launch-cost profile.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";

export async function loopback(out, home, bin, trace) {
  const dir = await mkdtemp(join(out, "ssh-"));
  const port = Number(process.env.FOOM_COST_SSH_PORT ?? "41398");
  const { username, homedir } = userInfo();
  assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
  const env = { HOME: home, PATH: "/usr/bin:/bin", LANG: "C" };
  const pidFile = join(dir, "sshd.pid");
  let server;
  let closed;
  let pid;
  const stop = async () => {
    try {
      if (pid) process.kill(pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    } finally {
      if (server?.pid && !pid) server.kill("SIGTERM");
      if (closed) await closed;
      await rm(dir, { recursive: true, force: true });
      await rm(join(home, "profile-authorized"), { force: true });
    }
    if (pid) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    console.log("Private sshd exited and throwaway keys were removed");
  };
  try {
    const ssh = "/usr/bin/ssh";
    for (const name of ["host", "client"]) {
      execFileSync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(dir, name)], {
        env,
      });
    }
    await writeFile(join(home, "profile-authorized"), await readFile(join(dir, "client.pub")), {
      mode: 0o600,
    });
    const [keyType, key] = (await readFile(join(dir, "host.pub"), "utf8")).split(" ");
    await writeFile(join(dir, "known"), `[127.0.0.1]:${port} ${keyType} ${key}\n`);
    const config = join(dir, "client.conf");
    await writeFile(config, `Host 127.0.0.1
  Port ${port}
  User ${username}
  UserKnownHostsFile ${dir}/known
  GlobalKnownHostsFile none
  IdentityFile ${dir}/client
  IdentitiesOnly yes
  IdentityAgent none
  ForwardAgent no
  ControlMaster no
  ControlPath none
  BatchMode yes
  StrictHostKeyChecking yes
`);
    const wrapper = join(home, "remote-command");
    await writeFile(wrapper, `#!/bin/sh
export HOME='${home}' PATH='${bin}' SHELL='${bin}/fixture-shell' LANG=C
cd "$HOME" || exit
exec /bin/sh -c "$SSH_ORIGINAL_COMMAND"
`, { mode: 0o700 });
    await writeFile(join(dir, "server.conf"), `Port ${port}
ListenAddress 127.0.0.1
AddressFamily inet
HostKey /tmp/profile/host
AuthorizedKeysFile profile-authorized
PidFile /tmp/profile/sshd.pid
UsePAM no
AuthenticationMethods publickey
PasswordAuthentication no
KbdInteractiveAuthentication no
DisableForwarding yes
PermitUserRC no
PermitTTY no
ForceCommand ${wrapper}
`);
    // Mask the OS account home before sshd resolves its login shell or key files.
    // The relay also sees the same short private HOME as the existing daemon.
    server = spawn("/usr/bin/bwrap", [
      "--ro-bind", "/", "/", "--dev", "/dev", "--tmpfs", "/tmp",
      "--bind", dir, "/tmp/profile", "--bind", home, home, "--bind", home, homedir,
      "--die-with-parent", "--", "/usr/sbin/sshd", "-D", "-e", "-f", "/tmp/profile/server.conf",
    ], { env, stdio: ["ignore", "ignore", "pipe"] });
    closed = once(server, "close");
    let diagnostics = "";
    server.stderr.setEncoding("utf8").on("data", (data) => { diagnostics += data; });
    const deadline = Date.now() + 5000;
    while (!diagnostics.includes("Server listening on 127.0.0.1")) {
      assert.ok(server.exitCode === null && Date.now() < deadline, diagnostics);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    pid = Number(await readFile(pidFile, "utf8"));
    assert.ok(Number.isSafeInteger(pid) && pid > 1);

    // Timestamp the client authentication line. The controlled remote command
    // emits only bootstrap hash and connector timing lines on stderr.
    const sshPath = join(bin, "ssh");
    await writeFile(sshPath, `#!${process.execPath}
const { spawn } = require("node:child_process");
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
const end = args.indexOf("--");
if (end < 0 || args[end + 1] !== "127.0.0.1") process.exit(2);
const preflight = args[0] === "-E";
const diagnostic = preflight ? args[1] : null;
if (preflight) {
  if (args[2] !== "-o" || args[3] !== "LogLevel=ERROR") process.exit(2);
  args.splice(0, 4);
}
function mark(stage) {
  appendFileSync(${JSON.stringify(trace)}, JSON.stringify({stage, at: performance.timeOrigin + performance.now()}) + "\\n");
}
const phase = preflight ? "preflight" : "bootstrap";
mark(phase + "-ssh-start");
const child = spawn(${JSON.stringify(ssh)}, ["-F", ${JSON.stringify(config)}, "-v", ...args],
  { stdio: ["inherit", "inherit", "pipe"] });
let pending = "", debug = "";
child.stderr.setEncoding("utf8").on("data", chunk => {
  debug += chunk;
  pending += chunk;
  let newline;
  while ((newline = pending.indexOf("\\n")) >= 0) {
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    if (line.startsWith("Authenticated to 127.0.0.1 ") && line.includes("publickey"))
      mark(phase + "-ssh-authenticated");
    if (/^(HASH_|\{)/.test(line)) process.stderr.write(line + "\\n");
  }
});
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
  child.kill("SIGTERM");
});
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("close", (code, signal) => {
  if (code && diagnostic) appendFileSync(diagnostic, debug);
  if (code && !diagnostic && !stopping) process.stderr.write(debug);
  process.exitCode = code ?? (signal === "SIGTERM" ? 0 : 1);
});
`, { mode: 0o700 });
    return stop;
  } catch (error) {
    await stop();
    throw error;
  }
}
