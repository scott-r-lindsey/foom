// Disposable protocol experiment, NOT the production terminal host or validator.
const fs = require("node:fs");
const net = require("node:net");
const http = require("node:http");
const { spawn, execFileSync } = require("node:child_process");
const { Terminal } = require("@xterm/headless");
const { SerializeAddon } = require("@xterm/addon-serialize");
const { terminalSnapshot } = require("../../src/terminal-host/terminal-snapshot.ts");
const lab = process.env.LAB;
if (!lab || !/^\/(tmp\/foom-remote\.[A-Za-z0-9]+|lab)(\/local)?$/.test(lab))
  throw Error("scratch LAB required");
process.umask(0o077);
const env = {
  HOME: `${lab}/home`,
  XDG_CONFIG_HOME: `${lab}/home/.config`,
  PATH: "/usr/bin:/bin",
  SHELL: `${lab}/fixture-shell`,
  TERM: "xterm-256color",
  LAB: lab,
  HERDR_SOCKET_PATH: `${lab}/herdr.sock`,
};
const send = (s, m) => {
  if (!s.destroyed) {
    if (s.writableLength > 8 * 1024 * 1024) return s.destroy();
    s.write(JSON.stringify(m) + "\n");
  }
};
function lines(s, f) {
  let b = "";
  s.setEncoding("utf8");
  s.on("data", (d) => {
    b += d;
    if (b.length > 2 * 1024 * 1024) return s.destroy();
    let i;
    while ((i = b.indexOf("\n")) >= 0) {
      const l = b.slice(0, i);
      b = b.slice(i + 1);
      if (l) {
        try {
          f(JSON.parse(l));
        } catch {
          s.destroy();
        }
      }
    }
  });
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFile(p) {
  for (let i = 0; i < 300; i++) {
    if (fs.existsSync(p)) return;
    await pause(20);
  }
  throw Error("socket startup timeout");
}
function detach(exe, args) {
  const fd = fs.openSync(`${lab}/daemon.log`, "a", 0o600);
  const p = spawn(exe, args, { env, cwd: lab, detached: true, stdio: ["ignore", fd, fd] });
  p.unref();
  fs.closeSync(fd);
  return p.pid;
}
function rpc(path, m) {
  return new Promise((resolve, reject) => {
    const s = net.connect(path);
    s.setTimeout(10000, () => s.destroy(Error("timeout")));
    s.on("error", reject);
    s.on("connect", () => send(s, m));
    lines(s, (r) => {
      s.end();
      resolve(r);
    });
  });
}
async function fixture() {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write("FIXTURE_READY\r\n");
  process.stdin.on("data", async (d) => {
    for (const c of d.toString()) {
      if (c === "T") {
        const p = spawn("/usr/bin/seq", ["1", "2000000"], {
          env,
          stdio: ["ignore", "pipe", "ignore"],
        });
        p.stdout.pipe(process.stdout, { end: false });
        p.on("close", () => process.stdout.write("\r\nTHROUGHPUT_DONE\r\n"));
      } else if (c === "D")
        setTimeout(() => process.stdout.write("DISCONNECTED_PROGRESS\r\n"), 1000);
      else if (c === "F")
        process.stdout.write(
          "\x1b[2J\x1b[Hnormal\x1b[31m red\x1b[0m\r\nwide: 界 é\r\n\x1b[?1049h\x1b[2J\x1b[Halt\x1b[2;5H\x1b[1;34mBLUE\x1b[0m\x1b[4;1Hfinal",
        );
      else if (c === "M") {
        const p = spawn(process.execPath, ["mcp-bridge"], {
          env: { ...env, FOOM_CONTROL_TOKEN: process.env.FOOM_CONTROL_TOKEN },
          stdio: ["pipe", "pipe", "inherit"],
        });
        const requests = [
          {
            id: 1,
            jsonrpc: "2.0",
            method: "initialize",
            params: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              clientInfo: { name: "fixture", version: "1" },
            },
          },
          {
            id: 2,
            jsonrpc: "2.0",
            method: "tools/call",
            params: { name: "whoami", arguments: {} },
          },
          {
            id: 3,
            jsonrpc: "2.0",
            method: "tools/call",
            params: { name: "launch", arguments: { approved: true } },
          },
        ];
        let results = [];
        lines(p.stdout, (r) => {
          results.push(r);
          if (results.length === 3) {
            p.stdin.end();
            process.stdout.write("MCP_RESULTS:" + JSON.stringify(results) + "\r\n");
          }
        });
        requests.forEach((r) => send(p.stdin, r));
        const port = Number(fs.readFileSync(`${lab}/hook-port`));
        for (const token of [
          process.env.FOOM_HOOK_TOKEN,
          "wrong",
          process.env.FOOM_CONTROL_TOKEN,
        ]) {
          const r = await new Promise((resolve) => {
            const q = http.request(
              {
                host: "127.0.0.1",
                port,
                path: "/hook",
                method: "POST",
                headers: { authorization: `Bearer ${token}` },
              },
              (res) => {
                let b = "";
                res.on("data", (d) => (b += d));
                res.on("end", () => resolve(JSON.parse(b)));
              },
            );
            q.end(JSON.stringify({ event: "stop", approved: true }));
          });
          process.stdout.write("HOOK_RESULT:" + JSON.stringify(r) + "\r\n");
        }
      } else process.stdout.write(c);
    }
  });
}
async function daemon(adapter) {
  const terminals = new Map(),
    clients = new Set(),
    pending = new Map();
  let relayId = 0,
    owner;
  fs.writeFileSync(`${lab}/${adapter}.pid`, String(process.pid));
  if (adapter === "A") {
    detach(`${lab}/herdr`, ["server"]);
    await waitFile(`${lab}/herdr.sock`);
  }
  const relay = (kind, token, body) =>
    new Promise((resolve) => {
      if (!owner || owner.destroyed) return resolve({ error: "disconnected" });
      const id = ++relayId;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: "timeout" });
      }, 5000);
      pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      send(owner, { event: "relay", id, kind, token, body });
    });
  const bridge = net.createServer((s) => {
    lines(s, async (m) => send(s, await relay("mcp", m.token, m.body)));
  });
  await new Promise((r) => bridge.listen(`${lab}/bridge.sock`, r));
  fs.chmodSync(`${lab}/bridge.sock`, 0o600);
  const hooks = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => {
      b += d;
      if (b.length > 65536) req.destroy();
    });
    req.on("end", async () => {
      try {
        const r = await relay("hook", req.headers.authorization?.slice(7), JSON.parse(b));
        res.end(JSON.stringify(r));
      } catch {
        res.writeHead(400).end();
      }
    });
  });
  await new Promise((r) => hooks.listen(0, "127.0.0.1", r));
  fs.writeFileSync(`${lab}/hook-port`, String(hooks.address().port));
  function flow(t) {
    if (!t.pty) return;
    const view = Math.max(0, ...Array.from(clients, (s) => s.writableLength));
    if (t.queued > 262144 || view > 262144) t.pty.pause();
    else if (t.queued < 65536 && view < 65536) t.pty.resume();
  }
  function output(id, data) {
    for (const s of clients) send(s, { event: "data", id, data });
    for (const t of terminals.values()) flow(t);
  }
  process.on("SIGTERM", () => {
    for (const t of terminals.values()) {
      t.pty?.kill();
      t.control?.kill();
    }
    setTimeout(() => process.exit(), 100);
  });
  async function api(method, params) {
    const r = await rpc(`${lab}/herdr.sock`, { id: "spike", method, params });
    if (r.error) throw Error(JSON.stringify(r.error));
    return r.result;
  }
  async function attachA(t) {
    if (t.control) return;
    const p = spawn(
      `${lab}/herdr`,
      ["terminal", "session", "control", t.pane, "--cols", "80", "--rows", "24"],
      { env, stdio: ["pipe", "pipe", "ignore"] },
    );
    t.control = p;
    lines(p.stdout, (m) => {
      if (m.type === "terminal.frame") {
        t.frame = m;
        output(t.id, Buffer.from(m.bytes, "base64").toString());
      }
    });
    p.on("exit", () => {
      if (t.control === p) t.control = null;
    });
  }
  const server = net.createServer((s) => {
    let accepted = false;
    s.on("drain", () => {
      for (const t of terminals.values()) flow(t);
    });
    lines(s, async (m) => {
      try {
        if (!accepted) {
          if (m.op !== "hello" || m.version !== "spike-1") {
            send(s, { rid: m.rid, error: "version_mismatch" });
            return s.end();
          }
          accepted = true;
          clients.add(s);
          owner = s;
          send(s, { rid: m.rid, result: { version: "spike-1", pid: process.pid } });
          return;
        }
        if (m.op === "relay-result") {
          pending.get(m.id)?.(m.result);
          pending.delete(m.id);
          return;
        }
        let result = {};
        if (m.op === "create") {
          if (terminals.has(m.id) || !/^t[1-3]$/.test(m.id)) throw Error("id");
          const t = { id: m.id };
          terminals.set(m.id, t);
          const launchEnv = { ...env, FOOM_CONTROL_TOKEN: m.control, FOOM_HOOK_TOKEN: m.hook };
          if (adapter === "B") {
            t.screen = new Terminal({
              cols: 80,
              rows: 24,
              scrollback: 1000,
              allowProposedApi: true,
            });
            t.ser = new SerializeAddon();
            t.screen.loadAddon(t.ser);
            const pty = require("node-pty");
            t.pty = pty.spawn(process.execPath, ["fixture"], {
              cols: 80,
              rows: 24,
              cwd: lab,
              env: launchEnv,
            });
            t.queued = 0;
            t.pty.onData((data) => {
              t.queued += data.length;
              flow(t);
              t.screen.write(data, () => {
                t.queued -= data.length;
                output(t.id, data);
                flow(t);
              });
            });
          } else {
            const r = await api("workspace.create", {
              cwd: lab,
              focus: false,
              label: m.id,
              env: launchEnv,
            });
            t.pane = r.root_pane?.pane_id;
            if (!t.pane) throw Error(JSON.stringify(r));
            await attachA(t);
          }
          result = { pid: t.pty?.pid, pane: t.pane };
        } else if (m.op === "input") {
          const t = terminals.get(m.id);
          if (!t || typeof m.data !== "string" || m.data.length > 64) throw Error("input");
          if (adapter === "B") t.pty.write(m.data);
          else send(t.control.stdin, { type: "terminal.input", text: m.data });
        } else if (m.op === "snapshot") {
          const t = terminals.get(m.id);
          if (!t) throw Error("id");
          if (adapter === "B") {
            await new Promise((r) => t.screen.write("", r));
            result = { data: terminalSnapshot(t.screen, t.ser), pid: t.pty.pid };
          } else {
            if (t.control) {
              t.control.kill();
              t.control = null;
            }
            await attachA(t);
            result = { pane: t.pane };
          }
        } else if (m.op === "shutdown") {
          send(s, { rid: m.rid, result: {} });
          for (const t of terminals.values()) {
            t.pty?.kill();
            t.control?.kill();
          }
          if (adapter === "A")
            execFileSync(`${lab}/herdr`, ["server", "stop"], { env, stdio: "ignore" });
          setTimeout(() => process.exit(), 200);
          return;
        } else throw Error("method");
        send(s, { rid: m.rid, result });
      } catch (e) {
        send(s, { rid: m.rid, error: String(e.message) });
      }
    });
    s.on("close", () => {
      clients.delete(s);
      if (owner === s) owner = null;
      for (const t of terminals.values()) flow(t);
    });
    s.on("error", () => {});
  });
  await new Promise((r) => server.listen(`${lab}/${adapter}.sock`, r));
  fs.chmodSync(`${lab}/${adapter}.sock`, 0o600);
}
async function transport() {
  // Only a fixed adapter selector crosses this boot boundary; no remote command API.
  let started = false;
  lines(process.stdin, async (m) => {
    if (started) return;
    started = true;
    if (!["A", "B"].includes(m.adapter)) return process.exit(2);
    const path = `${lab}/${m.adapter}.sock`;
    if (!fs.existsSync(path)) {
      detach(process.execPath, ["daemon", m.adapter]);
      await waitFile(path);
    }
    const s = net.connect(path);
    s.on("error", () => process.exit(3));
    s.on("connect", () => {
      send(s, { rid: m.rid, op: "hello", version: m.version });
      process.stdin.pipe(s);
    });
    s.pipe(process.stdout);
    s.on("close", () => process.exit());
    process.stdin.on("end", () => s.end());
  });
}
(async () => {
  switch (process.argv[2]) {
    case "daemon":
      await daemon(process.argv[3]);
      break;
    case "fixture":
      await fixture();
      break;
    case "mcp-bridge": {
      const s = net.connect(`${lab}/bridge.sock`);
      s.on("error", () => process.exit(3));
      lines(process.stdin, (m) => send(s, { token: process.env.FOOM_CONTROL_TOKEN, body: m }));
      lines(s, (m) => send(process.stdout, m));
      process.stdin.on("end", () => s.end());
      break;
    }
    default:
      await transport();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
