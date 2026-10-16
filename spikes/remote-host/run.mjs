// All measurements are synthetic. Docker changes occur only inside a disposable container.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  chmodSync,
  rmSync,
  existsSync,
  readdirSync,
  readlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";
import headless from "@xterm/headless";
const { Terminal } = headless;
const dest = resolve(process.argv[2] || "/tmp/remote-results.json");
const lab = mkdtempSync(join(tmpdir(), "foom-remote."));
const name = `foom-remote-${randomBytes(5).toString("hex")}`;
const cleanEnv = { PATH: "/usr/bin:/bin", HOME: lab }; // SSH never sees the user's environment/config/agent.
const exec = (exe, args, options = {}) => execFileSync(exe, args, { encoding: "utf8", ...options });
const docker = (args) => exec("/usr/bin/docker", args);
const children = new Set();
let container = false;
const results = {
  date: new Date().toISOString(),
  node: process.version,
  herdr: "0.9.3",
  transport: "OpenSSH loopback Docker; compression disabled",
  measurements: [],
  relay: [],
  fidelity: [],
};
let fatal;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    fatal = Error(signal);
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(predicate, label, timeout = 15000) {
  const start = performance.now();
  while (!predicate()) {
    if (fatal) throw fatal;
    if (performance.now() - start > timeout) throw Error(`timeout: ${label}`);
    await sleep(5);
  }
}
function home(root) {
  mkdirSync(`${root}/home/.config/herdr`, { recursive: true, mode: 0o700 });
  writeFileSync(`${root}/fixture-shell`, `#!/bin/sh\nexec ${root}/foom-host fixture\n`, {
    mode: 0o700,
  });
  writeFileSync(
    `${root}/home/.config/herdr/config.toml`,
    `onboarding = false\n[terminal]\ndefault_shell = "${root}/fixture-shell"\n`,
  );
}
function start(exe, args, env) {
  const p = spawn(exe, args, { env, cwd: lab, stdio: ["pipe", "pipe", "pipe"] });
  children.add(p);
  p.on("error", (error) => {
    fatal = error;
  });
  p.on("exit", () => children.delete(p));
  return p;
}
class Client {
  constructor(p, adapter) {
    this.p = p;
    this.adapter = adapter;
    this.rid = 0;
    this.pending = new Map();
    this.text = new Map();
    this.raw = new Map();
    this.screens = new Map();
    this.bytes = 0;
    this.stderr = "";
    this.tokens = {
      control: randomBytes(32).toString("hex"),
      hook: randomBytes(32).toString("hex"),
    };
    this.revoked = false;
    p.stderr.on("data", (d) => {
      this.stderr = (this.stderr + d).slice(-2000);
    });
    createInterface({ input: p.stdout }).on("line", (l) => {
      let m;
      try {
        m = JSON.parse(l);
      } catch {
        fatal = Error("truncated transport frame");
        return;
      }
      if (m.rid) {
        const q = this.pending.get(m.rid);
        this.pending.delete(m.rid);
        m.error ? q?.reject(Error(m.error)) : q?.resolve(m.result);
      } else if (m.event === "data") {
        this.bytes += Buffer.byteLength(m.data);
        this.raw.set(m.id, (this.raw.get(m.id) || "") + m.data);
        if (this.raw.get(m.id).length > 100000)
          this.raw.set(m.id, this.raw.get(m.id).slice(-100000));
        let t = this.screens.get(m.id);
        if (!t) {
          t = new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
          this.screens.set(m.id, t);
        }
        t.write(m.data, () => {
          let text = "";
          for (let i = Math.max(0, t.buffer.active.length - 60); i < t.buffer.active.length; i++)
            text += t.buffer.active.getLine(i).translateToString(true) + "\n";
          this.text.set(m.id, text);
        });
      } else if (m.event === "relay") {
        const result = this.validate(m);
        this.send({ op: "relay-result", id: m.id, result });
      }
    });
    p.on("exit", () => {
      for (const q of this.pending.values()) q.reject(Error(`transport exited: ${this.stderr}`));
    });
  }
  validate(m) {
    // Deliberately local-only fixture policy. This is NOT a test of Foom's production validators.
    const valid = (token, expected) =>
      typeof token === "string" &&
      token.length === expected.length &&
      timingSafeEqual(Buffer.from(token), Buffer.from(expected));
    let result;
    if (this.revoked || !valid(m.token, this.tokens[m.kind === "hook" ? "hook" : "control"]))
      result = { error: "unauthorized" };
    else if (m.kind === "hook") result = { result: { observed: true, authorized: false } };
    else if (m.body.method === "initialize")
      result = {
        jsonrpc: "2.0",
        id: m.body.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture-local-validator", version: "1" },
        },
      };
    else if (
      m.body.method === "tools/call" &&
      m.body.params?.name === "whoami" &&
      Object.keys(m.body.params.arguments || {}).length === 0
    )
      result = {
        jsonrpc: "2.0",
        id: m.body.id,
        result: { content: [{ type: "text", text: "agent" }] },
      };
    else result = { jsonrpc: "2.0", id: m.body.id, error: { code: -32602, message: "denied" } };
    results.relay.push({
      adapter: this.adapter,
      kind: m.kind,
      method: m.body.method || m.body.event,
      outcome: result.error ? "denied" : "accepted",
      revoked: this.revoked,
    });
    return result;
  }
  send(m) {
    this.p.stdin.write(JSON.stringify(m) + "\n");
  }
  call(m) {
    return new Promise((resolve, reject) => {
      const rid = ++this.rid;
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(Error(`request timeout ${m.op}: ${this.stderr}`));
      }, 15000);
      this.pending.set(rid, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send({ ...m, rid });
    });
  }
  async close() {
    this.p.kill("SIGKILL");
    await wait(() => this.p.exitCode !== null || this.p.signalCode !== null, "transport exit");
    for (const t of this.screens.values()) t.dispose();
  }
}
let sshArgs;
function client(adapter, remote) {
  return new Client(
    remote
      ? start("/usr/bin/ssh", sshArgs, cleanEnv)
      : start(`${lab}/local/foom-host`, [], {
          ...cleanEnv,
          LAB: `${lab}/local`,
          HOME: `${lab}/local/home`,
        }),
    adapter,
  );
}
function cells(t) {
  const b = t.buffer.active;
  return {
    cursor: [b.cursorX, b.cursorY],
    type: b.type,
    rows: Array.from({ length: t.rows }, (_, y) =>
      Array.from({ length: t.cols }, (_, x) => {
        const c = b.getLine(b.baseY + y).getCell(x);
        return [
          c.getChars(),
          c.getWidth(),
          c.getFgColorMode(),
          c.getFgColor(),
          c.getBgColorMode(),
          c.getBgColor(),
          c.isBold(),
          c.isItalic(),
          c.isUnderline(),
        ];
      }),
    ),
  };
}
try {
  console.error("Building SEA in scratch prefix");
  exec(process.execPath, ["spikes/remote-host/build.mjs", lab]);
  results.sea = JSON.parse(readFileSync(`${lab}/size.json`));
  if (process.env.SPIKE_HERDR_ARCHIVE)
    copyFileSync(process.env.SPIKE_HERDR_ARCHIVE, `${lab}/herdr`);
  else {
    exec("gh", [
      "release",
      "download",
      "v0.9.3",
      "--repo",
      "herdrdev/herdr",
      "--pattern",
      "herdr-linux-x86_64",
      "--dir",
      lab,
    ]);
    copyFileSync(`${lab}/herdr-linux-x86_64`, `${lab}/herdr`);
  }
  const herdrHash = createHash("sha256")
    .update(readFileSync(`${lab}/herdr`))
    .digest("hex");
  if (herdrHash !== "18a8dc65f1c2fa485884344356dea1cfd911c6f06cf46fa78e193f4087f4dba7")
    throw Error("herdr release hash mismatch");
  chmodSync(`${lab}/herdr`, 0o755);
  results.herdrSha256 = herdrHash;
  mkdirSync(`${lab}/local`);
  copyFileSync(`${lab}/foom-host`, `${lab}/local/foom-host`);
  copyFileSync(`${lab}/herdr`, `${lab}/local/herdr`);
  home(`${lab}/local`);
  for (const k of ["host", "client"])
    exec("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", `${lab}/${k}`], {
      env: cleanEnv,
    });
  copyFileSync(`${lab}/client.pub`, `${lab}/authorized_keys`);
  writeFileSync(
    `${lab}/sshd_config`,
    `Port 2222\nListenAddress 0.0.0.0\nHostKey /lab/host\nPidFile /lab/sshd.pid\nAuthorizedKeysFile /lab/authorized_keys\nPermitRootLogin prohibit-password\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nStrictModes yes\nAllowAgentForwarding no\nAllowTcpForwarding no\nX11Forwarding no\nPermitTunnel no\nPermitUserEnvironment no\nPermitUserRC no\nForceCommand /usr/bin/env -i HOME=/lab/home LAB=/lab PATH=/usr/bin:/bin /lab/foom-host\n`,
  );
  // Use an already present base image; do not pull, build or modify any host image.
  results.image = docker(["image", "inspect", "ubuntu:24.04", "--format", "{{.Id}}"]).trim();
  docker([
    "run",
    "-d",
    "--name",
    name,
    "--mount",
    `type=bind,src=${lab},dst=/lab`,
    "-p",
    "127.0.0.1::2222",
    "ubuntu:24.04",
    "sleep",
    "infinity",
  ]);
  container = true;
  console.error("Installing sshd only inside throwaway container");
  docker(["exec", name, "apt-get", "update"]);
  docker([
    "exec",
    "-e",
    "DEBIAN_FRONTEND=noninteractive",
    name,
    "apt-get",
    "install",
    "-y",
    "--no-install-recommends",
    "openssh-server",
  ]);
  docker(["exec", name, "mkdir", "-p", "/run/sshd"]);
  docker([
    "exec",
    name,
    "useradd",
    "-o",
    "-u",
    String(process.getuid()),
    "-M",
    "-d",
    "/lab/home",
    "-s",
    "/bin/sh",
    "fixture",
  ]);
  docker(["exec", name, "passwd", "-d", "fixture"]);
  mkdirSync(`${lab}/home/.config/herdr`, { recursive: true, mode: 0o700 });
  writeFileSync(`${lab}/fixture-shell`, "#!/bin/sh\nexec /lab/foom-host fixture\n", {
    mode: 0o700,
  });
  writeFileSync(
    `${lab}/home/.config/herdr/config.toml`,
    'onboarding = false\n[terminal]\ndefault_shell = "/lab/fixture-shell"\n',
  );
  docker(["exec", "-d", name, "/usr/sbin/sshd", "-D", "-e", "-f", "/lab/sshd_config"]);
  const port = docker(["port", name, "2222/tcp"]).trim().split(":").at(-1);
  const pub = readFileSync(`${lab}/host.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ");
  writeFileSync(`${lab}/known_hosts`, `[127.0.0.1]:${port} ${pub}\n`);
  sshArgs = [
    "-F",
    "/dev/null",
    "-T",
    "-p",
    port,
    "-i",
    `${lab}/client`,
    "-o",
    `UserKnownHostsFile=${lab}/known_hosts`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "IdentityAgent=none",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "Compression=no",
    "-o",
    "ConnectTimeout=5",
    "fixture@127.0.0.1",
  ];
  results.openssh = spawnSync("/usr/bin/docker", ["exec", name, "/usr/sbin/sshd", "-V"], {
    encoding: "utf8",
  }).stderr.trim();
  for (const adapter of ["B", "A"])
    for (const remote of [false, true]) {
      console.error(`Measuring ${adapter} ${remote ? "SSH" : "local"}`);
      let c = client(adapter, remote);
      const hello = await c.call({ adapter, version: "spike-1" });
      for (const id of ["t1", "t2", "t3"]) {
        await c.call({ op: "create", id, control: c.tokens.control, hook: c.tokens.hook });
        await wait(() => c.text.get(id)?.includes("FIXTURE_READY"), `${adapter} ${id} ready`);
      }
      // Concurrent, ID-routed echo proves three terminal streams share one SSH process.
      await Promise.all(
        ["t1", "t2", "t3"].map((id, i) => c.call({ op: "input", id, data: String(i) })),
      );
      for (const [i, id] of ["t1", "t2", "t3"].entries())
        await wait(() => c.text.get(id)?.includes(String(i)), `${id} routed`);
      const samples = [];
      let echoed = "0";
      for (let i = 0; i < 50; i++) {
        const marker = String.fromCharCode(97 + (i % 26));
        echoed += marker;
        const start = performance.now();
        await c.call({ op: "input", id: "t1", data: marker });
        await wait(() => c.text.get("t1")?.includes(echoed), "echo");
        samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      const bytes = c.bytes,
        start = performance.now();
      await c.call({ op: "input", id: "t2", data: "T" });
      await wait(() => c.text.get("t2")?.includes("THROUGHPUT_DONE"), "seq completion", 120000);
      const duration = performance.now() - start;
      const row = {
        adapter,
        remote,
        terminals: 3,
        echoSamples: 50,
        echoMedianMs: samples[25],
        echoP95Ms: samples[47],
        seqMs: duration,
        receivedTerminalBytes: c.bytes - bytes,
      };
      // Fixture exercises stdio bridge and hook POST launched from the PTY, for both A and B.
      const relayStart = results.relay.length;
      await c.call({ op: "input", id: "t3", data: "M" });
      await wait(
        () =>
          c.text.get("t3")?.includes("MCP_RESULTS:") && c.text.get("t3")?.includes("unauthorized"),
        "relays",
      );
      const bridgeMode = remote
        ? docker(["exec", name, "stat", "-c", "%a", "/lab/bridge.sock"]).trim()
        : exec("/usr/bin/stat", ["-c", "%a", `${lab}/local/bridge.sock`]).trim();
      if (bridgeMode !== "600") throw Error("bridge mode");
      await wait(() => results.relay.length === relayStart + 6, "all relay results");
      const first = results.relay.slice(relayStart);
      if (
        first.filter((r) => r.kind === "mcp" && r.outcome === "accepted").length !== 2 ||
        first.filter((r) => r.kind === "hook" && r.outcome === "accepted").length !== 1
      )
        throw Error("relay authentication/authorization");
      c.revoked = true;
      await c.call({ op: "input", id: "t3", data: "M" });
      await wait(() => results.relay.length === relayStart + 12, "revoked relay");
      if (results.relay.slice(relayStart + 6).some((r) => r.outcome !== "denied"))
        throw Error("revoked request accepted");
      c.revoked = false;
      await c.call({ op: "input", id: "t1", data: "D" });
      const oldTokens = c.tokens;
      await c.close();
      await sleep(1200); // elapsed time is the disconnect behavior under test
      const reconnect = performance.now();
      c = client(adapter, remote);
      c.tokens = oldTokens;
      const h2 = await c.call({ adapter, version: "spike-1" });
      if (h2.pid !== hello.pid) throw Error("daemon changed");
      const snap = await c.call({ op: "snapshot", id: "t1" });
      if (adapter === "B") {
        const t = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
        await new Promise((r) => t.write(snap.data, r));
        if (
          !Array.from({ length: t.buffer.active.length }, (_, i) =>
            t.buffer.active.getLine(i).translateToString(true),
          )
            .join("\n")
            .includes("DISCONNECTED_PROGRESS")
        )
          throw Error("lost progress");
        t.dispose();
      } else await wait(() => c.text.get("t1")?.includes("DISCONNECTED_PROGRESS"), "A catchup");
      row.reconnectCatchupMs = performance.now() - reconnect;
      row.daemonSurvived = true;
      row.bridgeMode = bridgeMode;
      await c.call({ op: "input", id: "t1", data: "F" });
      await wait(() => c.text.get("t1")?.includes("final"), "fidelity screen");
      if (adapter === "B") {
        const t = c.screens.get("t1");
        await new Promise((r) => t.write("", r));
        const expected = cells(t);
        const snap = await c.call({ op: "snapshot", id: "t1" });
        const restored = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
        await new Promise((r) => restored.write(snap.data, r));
        const equal = JSON.stringify(cells(restored)) === JSON.stringify(expected);
        results.fidelity.push({ adapter, remote, headlessEqual: equal });
        if (!equal) throw Error("snapshot fidelity");
        writeFileSync(
          `${dest}.${remote ? "ssh" : "local"}-screen.json`,
          JSON.stringify({ snapshot: snap.data, expected }),
        );
        restored.dispose();
      }
      if (adapter === "A") {
        const actual = cells(c.screens.get("t1"));
        const expectedTerminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
        await new Promise((r) =>
          expectedTerminal.write(
            "\x1b[2J\x1b[Hnormal\x1b[31m red\x1b[0m\r\nwide: 界 é\r\n\x1b[?1049h\x1b[2J\x1b[Halt\x1b[2;5H\x1b[1;34mBLUE\x1b[0m\x1b[4;1Hfinal",
            r,
          ),
        );
        const expected = cells(expectedTerminal);
        results.fidelity.push({
          adapter,
          remote,
          sourceCellsEqual: JSON.stringify(actual.rows) === JSON.stringify(expected.rows),
          sourceCursorEqual: JSON.stringify(actual.cursor) === JSON.stringify(expected.cursor),
          sourceBufferEqual: actual.type === expected.type,
          actualBuffer: actual.type,
        });
        writeFileSync(
          `${dest}.${remote ? "ssh" : "local"}-herdr-screen.json`,
          JSON.stringify({ snapshot: c.raw.get("t1"), expected: actual }),
        );
        expectedTerminal.dispose();
      }
      await c.call({ op: "shutdown" });
      await wait(() => c.p.exitCode !== null || c.p.signalCode !== null, "daemon shutdown EOF");
      await c.close();
      // The same scratch root is reused for the other adapter after explicit shutdown.
      const paths = ["A.sock", "B.sock", "bridge.sock", "herdr.sock", "herdr-client.sock"];
      if (remote) docker(["exec", name, "rm", "-f", ...paths.map((p) => `/lab/${p}`)]);
      else for (const p of paths) rmSync(`${lab}/local/${p}`, { force: true });
      results.measurements.push(row);
      console.error(JSON.stringify(row));
    }
  const bad = client("B", true);
  let rejected = false;
  try {
    await bad.call({ adapter: "B", version: "wrong" });
  } catch (e) {
    rejected = e.message === "version_mismatch";
  }
  await bad.close();
  if (!rejected) throw Error("version mismatch accepted");
  results.versionMismatchRejected = true;
  // Stop daemon started solely for mismatch check.
  const end = client("B", true);
  await end.call({ adapter: "B", version: "spike-1" });
  await end.call({ op: "shutdown" });
  await wait(
    () => end.p.exitCode !== null || end.p.signalCode !== null,
    "final daemon shutdown EOF",
  );
  await end.close();
  writeFileSync(dest, JSON.stringify(results, null, 2) + "\n");
  console.log(dest);
} finally {
  if (!existsSync(dest)) writeFileSync(dest + ".partial", JSON.stringify(results, null, 2) + "\n");
  for (const p of children) p.kill("SIGKILL");
  // Only PIDs recorded by this private experiment are eligible for cleanup.
  for (const file of ["A.pid", "B.pid"]) {
    try {
      const pid = Number(readFileSync(`${lab}/local/${file}`));
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  try {
    exec(`${lab}/local/herdr`, ["server", "stop"], {
      env: { ...cleanEnv, HOME: `${lab}/local/home`, HERDR_SOCKET_PATH: `${lab}/local/herdr.sock` },
      timeout: 5000,
      stdio: "ignore",
    });
  } catch {}
  if (container) {
    try {
      docker(["exec", name, "chown", "-R", `${process.getuid()}:${process.getgid()}`, "/lab"]);
    } finally {
      docker(["rm", "-f", name]);
    }
  }
  // Audit only executables under this run's unique prefix; never match by process name.
  const binaries = new Set([
    `${lab}/local/foom-host`,
    `${lab}/local/herdr`,
    `${lab}/foom-host`,
    `${lab}/herdr`,
  ]);
  const owned = () =>
    readdirSync("/proc")
      .filter((p) => /^\d+$/.test(p))
      .filter((p) => {
        try {
          return binaries.has(readlinkSync(`/proc/${p}/exe`));
        } catch {
          return false;
        }
      })
      .map(Number);
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    for (const pid of owned()) {
      try {
        process.kill(pid, signal);
      } catch {}
    }
    const deadline = performance.now() + 5000;
    while (owned().length && performance.now() < deadline) await sleep(20);
    if (!owned().length) break;
  }
  if (owned().length) throw Error(`scratch processes remain; retained ${lab}`);
  for (const p of children) {
    if (p.exitCode === null && p.signalCode === null) await new Promise((r) => p.once("exit", r));
  }
  rmSync(lab, { recursive: true, force: true });
}
