import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import { mkdir, readFile, realpath, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { RemoteFrames, remoteFrame } from "../../../../src/shared/remote-host-protocol";
import { HOST_MANAGEMENT_TIMEOUT_MS } from "../../../../src/shared/registered-hosts";
import type { RemoteRequest } from "../../../../src/shared/remote-host";
// No native PTY or agent can be launched by a management connection.
vi.mock("../../../../src/terminal-host/terminal-manager", () => ({
  TerminalManager: class {
    shutdown = () => Promise.resolve();
  },
}));
import { serveHost } from "../../../../src/terminal-host/remote/daemon";
let root: string | undefined;
let host: ReturnType<typeof serveHost> | undefined;
const clients: Socket[] = [];
const build = "a".repeat(64);
afterEach(async () => {
  vi.useRealTimers();
  for (const socket of clients.splice(0)) socket.destroy();
  await host?.close();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});
async function setup() {
  // The test runner owns tmpdir(); keep HOME short enough for macOS Unix sockets.
  root = join(await realpath(tmpdir()), "mc");
  await mkdir(root, { mode: 0o700 });
  const home = root;
  const bin = join(home, "bin");
  await mkdir(bin);
  const started = join(home, "started");
  const release = join(home, "release");
  await writeFile(
    join(bin, "shell"),
    `#!${process.execPath}\nprocess.stdout.write('\\0FOOM_PATH\\0'+${JSON.stringify(bin)}+'\\0')`,
    { mode: 0o700 },
  );
  await writeFile(
    join(bin, "git"),
    `#!${process.execPath}
const fs=require('node:fs'), path=require('node:path');
const args=process.argv.slice(2); const cwd=process.cwd();
if(args.includes('clone')) {
 fs.writeFileSync(${JSON.stringify(started)},'started');
 const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})) {
  clearInterval(timer); fs.writeFileSync(path.join(args.at(-1),'fixture'),'cloned');
 }},10);
} else if(args.includes('config')) console.log('git@fixture.test:team/repo.git');
else if(args.includes('--show-toplevel')) console.log(cwd);
else if(args.includes('--verify')) console.log('a'.repeat(40));
else if(!args.includes('status')) process.exit(2);
`,
    { mode: 0o700 },
  );
  vi.stubEnv("PATH", bin);
  vi.stubEnv("SHELL", join(bin, "shell"));
  host = serveHost(build, home);
  await once(host.server, "listening");
  return { home, started, release };
}
async function client(home: string) {
  const socket = createConnection(join(home, ".foom-host/host.sock"));
  clients.push(socket);
  socket.on("error", () => {});
  await once(socket, "connect");
  const messages: unknown[] = [];
  const frames = new RemoteFrames();
  socket.on("data", (data: Buffer) => {
    frames.push(data, (message) => messages.push(message));
  });
  const send = (message: RemoteRequest) => socket.write(remoteFrame(message));
  const wait = async (count: number) => {
    while (messages.length < count) await once(socket, "data");
  };
  send({ type: "hello", build });
  await wait(1);
  return { socket, messages, send, wait };
}
const clone = {
  type: "manage",
  operation: "clone",
  codeFolder: "~/code",
  directory: "repo",
  origin: "git@fixture.test:team/repo.git",
} as const;
test.skipIf(process.platform === "win32")(
  "daemon + management + fixture Git survives the old 10s deadline and publishes one checkout",
  async () => {
    const { home, started, release } = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const c = await client(home);
    c.send(clone);
    await vi.waitFor(async () => {
      expect(await readFile(started, "utf8")).toBe("started");
    });
    await vi.advanceTimersByTimeAsync(11000);
    expect(c.socket.destroyed).toBe(false);
    const retry = await client(home);
    retry.send(clone);
    await retry.wait(2);
    expect(retry.messages[1]).toEqual({
      type: "managed",
      result: { ok: false, reason: "checkout-refused" },
    });
    await writeFile(release, "go");
    await c.wait(2);
    expect(c.messages[1]).toMatchObject({
      type: "managed",
      result: { ok: true, checkout: { state: "clean" } },
    });
    expect(await readdir(join(home, "code"))).toEqual(["repo"]);
    retry.send(clone);
    await retry.wait(3);
    expect(retry.messages[2]).toMatchObject({
      type: "managed",
      result: { ok: true, checkout: { state: "clean" } },
    });
  },
);
test.skipIf(process.platform === "win32").each(["disconnect", "expiry", "shutdown"])(
  "%s cancels fixture Git, removes staging, and permits a reconciled retry",
  async (cause) => {
    const { home, started, release } = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const c = await client(home);
    c.send(clone);
    await vi.waitFor(async () => {
      expect(await readFile(started, "utf8")).toBe("started");
    });
    const closed = once(c.socket, "close");
    if (cause === "expiry") await vi.advanceTimersByTimeAsync(HOST_MANAGEMENT_TIMEOUT_MS);
    else if (cause === "shutdown") await host?.close();
    else c.socket.destroy();
    await closed;
    await vi.waitFor(async () => {
      expect(await readdir(join(home, "code"))).toEqual([]);
    });
    if (cause === "shutdown") return;
    await writeFile(release, "go");
    const retry = await client(home);
    retry.send({ ...clone, operation: "repository" });
    await retry.wait(2);
    expect(retry.messages[1]).toMatchObject({
      type: "managed",
      result: { ok: true, checkout: { state: "absent" } },
    });
    retry.send(clone);
    await retry.wait(3);
    expect(retry.messages[2]).toMatchObject({
      type: "managed",
      result: { ok: true, checkout: { state: "clean" } },
    });
  },
);

test.skipIf(process.platform === "win32")(
  "cumulative inventory may exceed 10s while each fixed fixture probe stays within 5s",
  async () => {
    const { home } = await setup();
    const bin = join(home, "bin");
    const counter = join(home, "counter");
    await writeFile(
      join(bin, "fixture-agent"),
      `#!${process.execPath}
const fs=require('node:fs');
let n=0;try{n=Number(fs.readFileSync(${JSON.stringify(counter)},'utf8'))}catch{}
fs.writeFileSync(${JSON.stringify(counter)},String(++n));
const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(home)}+'/probe-'+n)) {
 clearInterval(timer); console.log('fixture version and help');
}},10);
`,
      { mode: 0o700 },
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const c = await client(home);
    c.send({
      type: "manage",
      operation: "inspect",
      codeFolder: "~/code",
      agents: [
        { id: "claude", executables: ["fixture-agent"] },
        { id: "codex", executables: ["fixture-agent"] },
      ],
    });
    for (let n = 1; n <= 4; n++) {
      await vi.waitFor(async () => {
        expect(await readFile(counter, "utf8")).toBe(String(n));
      });
      await vi.advanceTimersByTimeAsync(4000);
      expect(c.socket.destroyed).toBe(false);
      await writeFile(join(home, `probe-${String(n)}`), "go");
    }
    await c.wait(2);
    expect(c.messages[1]).toMatchObject({
      type: "managed",
      result: {
        ok: true,
        facts: {
          agents: [
            { id: "claude", state: "ready" },
            { id: "codex", state: "ready" },
          ],
        },
      },
    });
  },
);
