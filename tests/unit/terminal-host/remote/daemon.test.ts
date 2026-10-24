import { createConnection, type Socket } from "node:net";
import { mkdir, rm, stat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  RemoteFrames,
  RemoteMessages,
  remoteResponse,
  MAX_REMOTE_MESSAGE,
  remoteFrame,
} from "../../../../src/shared/remote-host-protocol";
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
import { DETACHED_SESSION_GRACE_MS, serveHost } from "../../../../src/terminal-host/remote/daemon";
let root: string;
let host: ReturnType<typeof serveHost>;
const clients: Socket[] = [];
const build = "a".repeat(64);
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("SHELL", "/bin/sh");
  // Each test run owns tmpdir(); keep HOME short enough for macOS Unix sockets.
  root = join(await realpath(tmpdir()), "rd");
  await mkdir(root, { mode: 0o700 });
  mock.stop.mockResolvedValue(true);
  mock.tail.mockResolvedValue(["tail"]);
  mock.screen.mockResolvedValue({ lines: ["screen"], title: "shell", cols: 80, rows: 24 });
  mock.shutdown.mockResolvedValue(undefined);
});
afterEach(async () => {
  for (const socket of clients.splice(0)) socket.destroy();
  await host.close();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
async function start() {
  host = serveHost(build, root, { setTimeout, clearTimeout });
  await once(host.server, "listening");
}
async function client() {
  const connected = new Promise<Socket>((resolve) => host.server.once("connection", resolve));
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
    serverSocket: await connected,
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
async function open(id = "one", reattach = false) {
  const c = await client();
  c.send({ type: "hello", build });
  await c.wait(1);
  c.send({ type: "open", reattach, id, request: 1, cols: 80, rows: 24 });
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
      { command: "/bin/sh", args: ["-i", "-l"], cwd: root, cols: 80, rows: 24 },
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
    const next = await open("one", true);
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
    c.send({ type: "open", reattach: false, id: "two", request: 2, cols: 80, rows: 24 });
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
    excess.send({ type: "open", reattach: false, id: "excess", request: 1, cols: 80, rows: 24 });
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
    const invalid = await open("invalid");
    const invalidClosed = once(invalid.socket, "close");
    mock.exited("invalid", Number.NaN);
    await invalidClosed;
    const large = await open("large");
    mock.attach.mockImplementationOnce(
      (
        _id: string,
        send: (token: string, data: string) => void,
        _reset: boolean,
        fits: (token: string, data: string) => boolean,
      ) => {
        const excessive = "x".repeat(MAX_REMOTE_MESSAGE);
        expect(fits("t", excessive)).toBe(false);
        expect(fits("t", "small")).toBe(true);
        send("t", excessive);
        return Promise.resolve();
      },
    );
    const largeClosed = once(large.socket, "close");
    large.send({ type: "attach", id: "large", request: 3, view: "v" });
    await largeClosed;
    mock.exited("unknown", 1);
    // Exited disconnected sessions are now disposed immediately.
    expect(mock.kill).toHaveBeenCalledWith("one");
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

test.skipIf(process.platform === "win32")(
  "streams replay beyond the frame cap to a paused reader before attach completion and live output",
  async () => {
    await start();
    const c = await open();
    const data = "\x1b[31mA\x1b[32mB".repeat(40 * 10000);
    mock.attach.mockImplementationOnce(
      (_id: string, send: (token: string, data: string) => void) => {
        send("t", data);
        send("t", "live");
        return Promise.resolve();
      },
    );
    c.socket.pause();
    c.send({ type: "attach", id: "one", view: "v", request: 2 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    c.socket.resume();
    const responses = new RemoteMessages();
    const complete: unknown[] = [];
    const frames = new RemoteFrames();
    c.socket.on("data", (bytes: Buffer) => {
      frames.push(bytes, (wire) => {
        if (!remoteResponse(wire)) throw new Error("Invalid response");
        const response = responses.push(wire);
        if (response) complete.push(response);
      });
    });
    while (complete.length < 3) await once(c.socket, "data");
    expect(complete).toEqual([
      { type: "data", id: "one", view: "v", token: "t", data },
      { type: "data", id: "one", view: "v", token: "t", data: "live" },
      { type: "result", id: "one", request: 2, lines: [] },
    ]);
    expect(c.socket.destroyed).toBe(false);
    expect(mock.kill).not.toHaveBeenCalled();
  },
);

test.skipIf(process.platform === "win32")(
  "large valid tail results stream within the total bound without tripping the live backlog cap",
  async () => {
    await start();
    const c = await open();
    const lines = Array.from({ length: 10000 }, () => "λ".repeat(80));
    const expected = { type: "result", id: "one", request: 2, lines };
    expect(Buffer.byteLength(JSON.stringify(expected))).toBeGreaterThan(1024 * 1024);
    mock.tail.mockResolvedValueOnce(lines);
    const responses = new RemoteMessages();
    const frames = new RemoteFrames();
    const complete: unknown[] = [];
    c.socket.on("data", (bytes: Buffer) => {
      frames.push(bytes, (wire) => {
        if (!remoteResponse(wire)) throw new Error("Invalid response");
        const value = responses.push(wire);
        if (value) complete.push(value);
      });
    });
    c.send({ type: "tail", id: "one", request: 2, lines: 10000 });
    while (complete.length < 1) await once(c.socket, "data");
    expect(complete).toEqual([expected]);
    expect(c.socket.destroyed).toBe(false);
    c.send({ type: "write", id: "one", request: 3, data: "still attached" });
    while (complete.length < 2) await once(c.socket, "data");
    expect(mock.write).toHaveBeenCalledWith("one", "still attached");
  },
);

async function disconnect(c: Awaited<ReturnType<typeof client>>) {
  const closed = Promise.all([once(c.socket, "close"), once(c.serverSocket, "close")]);
  c.socket.destroy();
  await closed;
}

test.skipIf(process.platform === "win32")(
  "reaps detached sessions after the grace period and cancels reaping on reattach",
  async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await start();
    await disconnect(await open("abandoned"));
    await disconnect(await open("returning"));
    // A laptop disconnected overnight still owns a live shell.
    await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);
    expect(mock.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DETACHED_SESSION_GRACE_MS - 12 * 60 * 60 * 1000 - 1);
    expect(mock.kill).not.toHaveBeenCalled();
    const returning = await open("returning", true);
    await vi.advanceTimersByTimeAsync(1);
    expect(mock.stop).toHaveBeenCalledWith("abandoned");
    expect(mock.kill).toHaveBeenCalledExactlyOnceWith("abandoned");
    await vi.advanceTimersByTimeAsync(DETACHED_SESSION_GRACE_MS * 2);
    expect(mock.kill).toHaveBeenCalledTimes(1);
    returning.send({ type: "write", id: "returning", request: 2, data: "alive" });
    await returning.wait(3);
    expect(mock.write).toHaveBeenCalledWith("returning", "alive");
    await disconnect(returning);
    await vi.advanceTimersByTimeAsync(DETACHED_SESSION_GRACE_MS);
    expect(mock.kill).toHaveBeenCalledWith("returning");
  },
);

test.skipIf(process.platform === "win32")(
  "exited sessions free their slot when disconnected, including exit after disconnect",
  async () => {
    await start();
    const first = await open("exited-attached");
    mock.exited("exited-attached", 0);
    await first.wait(3);
    expect(mock.kill).not.toHaveBeenCalled();
    await disconnect(first);
    await vi.waitFor(() => {
      expect(mock.kill).toHaveBeenCalledWith("exited-attached");
    });
    const restored = await open("exited-attached", true);
    expect(restored.messages).toContainEqual({
      type: "open-result",
      id: "exited-attached",
      request: 1,
      state: "exited",
      code: 0,
    });
    expect(mock.create).toHaveBeenCalledTimes(1);
    const second = await open("exited-detached");
    await disconnect(second);
    mock.exited("exited-detached", 1);
    await vi.waitFor(() => {
      expect(mock.kill).toHaveBeenCalledWith("exited-detached");
    });
    const detached = await open("exited-detached", true);
    expect(detached.messages).toContainEqual({
      type: "open-result",
      id: "exited-detached",
      request: 1,
      state: "exited",
      code: 1,
    });
    expect(mock.create).toHaveBeenCalledTimes(2);
  },
);

test.skipIf(process.platform === "win32")(
  "recovers the 32 session limit after reaping, even if graceful stop fails",
  async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await start();
    for (let index = 0; index < 32; index++)
      await disconnect(await open(`orphan-${String(index)}`));
    const excess = await client();
    excess.send({ type: "hello", build });
    await excess.wait(1);
    const refused = once(excess.socket, "close");
    excess.send({ type: "open", reattach: false, id: "excess", request: 1, cols: 80, rows: 24 });
    await refused;
    expect(mock.create).toHaveBeenCalledTimes(32);
    mock.stop.mockRejectedValueOnce(new Error("graceful stop timeout"));
    await vi.advanceTimersByTimeAsync(DETACHED_SESSION_GRACE_MS);
    expect(mock.kill).toHaveBeenCalledTimes(32);
    await open("recovered");
    expect(mock.create).toHaveBeenCalledTimes(33);
  },
);

test.skipIf(process.platform === "win32")(
  "never puts the terminal capability in the shell environment, arguments or cwd",
  async () => {
    await start();
    const id = "secret-terminal-capability-85ac4f";
    await open(id);
    const spec: unknown = mock.create.mock.calls[0]?.[0];
    expect(spec).toEqual({ command: "/bin/sh", args: ["-i", "-l"], cwd: root, cols: 80, rows: 24 });
    expect(JSON.stringify(spec)).not.toContain(id);
    expect(JSON.stringify(process.env)).not.toContain(id);
  },
);

test.skipIf(process.platform === "win32")(
  "shutdown cancels orphan timers and owns disposal of shutdown exits",
  async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await start();
    await disconnect(await open("shutdown-orphan"));
    mock.shutdown.mockImplementationOnce(() => {
      mock.exited("shutdown-orphan", 0);
      return Promise.resolve();
    });
    await host.close();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(mock.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);

async function exitedDetached(id: string, code: number) {
  await disconnect(await open(id));
  mock.exited(id, code);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(mock.kill).toHaveBeenCalledWith(id);
}

test.skipIf(process.platform === "win32")(
  "reattach to expired or unknown IDs returns gone without creating a replacement",
  async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await start();
    await disconnect(await open("expired"));
    await vi.advanceTimersByTimeAsync(DETACHED_SESSION_GRACE_MS);
    for (const id of ["expired", "unknown"]) {
      const c = await open(id, true);
      expect(c.messages).toContainEqual({ type: "open-result", id, request: 1, state: "gone" });
      await disconnect(c);
    }
    expect(mock.create).toHaveBeenCalledTimes(1);
    const fresh = await open("new");
    expect(fresh.messages).toContainEqual({
      type: "open-result",
      id: "new",
      request: 1,
      state: "live",
    });
    expect(mock.create).toHaveBeenCalledTimes(2);
  },
);

test.skipIf(process.platform === "win32")(
  "tombstones preserve real exit codes, expire at the original detach deadline and never revive shells",
  async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await start();
    await disconnect(await open("overnight-exit"));
    await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);
    mock.exited("overnight-exit", 7);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const retained = await open("overnight-exit", true);
    expect(retained.messages).toContainEqual({
      type: "open-result",
      id: "overnight-exit",
      request: 1,
      state: "exited",
      code: 7,
    });
    await disconnect(retained);
    await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);
    const expired = await open("overnight-exit", true);
    expect(expired.messages).toContainEqual({
      type: "open-result",
      id: "overnight-exit",
      request: 1,
      state: "gone",
    });
    expect(mock.create).toHaveBeenCalledTimes(1);
  },
);

