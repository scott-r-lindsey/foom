import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const mock = vi.hoisted(() => ({
  read: vi.fn(),
  socket: vi.fn(),
  spawn: vi.fn(),
  serve: vi.fn(),
  path: vi.fn(),
  check: vi.fn(),
}));
vi.mock("node:sea", () => ({ isSea: () => false }));
vi.mock("node:fs", () => ({ readFileSync: mock.read }));
vi.mock("node:net", () => ({ createConnection: mock.socket }));
vi.mock("node:child_process", () => ({ spawn: mock.spawn }));
vi.mock("node:os", () => ({ homedir: () => "/fixture" }));
vi.mock("../../../../src/terminal-host/remote/daemon", () => ({ serveHost: mock.serve }));
vi.mock("../../../../src/terminal-host/remote/private-path", () => ({
  hostSocket: mock.path,
  checkSocket: mock.check,
}));
import { runHost } from "../../../../src/terminal-host/remote/main";
class Socket extends EventEmitter {
  destroy = vi.fn();
  pipe = vi.fn();
}
let socket: Socket;
let server: EventEmitter;
const close = vi.fn();
const unref = vi.fn();
let signals: Record<string, Set<unknown>>;
const exitCode = process.exitCode;
let stdinEnd: Set<unknown>;
let stdoutError: Set<unknown>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  socket = new Socket();
  server = new EventEmitter();
  mock.read.mockReturnValue(Buffer.from("artifact"));
  mock.path.mockReturnValue("/fixture/socket");
  mock.check.mockReturnValue(undefined);
  mock.socket.mockImplementation(() => {
    socket = new Socket();
    return socket;
  });
  mock.serve.mockReturnValue({ server, close });
  close.mockResolvedValue(undefined);
  mock.spawn.mockReturnValue({ on: vi.fn(), unref });
  vi.spyOn(process, "umask").mockReturnValue(0o22);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.spyOn(process.stdin, "pipe").mockImplementation((destination) => destination);
  signals = {
    SIGTERM: new Set(process.listeners("SIGTERM")),
    SIGINT: new Set(process.listeners("SIGINT")),
  };
  stdinEnd = new Set(
    process.stdin
      .listeners("end")
      .filter(
        (listener): listener is (...args: unknown[]) => void => typeof listener === "function",
      ),
  );
  stdoutError = new Set(
    process.stdout
      .listeners("error")
      .filter(
        (listener): listener is (...args: unknown[]) => void => typeof listener === "function",
      ),
  );
});
afterEach(() => {
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    for (const listener of process.listeners(signal))
      if (!signals[signal]?.has(listener)) process.removeListener(signal, listener);
  for (const listener of process.stdin
    .listeners("end")
    .filter((listener): listener is (...args: unknown[]) => void => typeof listener === "function"))
    if (!stdinEnd.has(listener)) process.stdin.removeListener("end", listener);
  for (const listener of process.stdout
    .listeners("error")
    .filter((listener): listener is (...args: unknown[]) => void => typeof listener === "function"))
    if (!stdoutError.has(listener)) process.stdout.removeListener("error", listener);
  process.exitCode = exitCode;
  vi.useRealTimers();
});
test("invalid argv never starts a daemon or relay", () => {
  for (const argv of [
    ["host"],
    ["host", "file", "--unknown"],
    ["host", "file", "--daemon", "extra"],
  ]) {
    runHost(argv);
    expect(process.exitCode).toBe(2);
  }
  expect(mock.serve).not.toHaveBeenCalled();
});
test("daemon errors and signal cleanup have fixed exit status", async () => {
  runHost(["node", "host", "--daemon"]);
  expect(mock.serve).toHaveBeenCalled();
  server.emit("error", new Error("busy"));
  expect(process.exitCode).toBe(1);
  const term = process.listeners("SIGTERM").at(-1);
  if (!term) throw new Error("No signal handler");
  term("SIGTERM");
  await Promise.resolve();
  expect(close).toHaveBeenCalled();
  expect(process.exitCode).toBe(0);
  close.mockRejectedValueOnce(new Error("shutdown failed"));
  const interrupt = process.listeners("SIGINT").at(-1);
  if (!interrupt) throw new Error("No interrupt handler");
  interrupt("SIGINT");
  await Promise.resolve();
  expect(process.exitCode).toBe(1);
});
test("relay validates the socket twice and pipes only stdio", () => {
  runHost(["node", "host", "--connect"]);
  socket.emit("connect");
  expect(mock.check).toHaveBeenCalledTimes(2);
  expect(socket.pipe).toHaveBeenCalledWith(process.stdout);
  const end = process.stdin.listeners("end").at(-1);
  end?.();
  const error = process.stdout.listeners("error").at(-1);
  error?.();
  expect(socket.destroy).toHaveBeenCalledTimes(2);
});
test("missing daemon starts detached once; startup retries are bounded and stale sockets are refused", async () => {
  mock.check.mockImplementation(() => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  });
  runHost(["node", "host", "--connect"]);
  socket.emit("error", { code: "ENOENT" });
  expect(mock.spawn).toHaveBeenCalledWith(
    process.execPath,
    ["--daemon"],
    expect.objectContaining({ detached: true, stdio: "ignore" }),
  );
  expect(unref).toHaveBeenCalled();
  for (let i = 0; i < 100; i++) {
    await vi.advanceTimersByTimeAsync(20);
    socket.emit("error", { code: "ECONNREFUSED" });
  }
  expect(mock.spawn).toHaveBeenCalledTimes(1);
  expect(process.exitCode).toBe(1);
  runHost(["node", "host", "--connect"]);
  socket.emit("error", { code: "ECONNREFUSED" });
  expect(mock.spawn).toHaveBeenCalledTimes(1);
});
test("unsafe sockets and failed detached starts fail closed", () => {
  mock.check.mockImplementationOnce(() => {
    throw new Error("unsafe");
  });
  expect(() => {
    runHost(["node", "host", "--connect"]);
  }).toThrow("unsafe");
  runHost(["node", "host", "--connect"]);
  mock.check.mockImplementationOnce(() => {
    throw new Error("replaced");
  });
  socket.emit("connect");
  expect(socket.destroy).toHaveBeenCalled();
  const child = new EventEmitter();
  mock.spawn.mockReturnValueOnce(Object.assign(child, { unref }));
  runHost(["node", "host", "--connect"]);
  socket.emit("error", { code: "ENOENT" });
  child.emit("error", new Error("spawn"));
  expect(process.exitCode).toBe(1);
});
