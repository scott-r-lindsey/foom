import type { HostResult } from "../../../../src/shared/registered-hosts.d";
import { LaunchFailure } from "../../../../src/shared/launch-failure";
import { hostDiscovery } from "../../../../src/terminal-host/remote/agent-discovery";
import type { TerminalTelemetry } from "../../../../src/shared/desktop";
import { endpointRequest } from "../../../../src/terminal-host/remote/agent-endpoint";
import { record } from "../../../../src/shared/remote-agent-protocol";
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
let telemetry: TerminalTelemetry = {};
const mock = vi.hoisted(() => ({
  manage: vi.fn(),
  owner: vi.fn(),
  legacy: vi.fn(),
  endLegacy: vi.fn(),
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
  childInput: vi.fn(),
  exited: (_id: string, _code: number) => {},
}));
vi.mock("../../../../src/terminal-host/remote/legacy", () => ({
  legacyDaemon: mock.legacy,
  endLegacyDaemon: mock.endLegacy,
}));
vi.mock("../../../../src/terminal-host/remote/management", () => ({ manageHost: mock.manage }));
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
    childInput = mock.childInput;
    constructor(exited: typeof mock.exited, events: TerminalTelemetry = {}) {
      mock.exited = exited;
      telemetry = events;
    }
  },
}));
vi.mock("../../../../src/terminal-host/remote/worktree-provenance", () => ({
  readWorktreeProvenance: mock.owner,
}));
vi.mock("../../../../src/terminal-host/remote/agent-discovery", () => ({
  hostLoginEnvironment: vi.fn(() => Promise.resolve({ PATH: "/fixture" })),
  hostEnvironment: () => ({ PATH: "/fixture" }),
  remoteCheckout: vi.fn(() => Promise.resolve("identity")),
  hostDiscovery: vi.fn(() =>
    Promise.resolve({
      command: "/fixture/claude",
      env: { PATH: "/fixture" },
      version: "2.1.296 (Claude Code)",
      help: "--settings --mcp-config",
    }),
  ),
  hostProbe: vi.fn(() => Promise.resolve("[]")),
}));
import { EXIT_TOMBSTONE_GRACE_MS, serveHost } from "../../../../src/terminal-host/remote/daemon";
let root: string;
let host: ReturnType<typeof serveHost>;
const clients: Socket[] = [];
const build = "a".repeat(64);
beforeEach(async () => {
  vi.clearAllMocks();
  mock.owner.mockReset().mockResolvedValue(undefined);
  mock.legacy.mockResolvedValue(undefined);
  mock.endLegacy.mockResolvedValue(undefined);
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
  const socket = createConnection(join(root, ".foom-host/host-v2.sock"));
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
  c.send({ type: "open", profile: "f".repeat(32), reattach, id, request: 1, cols: 80, rows: 24 });
  await c.wait(2);
  return c;
}
test.skipIf(process.platform === "win32")(
  "owns a private Unix socket and serial shell operations, retaining PTY across disconnect",
  async () => {
    await start();
    expect((await stat(join(root, ".foom-host/host-v2.sock"))).mode & 0o777).toBe(0o600);
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
    for (const message of [{ type: "write", id: "one", request: 1, data: "pre-auth" }] as const) {
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
    for (let index = 0; index < 4; index++) held.push(await client());
    const excessPending = await client();
    const disconnected = once(excessPending.socket, "close");
    await disconnected;
    expect(held.every((connection) => !connection.socket.destroyed)).toBe(true);
  },
);

test.skipIf(process.platform === "win32").each([false, true])(
  "bounds the reserve at full capacity and expires idle peers (negotiated: %s)",
  async (negotiated) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await start();
    const held = [];
    for (let index = 0; index < 32; index++) held.push(await open(`session-${String(index)}`));
    const pending = [];
    for (let index = 0; index < 4; index++) {
      const c = await client();
      if (negotiated) {
        c.send({ type: "hello", build });
        await c.wait(1);
      }
      pending.push(c);
    }
    const excess = await client();
    await once(excess.socket, "close");
    expect(pending.every((connection) => !connection.socket.destroyed)).toBe(true);
    const expired = pending.map((connection) => once(connection.socket, "close"));
    await vi.advanceTimersByTimeAsync(10000);
    await Promise.all(expired);
    expect(held.every((connection) => !connection.socket.destroyed)).toBe(true);
    const refused = await client();
    refused.send({ type: "hello", build });
    await refused.wait(1);
    const closed = once(refused.socket, "close");
    refused.send({ type: "open", reattach: false, id: "excess", request: 1, cols: 80, rows: 24 });
    await closed;
    expect(mock.create).toHaveBeenCalledTimes(32);
    const original = held[0];
    if (!original) throw new Error("Missing session");
    const replaced = once(original.socket, "close");
    const next = await open("session-0", true);
    await replaced;
    await vi.advanceTimersByTimeAsync(10000);
    next.send({ type: "tail", id: "session-0", request: 2, lines: 1 });
    await next.wait(3);
    expect(next.messages[2]).toEqual({
      type: "result",
      id: "session-0",
      request: 2,
      lines: ["tail"],
    });
    expect(mock.kill).not.toHaveBeenCalled();
  },
);

test.skipIf(process.platform === "win32").each(["close", "takeover"])(
  "%s succeeds with all 32 daemon sessions connected",
  async (operation) => {
    await start();
    const child = await client();
    child.send({ type: "hello", build });
    await child.wait(1);
    child.send({
      type: "agent-open",
      profile: "f".repeat(32),
      id: "child",
      request: 1,
      cols: 80,
      rows: 24,
      spec: { agent: "claude", repository: "/repo", worktree: "/tree", defaults: [], hooks: true },
    });
    await child.wait(2);
    child.send({ type: "agent-start", id: "child" });
    await child.wait(4);
    const held = [];
    for (let index = 0; index < 31; index++) held.push(await open(`session-${String(index)}`));
    const next = await client();
    next.send({ type: "hello", build });
    await vi.waitFor(() => {
      expect(next.messages).toContainEqual({ type: "hello", build, compatible: 2, hostFacts: 1 });
    });
    if (operation === "close") {
      next.send({ type: "agent-close", id: "child", request: 2 });
      await next.wait(2);
      expect(next.messages[1]).toEqual({ type: "result", id: "child", request: 2, lines: [] });
      expect(mock.stop).toHaveBeenCalledExactlyOnceWith("child");
      expect(mock.kill).toHaveBeenCalledExactlyOnceWith("child");
    } else {
      const replaced = once(child.socket, "close");
      next.send({
        type: "open",
        profile: "f".repeat(32),
        id: "child",
        reattach: true,
        request: 2,
        cols: 80,
        rows: 24,
      });
      await next.wait(3);
      await replaced;
      expect(next.messages).toContainEqual({
        type: "open-result",
        id: "child",
        request: 2,
        state: "live",
      });
      expect(mock.detach).toHaveBeenCalledWith("child");
      expect(mock.stop).not.toHaveBeenCalled();
      expect(mock.kill).not.toHaveBeenCalled();
    }
    expect(mock.create).toHaveBeenCalledTimes(32);
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
  "detached live sessions retain their PTYs indefinitely with no expiry timers",
  async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await start();
    await disconnect(await open("abandoned"));
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(EXIT_TOMBSTONE_GRACE_MS * 30);
    expect(mock.stop).not.toHaveBeenCalled();
    expect(mock.kill).not.toHaveBeenCalled();
    const returning = await open("abandoned", true);
    returning.send({ type: "write", id: "abandoned", request: 2, data: "alive" });
    await returning.wait(3);
    expect(mock.write).toHaveBeenCalledWith("abandoned", "alive");
    await disconnect(returning);
    expect(vi.getTimerCount()).toBe(0);
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
  "retains the session limit until explicit removal, even after long disconnect",
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
    await vi.advanceTimersByTimeAsync(EXIT_TOMBSTONE_GRACE_MS * 30);
    expect(mock.kill).not.toHaveBeenCalled();
    const owned = await open("orphan-0", true);
    owned.send({ type: "kill", id: "orphan-0", request: 2 });
    await owned.wait(3);
    await disconnect(owned);
    expect(mock.kill).toHaveBeenCalledTimes(1);
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
    await exitedDetached("expired", 0);
    await vi.advanceTimersByTimeAsync(EXIT_TOMBSTONE_GRACE_MS);
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
  "tombstones retain real exit codes for a bounded interval after exit without renewal",
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
    await vi.advanceTimersByTimeAsync(EXIT_TOMBSTONE_GRACE_MS);
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
    const owner = await open();
    let finish: (() => void) | undefined;
    mock.stop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    owner.send({ type: "kill", id: "one", request: 2 });
    await new Promise<void>((resolve) => setImmediate(resolve));
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
          version: 3,
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
    await vi.advanceTimersByTimeAsync(EXIT_TOMBSTONE_GRACE_MS);
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

test.skipIf(process.platform === "win32")(
  "prepares without spawning, awaits hub authorization, relays private hook/control endpoints and permits validated child input",
  async () => {
    await start();
    const c = await client();
    const id = "agent-secret-terminal";
    c.send({ type: "hello", build });
    await c.wait(1);
    c.send({
      type: "agent-open",
      profile: "f".repeat(32),
      id,
      request: 1,
      cols: 80,
      rows: 24,
      spec: {
        agent: "claude",
        repository: "/remote/repo",
        worktree: "/remote/tree",
        defaults: [],
        hooks: true,
        prompt: "Task",
      },
    });
    await c.wait(2);
    expect(c.messages[1]).toEqual({ type: "agent-prepared", id });
    expect(mock.create).not.toHaveBeenCalled();
    c.send({ type: "agent-start", id });
    await c.wait(4);
    expect(mock.create).toHaveBeenCalledOnce();
    const created: unknown = mock.create.mock.calls[0]?.[0];
    if (!record(created) || !record(created["env"]))
      throw new Error("Missing agent process environment");
    expect(JSON.stringify(created)).not.toContain(id);
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(created["env"]))
      if (typeof value === "string") env[name] = value;
    const ready = c.messages.find((value) => remoteResponse(value) && value.type === "agent-ready");
    if (!remoteResponse(ready) || ready.type !== "agent-ready")
      throw new Error("Missing remote metadata");
    c.send({ type: "agent-activate", id });
    const pending = endpointRequest("/call", { method: "whoami", params: {} }, env);
    await c.wait(5);
    const call = c.messages[4];
    if (!remoteResponse(call) || call.type !== "agent-call") throw new Error("Missing relay call");
    const identity = {
      type: "identity" as const,
      alias: "11111111-1111-4111-8111-111111111111",
      role: "child" as const,
      capabilities: ["whoami", "manual", "handoff"],
    };
    c.send({ type: "agent-reply", id, call: call.call, result: identity });
    expect(await pending).toEqual(identity);
    expect(JSON.stringify(await pending)).not.toContain(id);
    await endpointRequest(
      "/hook",
      {
        channel: "lifecycle",
        payload: {
          session_id: "remote-conversation",
          hook_event_name: "PermissionRequest",
          transcript_path: "/never/read",
        },
      },
      env,
    );
    await c.wait(6);
    expect(c.messages[5]).toMatchObject({
      type: "agent-hook",
      id,
      signal: { terminalId: id, action: "needs_input" },
    });
    expect(JSON.stringify(c.messages)).not.toContain("/never/read");
    c.send({ type: "child-input", id, request: 2, input: { kind: "prompt", text: "Follow-up" } });
    await c.wait(7);
    expect(mock.childInput).toHaveBeenCalledWith(id, { kind: "prompt", text: "Follow-up" });
    const closed = once(c.socket, "close");
    c.socket.destroy();
    await closed;
    await vi.waitFor(() => {
      expect(mock.detach).toHaveBeenCalledWith(id);
    });
    expect(await endpointRequest("/call", { method: "manual", params: {} }, env)).toEqual({
      type: "error",
      error: "unavailable",
    });
    await endpointRequest(
      "/hook",
      {
        channel: "lifecycle",
        payload: { session_id: "remote-conversation", hook_event_name: "Stop" },
      },
      env,
    );
    const restored = await open(id, true);
    await restored.wait(4);
    const resumedHook = restored.messages.find(
      (value) => remoteResponse(value) && value.type === "agent-hook",
    );
    expect(resumedHook).toMatchObject({ type: "agent-hook", signal: { action: "classify" } });
    expect(mock.create).toHaveBeenCalledOnce();
    mock.exited(id, 0);
    await restored.wait(5);
    await expect(endpointRequest("/call", { method: "whoami", params: {} }, env)).rejects.toThrow();
  },
);

test.skipIf(process.platform === "win32")(
  "a cancelled or timed-out preparation never starts a PTY or leaves a reconnectable agent",
  async () => {
    await start();
    const c = await client();
    c.send({ type: "hello", build });
    await c.wait(1);
    c.send({
      type: "agent-open",
      profile: "f".repeat(32),
      id: "cancelled",
      request: 1,
      cols: 80,
      rows: 24,
      spec: { agent: "claude", repository: "/repo", worktree: "/tree", defaults: [], hooks: true },
    });
    await c.wait(2);
    const closed = once(c.socket, "close");
    c.socket.destroy();
    await closed;
    const next = await open("cancelled", true);
    expect(next.messages[1]).toMatchObject({ type: "open-result", state: "gone" });
    expect(mock.create).not.toHaveBeenCalled();
    next.send({ type: "agent-start", id: "cancelled" });
    await once(next.socket, "close");
  },
);

test.skipIf(process.platform === "win32")(
  "remote telemetry reaches the owning hub without a view and ignores foreign activity",
  async () => {
    await start();
    const c = await open("telemetry");
    telemetry.onOutput?.("telemetry");
    telemetry.onQuiet?.("telemetry");
    telemetry.onEvidence?.("telemetry", { title: "Working", progress: null });
    telemetry.onActivity?.([
      { id: "telemetry", rate: 1 },
      { id: "foreign", rate: 2 },
    ]);
    await c.wait(6);
    expect(c.messages).toContainEqual({ type: "output", id: "telemetry" });
    expect(c.messages).toContainEqual({ type: "quiet", id: "telemetry" });
    expect(c.messages).toContainEqual({
      type: "evidence",
      id: "telemetry",
      evidence: { title: "Working", progress: null },
    });
    expect(c.messages).toContainEqual({
      type: "activity",
      entries: [{ id: "telemetry", rate: 1 }],
    });
  },
);

test.skipIf(process.platform === "win32")(
  "a fresh cleanup connection terminates a detached remote child and revokes its private assets",
  async () => {
    await start();
    const c = await client();
    c.send({ type: "hello", build });
    await c.wait(1);
    c.send({
      type: "agent-open",
      profile: "f".repeat(32),
      id: "detached",
      request: 1,
      cols: 80,
      rows: 24,
      spec: {
        agent: "claude",
        repository: "/remote/repo",
        worktree: "/remote/tree",
        defaults: [],
        hooks: true,
      },
    });
    await c.wait(2);
    c.send({ type: "agent-start", id: "detached" });
    await c.wait(4);
    const created: unknown = mock.create.mock.calls[0]?.[0];
    if (!record(created) || !record(created["env"])) throw new Error("Missing environment");
    const socket = created["env"]["FOOM_REMOTE_SOCKET"];
    if (typeof socket !== "string") throw new Error("Missing endpoint");
    c.socket.destroy();
    await once(c.socket, "close");
    const cleanup = await client();
    cleanup.send({ type: "hello", build });
    await cleanup.wait(1);
    cleanup.send({ type: "agent-close", id: "detached", request: 2 });
    await cleanup.wait(2);
    expect(cleanup.messages[1]).toEqual({ type: "result", id: "detached", request: 2, lines: [] });
    expect(mock.stop).toHaveBeenCalledWith("detached");
    expect(mock.kill).toHaveBeenCalledWith("detached");
    await expect(stat(socket)).rejects.toThrow();
    expect(mock.create).toHaveBeenCalledOnce();
    cleanup.send({ type: "agent-close", id: "detached", request: 3 });
    await cleanup.wait(3);
    expect(cleanup.messages[2]).toMatchObject({ type: "result", request: 3 });
  },
);

test.skipIf(process.platform === "win32")(
  "refuses cleanup of shell sessions without terminating them",
  async () => {
    await start();
    const shell = await open("shell");
    const cleanup = await client();
    cleanup.send({ type: "hello", build });
    await cleanup.wait(1);
    const closed = once(cleanup.socket, "close");
    cleanup.send({ type: "agent-close", id: "shell", request: 1 });
    await closed;
    expect(mock.kill).not.toHaveBeenCalled();
    expect(shell.socket.destroyed).toBe(false);
  },
);

test.skipIf(process.platform === "win32").each(["missing", "prepare", "start"])(
  "returns fixed %s launch refusals without private host text",
  async (stage) => {
    await start();
    if (stage === "missing")
      vi.mocked(hostDiscovery).mockRejectedValueOnce(new LaunchFailure("remote_agent_unavailable"));
    if (stage === "prepare")
      vi.mocked(hostDiscovery).mockRejectedValueOnce(new Error("PRIVATE HOST STDERR"));
    if (stage === "start")
      mock.create.mockImplementationOnce(() => {
        throw new Error("PRIVATE SPAWN STDERR");
      });
    const c = await client();
    c.send({ type: "hello", build });
    await c.wait(1);
    c.send({
      type: "agent-open",
      profile: "f".repeat(32),
      id: "failed",
      request: 1,
      cols: 80,
      rows: 24,
      spec: { agent: "claude", repository: "/repo", worktree: "/tree", defaults: [], hooks: false },
    });
    await c.wait(2);
    if (stage === "start") {
      c.send({ type: "agent-start", id: "failed" });
      await c.wait(3);
    }
    expect(c.messages.at(-1)).toEqual({
      type: "agent-failed",
      id: "failed",
      reason:
        stage === "missing"
          ? "remote_agent_unavailable"
          : stage === "prepare"
            ? "remote_prepare_refused"
            : "remote_start_refused",
    });
    expect(JSON.stringify(c.messages)).not.toContain("PRIVATE");
  },
);

test.skipIf(process.platform === "win32")(
  "management reports live sessions without opening, detaching or killing a PTY",
  async () => {
    await start();
    const live = await open();
    mock.manage.mockImplementation((_request: unknown, sessions: number) =>
      Promise.resolve({
        ok: true,
        facts: {
          codeFolder: "/code",
          version: "0.1.0",
          sessions,
          cores: 4,
          load: [0, 0, 0],
          memoryTotal: 8000,
          memoryAvailable: 4000,
          agents: [],
        },
      }),
    );
    const management = await client();
    management.send({ type: "hello", build });
    await management.wait(1);
    management.send({ type: "manage", operation: "inspect", codeFolder: "/code" });
    await management.wait(2);
    expect(management.messages[1]).toMatchObject({
      type: "managed",
      result: { ok: true, facts: { sessions: 1 } },
    });
    management.socket.destroy();
    expect(mock.create).toHaveBeenCalledTimes(1);
    expect(mock.stop).not.toHaveBeenCalled();
    expect(mock.kill).not.toHaveBeenCalled();
    const closed = once(live.serverSocket, "close");
    live.send({ type: "manage", operation: "inspect", codeFolder: "/code" });
    await closed;
    expect(mock.manage).toHaveBeenCalledTimes(1);
  },
);

test.skipIf(process.platform === "win32")(
  "remote removal refuses prepared and live worktrees, and reserves the path against new launches",
  async () => {
    await start();
    const c = await client();
    c.send({ type: "hello", build });
    await c.wait(1);
    const agent = {
      agent: "claude",
      repository: "/remote/repo",
      worktree: "/remote/tree",
      defaults: [],
      hooks: false,
    };
    c.send({
      type: "agent-open",
      profile: "f".repeat(32),
      id: "owned",
      request: 1,
      cols: 80,
      rows: 24,
      spec: agent,
    });
    await c.wait(2);
    const m = await client();
    m.send({ type: "hello", build });
    await m.wait(1);
    const request = {
      type: "manage",
      operation: "remove-worktree",
      profile: "a".repeat(32),
      codeFolder: "/remote",
      directory: "repo",
      origin: "git@fixture.test:team/repo.git",
      path: agent.worktree,
      identity: "a".repeat(64),
      changes: "",
    } as const;
    m.send(request);
    await m.wait(2);
    expect(m.messages[1]).toEqual({
      type: "managed",
      result: { ok: false, reason: "checkout-refused" },
    });
    expect(mock.manage).not.toHaveBeenCalled();
    c.send({ type: "agent-start", id: "owned" });
    await c.wait(4);
    m.send(request);
    await m.wait(3);
    expect(m.messages[2]).toEqual(m.messages[1]);
    expect(mock.manage).not.toHaveBeenCalled();
    const stopped = Promise.withResolvers<boolean>();
    mock.stop.mockReturnValueOnce(stopped.promise);
    const closing = await client();
    closing.send({ type: "hello", build });
    await closing.wait(1);
    closing.send({ type: "agent-close", id: "owned", request: 2 });
    await vi.waitFor(() => {
      expect(mock.stop).toHaveBeenCalledWith("owned");
    });
    m.send(request);
    await m.wait(4);
    expect(m.messages[3]).toEqual(m.messages[1]);
    expect(mock.manage).not.toHaveBeenCalled();
    stopped.resolve(true);
    await closing.wait(2);
    const pending = Promise.withResolvers<HostResult>();
    mock.manage.mockReturnValueOnce(pending.promise);
    m.send(request);
    await vi.waitFor(() => {
      expect(mock.manage).toHaveBeenCalledOnce();
    });
    const blocked = await client();
    blocked.send({ type: "hello", build });
    await blocked.wait(1);
    blocked.send({
      type: "agent-open",
      profile: "f".repeat(32),
      id: "blocked",
      request: 1,
      cols: 80,
      rows: 24,
      spec: agent,
    });
    await blocked.wait(2);
    expect(blocked.messages[1]).toMatchObject({
      type: "agent-failed",
      reason: "remote_prepare_refused",
    });
    expect(mock.create).toHaveBeenCalledOnce();
    pending.resolve({ ok: false, reason: "checkout-refused" });
    await m.wait(5);
  },
);

test.skipIf(process.platform === "win32").each([
  ["clone", "inspect-worktree"],
  ["inspect", "inspect-worktree"],
  ["clone", "list-worktrees"],
  ["inspect", "list-worktrees"],
] as const)(
  "read-only %s / %s inspections overlap without releasing or taking the mutation reserve",
  async (operation, read) => {
    await start();
    const cloning = Promise.withResolvers<HostResult>();
    const inspecting = Promise.withResolvers<HostResult>();
    mock.manage
      .mockReturnValueOnce(cloning.promise)
      .mockReturnValueOnce(inspecting.promise)
      .mockResolvedValue({ ok: false, reason: "checkout-refused" });
    try {
      const connections = [];
      for (let index = 0; index < 4; index++) {
        const c = await client();
        c.send({ type: "hello", build });
        await c.wait(1);
        connections.push(c);
      }
      const [clone, first, second, retry] = connections;
      if (!clone || !first || !second || !retry) throw new Error("Missing fixture connection");
      const request = {
        type: "manage",
        operation: "clone",
        codeFolder: "/code",
        directory: "repo",
        origin: "git@fixture.test:team/repo.git",
      } as const;
      const mutation =
        operation === "inspect"
          ? ({ type: "manage", operation, codeFolder: "/code" } as const)
          : request;
      clone.send(mutation);
      await vi.waitFor(() => {
        expect(mock.manage).toHaveBeenCalledOnce();
      });
      const inspection = {
        ...request,
        operation: "inspect-worktree",
        profile: "a".repeat(32),
        path: "/code/.foom-worktree-fixture",
        identity: "a".repeat(64),
      } as const;
      const readRequest =
        read === "list-worktrees"
          ? {
              type: "manage" as const,
              operation: read,
              codeFolder: "/code",
              profile: "a".repeat(32),
            }
          : inspection;
      first.send(readRequest);
      await vi.waitFor(() => {
        expect(mock.manage).toHaveBeenCalledTimes(2);
      });
      second.send(readRequest);
      await second.wait(2);
      expect(mock.manage).toHaveBeenCalledTimes(3);
      inspecting.resolve({ ok: false, reason: "checkout-refused" });
      await first.wait(2);
      // Neither a concurrent inspection nor its completion may unlock the clone.
      retry.send(mutation);
      await retry.wait(2);
      expect(mock.manage).toHaveBeenCalledTimes(3);
      expect(retry.messages[1]).toMatchObject({
        type: "managed",
        result: { ok: false, reason: "checkout-refused" },
      });
      cloning.resolve({ ok: false, reason: "clone-failed" });
      await clone.wait(2);
      retry.send(mutation);
      await retry.wait(3);
      expect(mock.manage).toHaveBeenCalledTimes(4);
    } finally {
      cloning.resolve({ ok: false, reason: "clone-failed" });
      inspecting.resolve({ ok: false, reason: "checkout-refused" });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "profile tags isolate inventory and reattach; End uses confirmed incarnation snapshots",
  async () => {
    await start();
    const profile = "a".repeat(32);
    const other = "b".repeat(32);
    async function tagged(id: string, tag: string) {
      const c = await client();
      c.send({ type: "hello", build });
      await c.wait(1);
      c.send({
        type: "open",
        id,
        request: 1,
        cols: 80,
        rows: 24,
        reattach: false,
        profile: tag,
        context: { repository: "/repo", worktree: "/tree", branch: "topic", agent: "shell" },
      });
      await c.wait(2);
      await disconnect(c);
    }
    await tagged("mine", profile);
    await tagged("other", other);
    await disconnect(await open("legacy"));
    const query = await client();
    query.send({ type: "hello", build });
    await query.wait(1);
    query.send({ type: "inventory", profile });
    await query.wait(2);
    const result: unknown = query.messages[1];
    if (!remoteResponse(result) || result.type !== "inventory-result")
      throw new Error("missing inventory");
    expect(result.own.map((entry) => entry.id)).toEqual(["mine"]);
    expect(result.foreign.map((entry) => entry.id)).toEqual(["other", "legacy"]);
    expect(JSON.stringify(mock.create.mock.calls)).not.toContain(profile);
    const wrong = await client();
    wrong.send({ type: "hello", build });
    await wrong.wait(1);
    const closed = once(wrong.socket, "close");
    wrong.send({
      type: "open",
      id: "mine",
      request: 1,
      reattach: true,
      profile: other,
      cols: 80,
      rows: 24,
    });
    await closed;
    await tagged("arrived-after-confirmation", other);
    query.send({ type: "end-sessions", profile, ids: result.foreign });
    await query.wait(3);
    expect(mock.kill).toHaveBeenCalledWith("other");
    expect(mock.kill).toHaveBeenCalledWith("legacy");
    expect(mock.kill).not.toHaveBeenCalledWith("mine");
    expect(mock.kill).not.toHaveBeenCalledWith("arrived-after-confirmation");
    const forged = await client();
    forged.send({ type: "hello", build });
    await forged.wait(1);
    const refused = once(forged.socket, "close");
    forged.send({ type: "end-sessions", profile, ids: [{ id: "mine", generation: profile }] });
    await refused;
    expect(mock.kill).not.toHaveBeenCalledWith("mine");
  },
);

test.skipIf(process.platform === "win32")(
  "a newer hub negotiates with the live old daemon and idle upgrades close the listener",
  async () => {
    await start();
    const shell = await open();
    const newer = await client();
    newer.send({ type: "hello", build: "b".repeat(64) });
    await newer.wait(1);
    expect(newer.messages[0]).toEqual({ type: "hello", build, compatible: 2, hostFacts: 1 });
    expect(mock.stop).not.toHaveBeenCalled();
    await disconnect(newer);
    shell.send({ type: "kill", id: "one", request: 2 });
    await shell.wait(3);
    await disconnect(shell);
    const idle = await client();
    const closed = once(idle.socket, "close");
    idle.send({ type: "hello", build: "b".repeat(64) });
    await closed;
    expect(idle.messages).toContainEqual({ type: "upgrade", build });
    await host.close();
    expect(host.server.listening).toBe(false);
  },
);

test.skipIf(process.platform === "win32")(
  "legacy daemon counts are separate, never upgraded automatically, and End is explicitly scoped",
  async () => {
    await start();
    const old = { executable: "/cache/foom-host", pid: 42, started: "fixed-start", count: 2 };
    mock.legacy.mockResolvedValue(old);
    const c = await client();
    c.send({ type: "hello", build });
    await c.wait(1);
    c.send({ type: "inventory", profile: "a".repeat(32), codeFolder: "/code" });
    await c.wait(2);
    const first = c.messages[1];
    if (!remoteResponse(first) || first.type !== "inventory-result")
      throw new Error("No inventory");
    expect(first.foreign[0]?.count).toBe(2);
    expect(mock.endLegacy).not.toHaveBeenCalled();
    mock.legacy.mockResolvedValueOnce({ ...old, count: 3 });
    c.send({ type: "inventory", profile: "a".repeat(32), codeFolder: "/code" });
    await c.wait(3);
    const second = c.messages[2];
    if (!remoteResponse(second) || second.type !== "inventory-result")
      throw new Error("No inventory");
    expect(second.foreign[0]).toMatchObject({ ...first.foreign[0], count: 3 });
    c.send({ type: "end-sessions", profile: "a".repeat(32), ids: second.foreign });
    await c.wait(4);
    expect(mock.endLegacy).toHaveBeenCalledExactlyOnceWith(
      { ...old, count: 3 },
      expect.any(AbortSignal),
    );
    expect(mock.kill).not.toHaveBeenCalled();
    expect(mock.create).not.toHaveBeenCalled();
  },
);

test.skipIf(process.platform === "win32")(
  "profile-scoped Close handles shells and tombstones, refuses foreign profiles, and releases timers",
  async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await start();
    const profile = "f".repeat(32);
    await disconnect(await open("shell"));
    const c = await client();
    c.send({ type: "hello", build });
    await c.wait(1);
    c.send({ type: "session-close", id: "shell", request: 2, profile });
    await c.wait(2);
    expect(mock.kill).toHaveBeenCalledWith("shell");
    await disconnect(c);
    await exitedDetached("exited", 7);
    const foreign = await client();
    foreign.send({ type: "hello", build });
    await foreign.wait(1);
    const closed = once(foreign.socket, "close");
    foreign.send({ type: "session-close", id: "exited", request: 2, profile: "a".repeat(32) });
    await closed;
    const retained = await open("exited", true);
    expect(retained.messages).toContainEqual({
      type: "open-result",
      id: "exited",
      request: 1,
      state: "exited",
      code: 7,
    });
    await disconnect(retained);
    const cleanup = await client();
    cleanup.send({ type: "hello", build });
    await cleanup.wait(1);
    cleanup.send({ type: "session-close", id: "exited", request: 2, profile });
    await cleanup.wait(2);
    await disconnect(cleanup);
    expect(vi.getTimerCount()).toBe(0);
    const gone = await open("exited", true);
    expect(gone.messages).toContainEqual({
      type: "open-result",
      id: "exited",
      request: 1,
      state: "gone",
    });
  },
);

test.skipIf(process.platform === "win32")(
  "management budgets expire, abort, and retain reservations through disconnected cleanup",
  async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await start();
    const pending = Promise.withResolvers<HostResult>();
    let signal: AbortSignal | undefined;
    mock.manage.mockImplementationOnce(
      (
        _request: unknown,
        _sessions: number,
        _shell: string,
        _version: string,
        _home: string,
        cancellation: AbortSignal,
      ) => {
        signal = cancellation;
        return pending.promise;
      },
    );
    const c = await client();
    c.send({ type: "hello", build });
    await c.wait(1);
    const request = {
      type: "manage",
      operation: "clone",
      codeFolder: "/code",
      directory: "repo",
      origin: "git@fixture.test:team/repo.git",
    } as const;
    c.send(request);
    await vi.waitFor(() => {
      expect(mock.manage).toHaveBeenCalledOnce();
    });
    await vi.advanceTimersByTimeAsync(11000);
    expect(signal?.aborted).toBe(false);
    const closed = once(c.socket, "close");
    await vi.advanceTimersByTimeAsync(7 * 60 * 1000 - 11000);
    await closed;
    expect(signal?.aborted).toBe(true);
    const retry = await client();
    retry.send({ type: "hello", build });
    await retry.wait(1);
    retry.send(request);
    await retry.wait(2);
    expect(retry.messages[1]).toMatchObject({
      type: "managed",
      result: { ok: false, reason: "checkout-refused" },
    });
    expect(mock.manage).toHaveBeenCalledOnce();
    pending.resolve({ ok: false, reason: "clone-failed" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    mock.manage.mockResolvedValue({ ok: false, reason: "clone-failed" });
    retry.send(request);
    await retry.wait(3);
    expect(mock.manage).toHaveBeenCalledTimes(2);
  },
);

test.skipIf(process.platform === "win32").each([false, true])(
  "preparation has its own budget past the handshake (expire: %s)",
  async (expire) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await start();
    const discovery = Promise.withResolvers<Awaited<ReturnType<typeof hostDiscovery>>>();
    vi.mocked(hostDiscovery).mockReturnValueOnce(discovery.promise);
    const c = await client();
    c.send({ type: "hello", build });
    await c.wait(1);
    c.send({
      type: "agent-open",
      profile: "f".repeat(32),
      id: "slow",
      request: 1,
      cols: 80,
      rows: 24,
      spec: {
        agent: "claude",
        repository: "/remote/repo",
        worktree: "/remote/tree",
        defaults: [],
        hooks: false,
      },
    });
    await vi.waitFor(() => {
      expect(hostDiscovery).toHaveBeenCalled();
    });
    await vi.advanceTimersByTimeAsync(11000);
    expect(c.socket.destroyed).toBe(false);
    if (expire) {
      const closed = once(c.socket, "close");
      await vi.advanceTimersByTimeAsync(120000 - 11000);
      await closed;
    }
    discovery.resolve({
      command: "/fixture/claude",
      env: { PATH: "/fixture" },
      version: "2.1.296 (Claude Code)",
      help: "--settings --mcp-config",
    });
    if (!expire) {
      await c.wait(2);
      expect(c.messages[1]).toEqual({ type: "agent-prepared", id: "slow" });
      c.send({ type: "agent-start", id: "slow" });
      await c.wait(4);
      expect(mock.create).toHaveBeenCalledOnce();
    } else {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(mock.create).not.toHaveBeenCalled();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "new sessions require an owning profile before any PTY is created",
  async () => {
    await start();
    const c = await client();
    c.send({ type: "hello", build });
    await c.wait(1);
    const closed = once(c.socket, "close");
    c.send({ type: "open", id: "untagged", request: 1, reattach: false, cols: 80, rows: 24 });
    await closed;
    expect(mock.create).not.toHaveBeenCalled();
  },
);

test.skipIf(process.platform === "win32")(
  "disconnected management work still consumes the bounded operation reserve",
  async () => {
    await start();
    const pending = Promise.withResolvers<HostResult>();
    mock.manage.mockReturnValue(pending.promise);
    for (let index = 0; index < 4; index++) {
      const c = await client();
      c.send({ type: "hello", build });
      await c.wait(1);
      c.send({
        type: "manage",
        operation: "repository",
        codeFolder: "/code",
        directory: "repo",
        origin: "git@fixture.test:team/repo.git",
      });
      await vi.waitFor(() => {
        expect(mock.manage).toHaveBeenCalledTimes(index + 1);
      });
      const closed = once(c.serverSocket, "close");
      c.socket.destroy();
      await closed;
    }
    const excess = await client();
    excess.send({ type: "hello", build });
    await excess.wait(1);
    excess.send({
      type: "manage",
      operation: "repository",
      codeFolder: "/code",
      directory: "repo",
      origin: "git@fixture.test:team/repo.git",
    });
    await excess.wait(2);
    expect(excess.messages[1]).toMatchObject({
      type: "managed",
      result: { ok: false, reason: "checkout-refused" },
    });
    expect(mock.manage).toHaveBeenCalledTimes(4);
    pending.resolve({ ok: false, reason: "unreachable" });
  },
);

test.skipIf(process.platform === "win32").each(["inventory", "end-sessions"] as const)(
  "%s gets seven minutes, propagates abort and retains its reservation until settlement",
  async (type) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await start();
    const pending = Promise.withResolvers<undefined>();
    let signal: AbortSignal | undefined;
    const c = await client();
    c.send({ type: "hello", build });
    await c.wait(1);
    try {
      if (type === "inventory") {
        mock.legacy.mockImplementationOnce(
          (_home: string, _folder: string, cancellation: AbortSignal) => {
            signal = cancellation;
            return pending.promise;
          },
        );
        c.send({ type, profile: "a".repeat(32), codeFolder: "/code" });
      } else {
        mock.legacy.mockResolvedValueOnce({
          executable: "/cache/foom-host",
          pid: 100,
          started: "fixture",
          count: 1,
        });
        c.send({ type: "inventory", profile: "a".repeat(32), codeFolder: "/code" });
        await c.wait(2);
        const inventory = c.messages[1];
        if (!remoteResponse(inventory) || inventory.type !== "inventory-result")
          throw new Error("Missing inventory");
        mock.endLegacy.mockImplementationOnce((_daemon: unknown, cancellation: AbortSignal) => {
          signal = cancellation;
          return pending.promise;
        });
        c.send({ type, profile: "a".repeat(32), ids: inventory.foreign });
      }
      await vi.waitFor(() => {
        expect(signal).toBeDefined();
      });
      await vi.advanceTimersByTimeAsync(11000);
      expect(signal?.aborted).toBe(false);
      expect(c.socket.destroyed).toBe(false);
      const closed = once(c.socket, "close");
      await vi.advanceTimersByTimeAsync(7 * 60 * 1000 - 11000);
      await closed;
      expect(signal?.aborted).toBe(true);
      // End is serialized with repository mutations even after its client expires.
      if (type === "end-sessions") {
        const retry = await client();
        retry.send({ type: "hello", build });
        await retry.wait(1);
        retry.send({
          type: "manage",
          operation: "clone",
          codeFolder: "/code",
          directory: "repo",
          origin: "git@fixture.test:repo.git",
        });
        await retry.wait(2);
        expect(retry.messages[1]).toMatchObject({
          type: "managed",
          result: { ok: false, reason: "checkout-refused" },
        });
        expect(mock.manage).not.toHaveBeenCalled();
      }
    } finally {
      pending.resolve(undefined);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  },
);

test.skipIf(process.platform === "win32")(
  "cancelled inventory stays reserved and prevents idle daemon retirement until its work settles",
  async () => {
    await start();
    const pending = Promise.withResolvers<undefined>();
    let signal: AbortSignal | undefined;
    mock.legacy.mockImplementationOnce(
      (_home: string, _folder: string, cancellation: AbortSignal) => {
        signal = cancellation;
        return pending.promise;
      },
    );
    try {
      const c = await client();
      c.send({ type: "hello", build });
      await c.wait(1);
      c.send({ type: "inventory", profile: "a".repeat(32), codeFolder: "/code" });
      await vi.waitFor(() => {
        expect(signal).toBeDefined();
      });
      const closed = once(c.serverSocket, "close");
      c.socket.destroy();
      await closed;
      expect(signal?.aborted).toBe(true);
      const newer = await client();
      newer.send({ type: "hello", build: "b".repeat(64) });
      await newer.wait(1);
      expect(newer.messages[0]).toEqual({ type: "hello", build, compatible: 2, hostFacts: 1 });
      expect(host.server.listening).toBe(true);
    } finally {
      pending.resolve(undefined);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  },
);

test.skipIf(process.platform === "win32")(
  "disconnected inventories share the bounded operation reserve with management",
  async () => {
    await start();
    const pending = Promise.withResolvers<undefined>();
    mock.legacy.mockReturnValue(pending.promise);
    try {
      for (let index = 0; index < 4; index++) {
        const c = await client();
        c.send({ type: "hello", build });
        await c.wait(1);
        c.send({ type: "inventory", profile: "a".repeat(32), codeFolder: "/code" });
        await vi.waitFor(() => {
          expect(mock.legacy).toHaveBeenCalledTimes(index + 1);
        });
        const closed = once(c.serverSocket, "close");
        c.socket.destroy();
        await closed;
      }
      const excess = await client();
      excess.send({ type: "hello", build });
      await excess.wait(1);
      excess.send({ type: "manage", operation: "inspect", codeFolder: "/code" });
      await excess.wait(2);
      expect(excess.messages[1]).toMatchObject({
        type: "managed",
        result: { ok: false, reason: "checkout-refused" },
      });
      expect(mock.manage).not.toHaveBeenCalled();
    } finally {
      pending.resolve(undefined);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  },
);

test.skipIf(process.platform === "win32")(
  "aborted End does not start stopping later confirmed sessions",
  async () => {
    await start();
    await disconnect(await open("first"));
    await disconnect(await open("second"));
    const c = await client();
    c.send({ type: "hello", build });
    await c.wait(1);
    c.send({ type: "inventory", profile: "a".repeat(32) });
    await c.wait(2);
    const inventory = c.messages[1];
    if (!remoteResponse(inventory) || inventory.type !== "inventory-result")
      throw new Error("Missing inventory");
    const pending = Promise.withResolvers<boolean>();
    mock.stop.mockReturnValueOnce(pending.promise);
    try {
      c.send({ type: "end-sessions", profile: "a".repeat(32), ids: inventory.foreign });
      await vi.waitFor(() => {
        expect(mock.stop).toHaveBeenCalledExactlyOnceWith("first");
      });
      const closed = once(c.serverSocket, "close");
      c.socket.destroy();
      await closed;
    } finally {
      pending.resolve(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(mock.stop).toHaveBeenCalledOnce();
    expect(mock.kill).not.toHaveBeenCalledWith("second");
    const query = await client();
    query.send({ type: "hello", build });
    await query.wait(1);
    query.send({ type: "inventory", profile: "f".repeat(32) });
    await query.wait(2);
    expect(query.messages[1]).toMatchObject({ type: "inventory-result", own: [{ id: "second" }] });
  },
);

test.skipIf(process.platform === "win32").for(["a", "b"])(
  "End preserves a later replacement owned by profile %s while an earlier stop awaits",
  async (owner) => {
    await start();
    await disconnect(await open("first"));
    await disconnect(await open("second"));
    const c = await client();
    const profile = "a".repeat(32);
    c.send({ type: "hello", build });
    await c.wait(1);
    c.send({ type: "inventory", profile });
    await c.wait(2);
    const inventory = c.messages[1];
    if (!remoteResponse(inventory) || inventory.type !== "inventory-result")
      throw new Error("Missing inventory");
    const pending = Promise.withResolvers<boolean>();
    mock.stop.mockReturnValueOnce(pending.promise);
    try {
      c.send({ type: "end-sessions", profile, ids: inventory.foreign });
      await vi.waitFor(() => {
        expect(mock.stop).toHaveBeenCalledExactlyOnceWith("first");
      });
      const close = await client();
      close.send({ type: "hello", build });
      await close.wait(1);
      close.send({ type: "session-close", id: "second", request: 1, profile: "f".repeat(32) });
      await close.wait(2);
      const replacement = await client();
      replacement.send({ type: "hello", build });
      await replacement.wait(1);
      replacement.send({
        type: "open",
        id: "second",
        request: 1,
        reattach: false,
        profile: owner.repeat(32),
        cols: 80,
        rows: 24,
      });
      await replacement.wait(2);
    } finally {
      pending.resolve(true);
    }
    await c.wait(3);
    expect(mock.stop.mock.calls).toEqual([["first"], ["second"]]);
    expect(mock.kill.mock.calls.filter(([id]) => id === "second")).toHaveLength(1);
    const result = c.messages[2];
    if (!remoteResponse(result) || result.type !== "inventory-result")
      throw new Error("Missing updated inventory");
    if (owner === "a") expect(result.own).toEqual([{ id: "second" }]);
    else {
      expect(result.foreign.map(({ id }) => id)).toEqual(["second"]);
      expect(typeof result.foreign[0]?.generation).toBe("string");
      expect(result.foreign[0]?.generation).not.toBe(inventory.foreign[1]?.generation);
    }
  },
);

test.skipIf(process.platform === "win32")(
  "legacy End preserves a replacement observation arriving during its awaited stop",
  async () => {
    await start();
    const old = { executable: "/cache/foom-host", pid: 42, started: "old-start", count: 2 };
    mock.legacy.mockResolvedValue(old);
    const c = await client();
    const profile = "a".repeat(32);
    c.send({ type: "hello", build });
    await c.wait(1);
    c.send({ type: "inventory", profile, codeFolder: "/code" });
    await c.wait(2);
    const inventory = c.messages[1];
    if (!remoteResponse(inventory) || inventory.type !== "inventory-result")
      throw new Error("Missing inventory");
    const pending = Promise.withResolvers<undefined>();
    mock.endLegacy.mockReturnValueOnce(pending.promise);
    let replacement: unknown;
    try {
      c.send({ type: "end-sessions", profile, ids: inventory.foreign });
      await vi.waitFor(() => {
        expect(mock.endLegacy).toHaveBeenCalledOnce();
      });
      mock.legacy.mockResolvedValue({ ...old, pid: 43, started: "new-start" });
      const query = await client();
      query.send({ type: "hello", build });
      await query.wait(1);
      query.send({ type: "inventory", profile, codeFolder: "/code" });
      await query.wait(2);
      replacement = query.messages[1];
      expect(replacement).not.toEqual(inventory);
    } finally {
      pending.resolve(undefined);
    }
    await c.wait(3);
    expect(c.messages[2]).toEqual(replacement);
    expect(mock.endLegacy).toHaveBeenCalledExactlyOnceWith(old, expect.any(AbortSignal));
  },
);

test.skipIf(process.platform === "win32")(
  "End skips a legacy daemon replaced while an earlier session stop awaits",
  async () => {
    await start();
    await disconnect(await open("first"));
    const old = { executable: "/cache/foom-host", pid: 42, started: "old-start", count: 2 };
    mock.legacy.mockResolvedValue(old);
    const c = await client();
    const profile = "a".repeat(32);
    c.send({ type: "hello", build });
    await c.wait(1);
    c.send({ type: "inventory", profile, codeFolder: "/code" });
    await c.wait(2);
    const inventory = c.messages[1];
    if (!remoteResponse(inventory) || inventory.type !== "inventory-result")
      throw new Error("Missing inventory");
    const pending = Promise.withResolvers<boolean>();
    mock.stop.mockReturnValueOnce(pending.promise);
    let replacement: unknown;
    try {
      c.send({ type: "end-sessions", profile, ids: inventory.foreign });
      await vi.waitFor(() => {
        expect(mock.stop).toHaveBeenCalledExactlyOnceWith("first");
      });
      mock.legacy.mockResolvedValue({ ...old, pid: 43, started: "new-start" });
      const query = await client();
      query.send({ type: "hello", build });
      await query.wait(1);
      query.send({ type: "inventory", profile, codeFolder: "/code" });
      await query.wait(2);
      const observed = query.messages[1];
      if (!remoteResponse(observed) || observed.type !== "inventory-result")
        throw new Error("Missing replacement inventory");
      replacement = { ...observed, foreign: observed.foreign.filter(({ id }) => id !== "first") };
    } finally {
      pending.resolve(true);
    }
    await c.wait(3);
    expect(c.messages[2]).toEqual(replacement);
    expect(mock.endLegacy).not.toHaveBeenCalled();
  },
);
async function imageAgent() {
  const c = await client();
  c.send({ type: "hello", build });
  await c.wait(1);
  c.send({
    type: "agent-open",
    id: "image-agent",
    profile: "f".repeat(32),
    request: 1,
    cols: 80,
    rows: 24,
    spec: {
      agent: "claude",
      repository: "/remote/repo",
      worktree: "/remote/tree",
      defaults: [],
      hooks: false,
    },
  });
  await c.wait(2);
  c.send({ type: "agent-start", id: "image-agent" });
  await c.wait(4);
  const ready = c.messages.find((value) => remoteResponse(value) && value.type === "agent-ready");
  if (!remoteResponse(ready) || ready.type !== "agent-ready" || !ready.imageOwner)
    throw new Error("Missing image owner");
  return { c, owner: ready.imageOwner };
}
test.skipIf(process.platform === "win32")(
  "image management authenticates a live agent, verifies bytes and retains files until session close",
  async () => {
    const { createHash } = await import("node:crypto");
    const { readFile, readdir } = await import("node:fs/promises");
    await start();
    const { c, owner } = await imageAgent();
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5ioAAAAASUVORK5CYII=",
      "base64",
    );
    const request = {
      type: "image-put" as const,
      id: "image-agent",
      owner,
      upload: "a".repeat(32),
      size: png.length,
      sha256: createHash("sha256").update(png).digest("hex"),
      data: png.toString("base64"),
    };
    const manage = await client();
    manage.send({ type: "hello", build });
    await manage.wait(1);
    for (const bad of [
      { ...request, owner: "f".repeat(64) },
      { ...request, id: "missing" },
      { ...request, sha256: "0".repeat(64) },
      { ...request, data: Buffer.alloc(png.length).toString("base64") },
    ]) {
      const count = manage.messages.length;
      manage.send(bad);
      await manage.wait(count + 1);
      expect(manage.messages.at(-1)).toMatchObject({ type: "image-result", ok: false });
    }
    const count = manage.messages.length;
    manage.send(request);
    await manage.wait(count + 1);
    const result = manage.messages.at(-1);
    if (!remoteResponse(result) || result.type !== "image-result" || !result.ok)
      throw new Error("Image failed");
    expect(await readFile(result.path)).toEqual(png);
    expect((await stat(result.path)).mode & 0o777).toBe(0o600);
    expect((await stat((await import("node:path")).dirname(result.path))).mode & 0o777).toBe(0o700);
    // A racing --connect can start a second daemon before the first bind is visible.
    // Its failed bind must never sweep files belonging to the daemon that won.
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const conflict = serveHost(build, root);
    try {
      await once(conflict.server, "error");
      await conflict.close();
      await vi.waitFor(() => {
        expect(diagnostic).toHaveBeenCalledExactlyOnceWith("Image paste cleanup failed");
      });
      expect(await readFile(result.path)).toEqual(png);
    } finally {
      await conflict.close();
      diagnostic.mockRestore();
    }
    const taken = await open("image-agent", true);
    expect(c.socket.destroyed || c.serverSocket.destroyed).toBe(true);
    const stale = manage.messages.length;
    manage.send(request);
    await manage.wait(stale + 1);
    expect(manage.messages.at(-1)).toMatchObject({ ok: false });
    expect(await readFile(result.path)).toEqual(png);
    const close = await client();
    close.send({ type: "hello", build });
    await close.wait(1);
    close.send({ type: "agent-close", id: "image-agent", request: 2 });
    await close.wait(2);
    expect(await readdir(join(root, ".foom-host", "images"))).toEqual([]);
    taken.socket.destroy();
  },
);
test.skipIf(process.platform === "win32")(
  "image publication is cancelled by close and cannot recreate a closed session directory",
  async () => {
    const { RemoteImages } = await import("../../../../src/terminal-host/remote/image-files");
    const { createHash } = await import("node:crypto");
    const { readdir } = await import("node:fs/promises");
    await start();
    const { owner } = await imageAgent();
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const storage = new RemoteImages(root);
    await storage.ready;
    const original = storage.put.bind(storage);
    const spy = vi.spyOn(RemoteImages.prototype, "put");
    spy.mockImplementation(async (...args: Parameters<typeof original>) => {
      entered?.();
      await gate;
      return original(...args);
    });
    try {
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5ioAAAAASUVORK5CYII=",
        "base64",
      );
      const manage = await client();
      manage.send({ type: "hello", build });
      await manage.wait(1);
      manage.send({
        type: "image-put",
        id: "image-agent",
        owner,
        upload: "b".repeat(32),
        size: png.length,
        sha256: createHash("sha256").update(png).digest("hex"),
        data: png.toString("base64"),
      });
      await waiting;
      const close = await client();
      close.send({ type: "hello", build });
      await close.wait(1);
      close.send({ type: "agent-close", id: "image-agent", request: 2 });
      await vi.waitFor(() => {
        expect(mock.stop).toHaveBeenCalled();
      });
      release?.();
      await close.wait(2);
      await manage.wait(2);
      expect(manage.messages.at(-1)).toMatchObject({ ok: false });
      expect(await readdir(join(root, ".foom-host", "images"))).toEqual([]);
    } finally {
      release?.();
      spy.mockRestore();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "PTY exit contains image cleanup failure without losing the exit notification",
  async () => {
    const { RemoteImages } = await import("../../../../src/terminal-host/remote/image-files");
    await start();
    const c = await open("cleanup-failure");
    const close = vi
      .spyOn(RemoteImages.prototype, "close")
      .mockRejectedValueOnce(new Error("private image path must not be logged"));
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mock.exited("cleanup-failure", 7);
      await c.wait(3);
      expect(c.messages.at(-1)).toEqual({ type: "exit", id: "cleanup-failure", code: 7 });
      await vi.waitFor(() => {
        expect(diagnostic).toHaveBeenCalledExactlyOnceWith("Image paste cleanup failed");
      });
    } finally {
      close.mockRestore();
      diagnostic.mockRestore();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "session removal contains image cleanup failure and emits only a fixed diagnostic",
  async () => {
    const { RemoteImages } = await import("../../../../src/terminal-host/remote/image-files");
    await start();
    const c = await open();
    const close = vi
      .spyOn(RemoteImages.prototype, "close")
      .mockRejectedValueOnce(new Error("private path must not be logged"));
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      c.send({ type: "kill", id: "one", request: 2 });
      await c.wait(3);
      expect(c.messages.at(-1)).toMatchObject({ type: "result", id: "one", request: 2 });
      expect(diagnostic).toHaveBeenCalledExactlyOnceWith("Image paste cleanup failed");
      expect(mock.kill).toHaveBeenCalledWith("one");
    } finally {
      close.mockRestore();
      diagnostic.mockRestore();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a management peer cannot queue another large image behind an active upload",
  async () => {
    const { RemoteImages } = await import("../../../../src/terminal-host/remote/image-files");
    const { createHash } = await import("node:crypto");
    await start();
    const { owner } = await imageAgent();
    let entered: (() => void) | undefined;
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi
      .spyOn(RemoteImages.prototype, "put")
      .mockImplementation(async (_id, _png, live) => {
        entered?.();
        await gate;
        if (!live()) throw new Error("cancelled");
        return "/unused";
      });
    try {
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5ioAAAAASUVORK5CYII=",
        "base64",
      );
      const request = {
        type: "image-put" as const,
        id: "image-agent",
        owner,
        upload: "c".repeat(32),
        size: png.length,
        sha256: createHash("sha256").update(png).digest("hex"),
        data: png.toString("base64"),
      };
      const c = await client();
      c.send({ type: "hello", build });
      await c.wait(1);
      c.send(request);
      await waiting;
      const disconnected = once(c.socket, "close");
      c.send(request);
      await disconnected;
      release?.();
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      release?.();
      spy.mockRestore();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "stopped PTYs are disposed while image cleanup keeps their session reserved",
  async () => {
    const { RemoteImages } = await import("../../../../src/terminal-host/remote/image-files");
    await start();
    const c = await open("closing");
    let release: (() => void) | undefined;
    let cleaned = false;
    const cleanup = new Promise<void>((resolve) => {
      release = () => {
        cleaned = true;
        resolve();
      };
    });
    const spy = vi.spyOn(RemoteImages.prototype, "close").mockReturnValueOnce(cleanup);
    try {
      c.send({ type: "kill", id: "closing", request: 2 });
      await vi.waitFor(() => {
        expect(mock.kill).toHaveBeenCalledWith("closing");
      });
      expect(cleaned).toBe(false);
      const pending = await open("closing", true);
      expect(pending.messages.at(-1)).toMatchObject({ type: "open-result", state: "gone" });
      release?.();
      await c.wait(3);
      expect(c.messages.at(-1)).toMatchObject({ type: "result", request: 2 });
    } finally {
      release?.();
      spy.mockRestore();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "reconnect observes an exited PTY while image cleanup still reserves its session",
  async () => {
    const { RemoteImages } = await import("../../../../src/terminal-host/remote/image-files");
    await start();
    const c = await open("cleanup-exit");
    const cleanup = Promise.withResolvers<undefined>();
    const spy = vi.spyOn(RemoteImages.prototype, "close").mockReturnValue(cleanup.promise);
    try {
      mock.exited("cleanup-exit", 7);
      await c.wait(3);
      await disconnect(c);
      await vi.waitFor(() => {
        expect(mock.kill).toHaveBeenCalledWith("cleanup-exit");
      });
      const restored = await open("cleanup-exit", true);
      expect(restored.messages.at(-1)).toEqual({
        type: "open-result",
        id: "cleanup-exit",
        request: 1,
        state: "exited",
        code: 7,
      });
      expect(mock.create).toHaveBeenCalledOnce();
    } finally {
      cleanup.resolve(undefined);
      spy.mockRestore();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "human checkout shells use only validated profile-owned checkout paths and never spawn on failed evidence",
  async () => {
    await start();
    const profile = "a".repeat(32);
    const checkout = {
      repository: "/code/repository-clone",
      path: "/code/.foom-worktree-owned",
      identity: (await import("node:crypto")).createHash("sha256").update("identity").digest("hex"),
    };
    for (const owner of [
      undefined,
      { profile: "b".repeat(32), repository: checkout.repository },
      { profile, repository: "/foreign" },
    ]) {
      mock.owner.mockResolvedValue(owner);
      const c = await client();
      c.send({ type: "hello", build });
      await c.wait(1);
      const closed = once(c.socket, "close");
      c.send({
        type: "open",
        reattach: false,
        profile,
        id: "human",
        request: 1,
        cols: 80,
        rows: 24,
        checkout,
      });
      await closed;
      expect(mock.create).not.toHaveBeenCalled();
    }
    mock.owner.mockResolvedValue({ profile, repository: checkout.repository });
    const c = await client();
    c.send({ type: "hello", build });
    await c.wait(1);
    c.send({
      type: "open",
      reattach: false,
      profile,
      id: "human",
      request: 1,
      cols: 80,
      rows: 24,
      checkout,
    });
    await c.wait(2);
    expect(mock.create).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: checkout.path }),
      "human",
    );
    const read = await client();
    read.send({ type: "hello", build });
    await read.wait(1);
    read.send({
      type: "manage",
      operation: "remove-worktree",
      profile,
      codeFolder: "/code",
      directory: "repository-clone",
      origin: "git@fixture.test:team/repo.git",
      path: checkout.path,
      identity: checkout.identity,
      changes: "",
    });
    await read.wait(2);
    expect(read.messages[1]).toMatchObject({
      type: "managed",
      result: { ok: false, reason: "checkout-refused" },
    });
    expect(mock.manage).not.toHaveBeenCalled();
  },
);

test.skipIf(process.platform === "win32")(
  "recipe tiles reserve mutations through disconnect until PTY exit",
  async () => {
    await start();
    const c = await client();
    c.send({ type: "hello", build });
    await c.wait(1);
    c.send({
      type: "open",
      profile: "f".repeat(32),
      reattach: false,
      id: "recipe",
      request: 1,
      cols: 80,
      rows: 24,
      recipe: { tool: "git", action: "install", distro: "debian", digest: "a".repeat(64) },
    });
    await c.wait(2);
    expect(mock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        command: process.execPath,
        args: ["--recipe", "git", "install", "debian", "a".repeat(64)],
      }),
      "recipe",
    );
    c.socket.destroy();
    const next = await client();
    next.send({ type: "hello", build });
    await next.wait(1);
    next.send({ type: "manage", operation: "inspect", codeFolder: "~/code", agents: [] });
    await next.wait(2);
    expect(next.messages[1]).toEqual({
      type: "managed",
      result: { ok: false, reason: "checkout-refused" },
    });
    mock.exited("recipe", 0);
    next.send({ type: "manage", operation: "inspect", codeFolder: "~/code", agents: [] });
    await next.wait(3);
    expect(mock.manage).toHaveBeenCalledTimes(1);
  },
);

test.skipIf(process.platform === "win32").each(
  (["kill", "session-close"] as const).flatMap((operation) =>
    (["stop rejection", "disposal rejection", "no exit callback"] as const).map((outcome) => ({
      operation,
      outcome,
    })),
  ),
)("recipe $operation releases its reservation after $outcome", async ({ operation, outcome }) => {
  await start();
  const profile = "f".repeat(32);
  const c = await client();
  c.send({ type: "hello", build });
  await c.wait(1);
  c.send({
    type: "open",
    profile,
    reattach: false,
    id: "recipe",
    request: 1,
    cols: 80,
    rows: 24,
    recipe: { tool: "git", action: "install", distro: "debian", digest: "a".repeat(64) },
  });
  await c.wait(2);
  const pending = Promise.withResolvers<boolean>();
  mock.stop.mockReturnValueOnce(pending.promise);
  const removal = operation === "kill" ? c : await client();
  if (operation === "session-close") {
    removal.send({ type: "hello", build });
    await removal.wait(1);
  }
  const closed = once(removal.socket, "close");
  removal.send(
    operation === "kill"
      ? { type: "kill", id: "recipe", request: 2 }
      : { type: "session-close", id: "recipe", request: 2, profile },
  );
  await vi.waitFor(() => {
    expect(mock.stop).toHaveBeenCalledWith("recipe");
  });
  const next = await client();
  next.send({ type: "hello", build });
  await next.wait(1);
  const inspect = {
    type: "manage",
    operation: "inspect",
    codeFolder: "~/code",
    agents: [],
  } as const;
  next.send(inspect);
  await next.wait(2);
  expect(next.messages[1]).toMatchObject({ result: { ok: false, reason: "checkout-refused" } });
  expect(mock.manage).not.toHaveBeenCalled();
  if (outcome === "disposal rejection")
    mock.kill.mockImplementationOnce(() => {
      throw new Error("Fixture native disposal failed");
    });
  if (outcome === "stop rejection")
    pending.reject(new Error("Fixture terminal did not exit before stop deadline"));
  else pending.resolve(true);
  if (outcome === "no exit callback") await removal.wait(operation === "kill" ? 3 : 2);
  else await closed;
  expect(mock.kill).toHaveBeenCalledWith("recipe");
  const gone = await open("recipe", true);
  expect(gone.messages).toContainEqual({
    type: "open-result",
    id: "recipe",
    request: 1,
    state: "gone",
  });
  mock.manage.mockResolvedValueOnce({ ok: false, reason: "folder-refused" });
  next.send(inspect);
  await next.wait(3);
  expect(mock.manage).toHaveBeenCalledOnce();
  expect(next.messages[2]).toMatchObject({ result: { ok: false, reason: "folder-refused" } });
  const replacement = await client();
  replacement.send({ type: "hello", build });
  await replacement.wait(1);
  replacement.send({
    type: "open",
    profile,
    reattach: false,
    id: "recipe",
    request: 1,
    cols: 80,
    rows: 24,
    recipe: { tool: "git", action: "install", distro: "debian", digest: "a".repeat(64) },
  });
  await replacement.wait(2);
  expect(replacement.messages[1]).toMatchObject({ type: "open-result", state: "live" });
  expect(mock.create).toHaveBeenCalledTimes(2);
});