test.skipIf(process.platform === "win32")(
  "bounds tombstones to 64 oldest-first independently of 32 live sessions",
  async () => {
    await start();
    for (let i = 0; i < 65; i++) await exitedDetached(`exit-${String(i)}`, i);
    const oldest = await open("exit-0", true);
    expect(oldest.messages).toContainEqual({
      type: "open-result",
      id: "exit-0",
      request: 1,
      state: "gone",
    });
    await disconnect(oldest);
    for (const index of [1, 64]) {
      const retained = await open(`exit-${String(index)}`, true);
      expect(retained.messages).toContainEqual({
        type: "open-result",
        id: `exit-${String(index)}`,
        request: 1,
        state: "exited",
        code: index,
      });
      await disconnect(retained);
    }
    for (let i = 0; i < 32; i++) await disconnect(await open(`live-${String(i)}`));
    expect(mock.create).toHaveBeenCalledTimes(97);
  },
);

test.skipIf(process.platform === "win32")(
  "reattach while removal is pending returns gone without taking ownership or spawning",
  async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await start();
    await disconnect(await open());
    let finish: (() => void) | undefined;
    mock.stop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(DETACHED_SESSION_GRACE_MS);
    const restoring = await open("one", true);
    expect(restoring.messages).toContainEqual({
      type: "open-result",
      id: "one",
      request: 1,
      state: "gone",
    });
    expect(mock.create).toHaveBeenCalledOnce();
    finish?.();
  },
);

test.skipIf(process.platform === "win32")(
  "wire opens with missing or forged reattach fields are rejected",
  async () => {
    await start();
    for (const reattach of [undefined, null, 0, "true", {}]) {
      const c = await client();
      c.send({ type: "hello", build });
      await c.wait(1);
      const body = Buffer.from(
        JSON.stringify({
          version: 1,
          message: { type: "open", id: "forged", request: 1, cols: 80, rows: 24, reattach },
        }),
      );
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length);
      const closed = once(c.socket, "close");
      c.socket.write(Buffer.concat([header, body]));
      await closed;
    }
    expect(mock.create).not.toHaveBeenCalled();
  },
);

test.skipIf(process.platform === "win32")(
  "exit disposal finishing after expiry cannot create a late tombstone",
  async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await start();
    await disconnect(await open());
    let finish: (() => void) | undefined;
    mock.stop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    mock.exited("one", 7);
    await vi.advanceTimersByTimeAsync(DETACHED_SESSION_GRACE_MS);
    finish?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const expired = await open("one", true);
    expect(expired.messages).toContainEqual({
      type: "open-result",
      id: "one",
      request: 1,
      state: "gone",
    });
    expect(mock.create).toHaveBeenCalledOnce();
  },
);
