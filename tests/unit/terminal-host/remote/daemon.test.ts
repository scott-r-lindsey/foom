import { createConnection, type Socket } from "node:net";
import { mkdtemp, rm, stat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RemoteFrames, remoteFrame } from "../../../../src/shared/remote-host-protocol";
import type { RemoteRequest } from "../../../../src/shared/remote-host";
const mock = vi.hoisted(() => ({
  create: vi.fn(),
  attach: vi.fn(),
  detach: vi.fn(),
  stop: vi.fn(),
  kill: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  setTheme: vi.fn(),
  acknowledge: vi.fn(),
  tail: vi.fn(),
  screen: vi.fn(),
  shutdown: vi.fn(),
  exited: (_id: string, _code: number) => {},
}));
vi.mock("../../../../src/terminal-host/terminal-manager", () => ({
  TerminalManager: class {
    create = mock.create;
    attach = mock.attach;
    detach = mock.detach;
    stop = mock.stop;
    kill = mock.kill;
    write = mock.write;
    resize = mock.resize;
    setTheme = mock.setTheme;
    acknowledge = mock.acknowledge;
    tail = mock.tail;
    screen = mock.screen;
    shutdown = mock.shutdown;
    constructor(exited: typeof mock.exited) {
      mock.exited = exited;
    }
  },
}));
import { serveHost } from "../../../../src/terminal-host/remote/daemon";
let root: string;
let host: ReturnType<typeof serveHost>;
const clients: Socket[] = [];
const build = "a".repeat(64);
beforeEach(async () => {
  vi.clearAllMocks();
  root = await realpath(await mkdtemp(join(tmpdir(), "host-daemon-")));
  mock.stop.mockResolvedValue(true);
  mock.tail.mockResolvedValue(["tail"]);
  mock.screen.mockResolvedValue({ lines: ["screen"], title: "shell", cols: 80, rows: 24 });
  mock.shutdown.mockResolvedValue(undefined);
});
afterEach(async () => {
  for (const socket of clients.splice(0)) socket.destroy();
  await host.close();
  await rm(root, { recursive: true, force: true });
});
async function start() {
  host = serveHost(build, root);
  await once(host.server, "listening");
}
async function client() {
  const socket = createConnection(join(root, ".foom-host/host.sock"));
  clients.push(socket);
  socket.on("error", () => {});
  await once(socket, "connect");
  const frames = new RemoteFrames();
  const messages: unknown[] = [];
  socket.on("data", (bytes: Buffer) => {
    frames.push(bytes, (value) => messages.push(value));
  });
  return {
    socket,
    messages,
    send(message: RemoteRequest) {
      socket.write(remoteFrame(message));
    },
    async wait(count: number) {
      while (messages.length < count) await once(socket, "data");
    },
  };
}
async function open(id = "one") {
  const c = await client();
  c.send({ type: "hello", build });
  await c.wait(1);
  c.send({ type: "open", id, request: 1, cols: 80, rows: 24 });
  await c.wait(2);
  return c;
}
test.skipIf(process.platform === "win32")(
  "owns a private Unix socket and serial shell operations, retaining PTY across disconnect",
  async () => {
    await start();
    expect((await stat(join(root, ".foom-host/host.sock"))).mode & 0o777).toBe(0o600);
    const c = await open();
    expect(mock.create).toHaveBeenCalledWith(
      expect.objectContaining({ command: "/bin/sh", cwd: root }),
      "one",
    );
    mock.attach.mockImplementation((_id: string, send: (token: string, data: string) => void) => {
      send("token", "snapshot");
      return Promise.resolve();
    });
    const commands = [
      { type: "attach", view: "v" },
      { type: "write", data: "input" },
      { type: "resize", cols: 100, rows: 40 },
      { type: "theme", dark: false },
      { type: "acknowledge", token: "token", count: 1 },
      { type: "screen" },
      { type: "tail", lines: 1 },
      { type: "detach" },
      { type: "stop" },
    ] as const;
    let request = 1;
    for (const command of commands) c.send({ ...command, id: "one", request: ++request });
    await c.wait(12);
    expect(c.messages).toContainEqual(expect.objectContaining({ type: "data", data: "snapshot" }));
    expect(c.messages).toContainEqual(
      expect.objectContaining({ title: "shell", lines: ["screen"] }),
    );
    const closed = once(c.socket, "close");
    c.socket.destroy();
    await closed;
    await vi.waitFor(() => {
      expect(mock.detach).toHaveBeenCalled();
    });
    expect(mock.kill).not.toHaveBeenCalled();
    const next = await open();
    expect(mock.create).toHaveBeenCalledTimes(1);
    mock.exited("one", 3);
    await next.wait(3);
    next.send({ type: "attach", id: "one", request: 50, view: "new" });
    await next.wait(6);
    expect(next.messages).toContainEqual({ type: "exit", id: "one", code: 3 });
    next.send({ type: "kill", id: "one", request: 51 });
    await next.wait(7);
    expect(mock.kill).toHaveBeenCalledWith("one");
  },
);
test.skipIf(process.platform === "win32")(
  "refuses build mismatches, repeated negotiation, invalid operations and foreign IDs",
  async () => {
    await start();
    for (const message of [
      { type: "hello", build: "b".repeat(64) },
      { type: "write", id: "one", request: 1, data: "pre-auth" },
    ] as const) {
      const c = await client();
      const closed = once(c.socket, "close");
      c.send(message);
      await closed;
    }
    const first = await open();
    const closed = once(first.socket, "close");
    mock.detach.mockClear();
    const second = await open();
    await closed;
    expect(mock.detach).toHaveBeenCalledWith("one");
    expect(mock.create).toHaveBeenCalledTimes(1);
    const badId = once(second.socket, "close");
    second.send({ type: "write", id: "other", request: 2, data: "bad" });
    await badId;
    const repeated = await open();
    const repeatClosed = once(repeated.socket, "close");
    repeated.send({ type: "hello", build });
    await repeatClosed;
    const invalid = await client();
    const invalidClosed = once(invalid.socket, "close");
    invalid.socket.write(Buffer.from([0, 0, 0, 0]));
    await invalidClosed;
    const wrong = await client();
    const wrongClosed = once(wrong.socket, "close");
    wrong.socket.write(remoteFrame({ type: "shutdown", id: "host", request: 1 }));
    await wrongClosed;
  },
);
test.skipIf(process.platform === "win32")(
  "serializes per connection, rejects duplicate open and disconnects on manager errors",
  async () => {
    await start();
    const c = await open();
    const duplicate = once(c.socket, "close");
    c.send({ type: "open", id: "two", request: 2, cols: 80, rows: 24 });
    await duplicate;
    const next = await open();
    mock.write.mockImplementationOnce(() => {
      throw new Error("untrusted detail");
    });
    const failed = once(next.socket, "close");
    next.send({ type: "write", id: "one", request: 2, data: "x" });
    await failed;
    expect(next.messages).not.toContainEqual(
      expect.objectContaining({ error: "untrusted detail" }),
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const unnegotiated = await client();
    const timedOut = once(unnegotiated.socket, "close");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(10000);
    vi.useRealTimers();
    await timedOut;
  },
);

test.skipIf(process.platform === "win32")(
  "caps sessions and live connections without evicting existing PTYs",
  async () => {
    await start();
    for (let index = 0; index < 32; index++) {
      const c = await open(`session-${String(index)}`);
      const closed = once(c.socket, "close");
      c.socket.destroy();
      await closed;
    }
    const excess = await client();
    excess.send({ type: "hello", build });
    await excess.wait(1);
    const refused = once(excess.socket, "close");
    excess.send({ type: "open", id: "excess", request: 1, cols: 80, rows: 24 });
    await refused;
    expect(mock.create).toHaveBeenCalledTimes(32);
    const held = [];
    for (let index = 0; index < 32; index++) held.push(await client());
    const thirtyThird = await client();
    const disconnected = once(thirtyThird.socket, "close");
    await disconnected;
    expect(held.every((connection) => !connection.socket.destroyed)).toBe(true);
  },
);

test.skipIf(process.platform === "win32")(
  "invalid output, oversized snapshots and slow peers disconnect without stopping PTYs",
  async () => {
    await start();
    let serverSocket: Socket | undefined;
    host.server.on("connection", (socket) => {
      serverSocket = socket;
    });
    const slow = await open();
    if (!serverSocket) throw new Error("No server connection");
    Object.defineProperty(serverSocket, "writableLength", { get: () => 2 * 1024 * 1024 });
    const slowClosed = once(slow.socket, "close");
    mock.exited("one", 0);
    await slowClosed;
    const invalid = await open();
    const invalidClosed = once(invalid.socket, "close");
    mock.exited("one", Number.NaN);
    await invalidClosed;
    const large = await open();
    mock.attach.mockImplementationOnce(
      (_id: string, send: (token: string, data: string) => void) => {
        send("t", "x".repeat(8 * 1024 * 1024));
        return Promise.resolve();
      },
    );
    const largeClosed = once(large.socket, "close");
    large.send({ type: "attach", id: "one", request: 3, view: "v" });
    await largeClosed;
    mock.exited("unknown", 1);
    expect(mock.kill).not.toHaveBeenCalled();
    const errored = await open();
    const erroredClosed = once(errored.socket, "close");
    host.server.emit("error", new Error("fixture server failure"));
    await erroredClosed;
  },
);

test.skipIf(process.platform === "win32")(
  "negotiated channels must open one ID and reject excessive queued requests",
  async () => {
    await start();
    const empty = await client();
    empty.send({ type: "hello", build });
    await empty.wait(1);
    const emptyClosed = once(empty.socket, "close");
    empty.send({ type: "write", request: 1, id: "one", data: "no capability" });
    await emptyClosed;
    const queue = await client();
    const packet = remoteFrame({ type: "hello", build });
    const all = Buffer.concat(Array.from({ length: 257 }, () => Buffer.from(packet)));
    const queuedClosed = once(queue.socket, "close");
    queue.socket.write(all);
    await queuedClosed;
    expect(mock.create).not.toHaveBeenCalled();
  },
);

test.skipIf(process.platform === "win32")(
  "shutdown revokes attachments before disposal, joins concurrent signals and permits retry",
  async () => {
    await start();
    const c = await open();
    const closed = once(c.socket, "close");
    mock.detach.mockClear();
    mock.shutdown.mockImplementationOnce(() => {
      expect(mock.detach).toHaveBeenCalledWith("one");
      return Promise.reject(new Error("native exit not drained"));
    });
    const first = host.close();
    expect(host.close()).toBe(first);
    await expect(first).rejects.toThrow("native exit not drained");
    mock.shutdown.mockResolvedValue(undefined);
    await host.close();
    await closed;
    expect(c.socket.destroyed).toBe(true);
  },
);
