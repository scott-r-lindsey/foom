import type * as PerfHooks from "node:perf_hooks";
import type { Details, Event, ForkOptions } from "electron";
import { performance } from "node:perf_hooks";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { HostRequest } from "../../../../src/shared/terminal-host";
const mock = vi.hoisted(() => ({
  lagMax: 0,
  recordExit: vi.fn(),
  recordTimeout: vi.fn(),
  recordNearMiss: vi.fn(),
  fork: vi.fn<(path: string, args: string[], options: ForkOptions) => Child>(),
  remote: vi.fn<() => Child>(),
  app: {
    getAppMetrics: vi.fn(() => [{ pid: 123, memory: { workingSetSize: 4096 } }]),
    getVersion: () => "0.1.0",
    getPath: () => "/fixture/profile",
    on: vi.fn<(event: string, callback: (event: Event, details: Details) => void) => void>(),
    removeListener:
      vi.fn<(event: string, callback: (event: Event, details: Details) => void) => void>(),
  },
  theme: {
    shouldUseDarkColors: false,
    on: vi.fn<(event: string, callback: () => void) => void>(),
    removeListener: vi.fn(),
  },
}));
vi.mock("node:perf_hooks", async (original) => ({
  ...(await original<typeof PerfHooks>()),
  monitorEventLoopDelay: () => ({
    count: 0,
    get max() {
      return mock.lagMax;
    },
    mean: 0,
    enable: () => {},
    reset: () => {
      mock.lagMax = 0;
    },
    disable: () => {},
  }),
}));
vi.mock("../../../../src/main/terminals/remote-transport", () => ({
  RemoteTransport: function () {
    return mock.remote();
  },
}));
vi.mock("../../../../src/main/terminals/terminal-host-log", () => ({
  recordHostExit: mock.recordExit,
  recordHostTimeout: mock.recordTimeout,
  recordHostNearMiss: mock.recordNearMiss,
  initializeHostLog: vi.fn(),
  flushHostExits: () => Promise.resolve(),
}));
vi.mock("electron", () => ({ app: mock.app, utilityProcess: mock, nativeTheme: mock.theme }));
import { TerminalHostClient } from "../../../../src/main/terminals/terminal-host-client";
class Child extends EventEmitter {
  postMessage = vi.fn<(message: HostRequest | "shutdown") => void>();
  kill = vi.fn();
  pid = 123;
  stderr = new EventEmitter();
  data(id: string, data: string, view?: string) {
    const attachment = this.postMessage.mock.calls
      .map(([message]) => message)
      .findLast((message) => message !== "shutdown" && message.type === "attach");
    if (!attachment) throw new Error("Missing attachment");
    this.emit("message", { type: "data", id, token: "view", data, view: view ?? attachment.view });
  }
  reply(index = this.postMessage.mock.calls.length - 1, extra: object = {}) {
    const request = this.postMessage.mock.calls[index]?.[0];
    if (!request || request === "shutdown") throw new Error("Missing request");
    this.emit("message", {
      type: "result",
      request: request.request,
      id: request.id,
      lines: [],
      ...extra,
    });
  }
}
const spec = { command: "/bin/bash", args: ["-l"], cwd: "/tmp", cols: 80, rows: 24 };
const appEvents = new EventEmitter();
let child: Child;
let client: TerminalHostClient;
const exited = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mock.lagMax = 0;
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  vi.spyOn(process, "threadCpuUsage").mockReturnValue({ user: 0, system: 0 });
  appEvents.removeAllListeners();
  mock.app.on.mockImplementation((event, callback) => appEvents.on(event, callback));
  mock.app.removeListener.mockImplementation((event, callback) =>
    appEvents.removeListener(event, callback),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
  child = new Child();
  mock.fork.mockReturnValue(child);
  client = new TerminalHostClient(exited);
});
afterEach(async () => {
  const closing = client.dispose();
  child.emit("exit", 0);
  await closing;
  vi.useRealTimers();
});
async function create() {
  const promise = client.create(spec);
  child.reply();
  return promise;
}
test("brokers capabilities, snapshots, tails and exits over a validated transport", async () => {
  const id = await create();
  expect(mock.fork).toHaveBeenCalledWith(
    expect.stringContaining("terminal-host.js"),
    [],
    expect.objectContaining({
      stdio: ["ignore", "ignore", "ignore"],
    }),
  );
  const send = vi.fn();
  const attaching = client.attach(id, send);
  child.data(id, "snapshot");
  child.data(id, "stale", "previous-attachment");
  child.reply();
  await attaching;
  expect(send).toHaveBeenCalledWith("view", "snapshot");
  for (const operation of [
    () => {
      client.write(id, "hello");
    },
    () => {
      client.resize(id, 90, 25);
    },
    () => {
      client.acknowledge(id, "view", 8);
    },
  ]) {
    operation();
    child.reply();
  }
  const reviewed = client.childInput(id, { kind: "prompt", text: "answer" });
  expect(child.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "child-input", id, input: { kind: "prompt", text: "answer" } }),
  );
  child.reply();
  await reviewed;
  const probeInput = client.reply(id, "y\r");
  expect(child.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "write", id, data: "y\r" }),
  );
  child.reply();
  await probeInput;
  const tail = client.tail(id, 2);
  child.reply(undefined, { lines: ["one", "two"] });
  expect(await tail).toEqual(["one", "two"]);
  client.detach(id);
  child.reply();
  child.data(id, "hidden");
  expect(send).toHaveBeenCalledOnce();
  child.emit("message", { type: "exit", id, code: 0 });
  child.emit("message", { type: "exit", id, code: 0 });
  child.emit("message", { type: "exit", id: "foreign", code: 2 });
  expect(exited.mock.calls).toEqual([[id, 0]]);
  const killing = client.kill(id);
  child.reply();
  await killing;
  await client.kill(id);
  client.detach("foreign");
  expect(vi.getTimerCount()).toBe(0);
});
test("ignores malformed, unknown and mismatched responses without satisfying a pending call", async () => {
  const creating = client.create(spec);
  child.emit("message", null);
  child.reply(undefined, { id: "foreign" });
  child.reply(undefined, { request: 999 });
  expect(vi.getTimerCount()).toBe(1);
  child.reply();
  const id = await creating;
  const failed = client.tail(id, 1);
  child.reply(undefined, { type: "error" });
  await expect(failed).rejects.toThrow("operation failed");
  await expect(client.tail(id, 0)).rejects.toThrow("Invalid");
  client.acknowledge(id, "view", -1);
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
});
test("host loss fails live sessions and pending operations, permits restart, and isolates old generations", async () => {
  const id = await create();
  const finished = await create();
  child.emit("message", { type: "exit", id: finished, code: 0 });
  const tail = client.tail(id, 1);
  const rejected = expect(tail).rejects.toThrow("stopped");
  child.emit("exit", 9);
  await rejected;
  expect(exited.mock.calls).toEqual([
    [finished, 0],
    [id, -1],
  ]);
  await expect(client.attach(id, vi.fn())).rejects.toThrow("unavailable");
  await expect(client.tail(id, 1)).rejects.toThrow("unavailable");
  client.write(id, "ignored");
  const previous = child;
  child = new Child();
  mock.fork.mockReturnValue(child);
  const next = await create();
  previous.emit("message", { type: "exit", id: next, code: 4 });
  previous.emit("exit", 9);
  await client.kill(id);
  expect(child.postMessage).toHaveBeenCalledOnce();
  expect(exited).toHaveBeenCalledTimes(2);
});
test("one unanswered attachment does not kill healthy terminals at its deadline", async () => {
  const slow = await create();
  const other = await create();
  const attaching = client.attach(slow, vi.fn());
  const rejected = expect(attaching).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(10000);
  await rejected;
  const ping = child.postMessage.mock.calls
    .map(([message]) => message)
    .find((message) => message !== "shutdown" && message.type === "ping");
  child.reply(); // The failed attachment is detached even if its barrier completes late.
  if (!ping || ping === "shutdown") throw new Error("Missing ping");
  child.emit("message", { type: "pong", id: "host", request: ping.request });
  await vi.advanceTimersByTimeAsync(5000);
  expect(child.kill).not.toHaveBeenCalled();
  expect(exited).not.toHaveBeenCalled();
  expect(client.runningCount).toBe(2);
  const tail = client.tail(other, 1);
  child.reply(undefined, { lines: ["still running"] });
  expect(await tail).toEqual(["still running"]);
});
test("times out a hung host and rejects creation without leaking requests", async () => {
  const creating = client.create(spec);
  const rejected = expect(creating).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(10000);
  await rejected;
  expect(child.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5003);
  expect(child.kill).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
test("handles fork and send failures and forbids use after disposal", async () => {
  mock.fork.mockImplementationOnce(() => {
    throw new Error("fork failed");
  });
  await expect(client.create(spec)).rejects.toThrow("fork failed");
  child.postMessage.mockImplementationOnce(() => {
    throw new Error("broken pipe");
  });
  await expect(client.create(spec)).rejects.toThrow("stopped");
  await client.dispose();
  await expect(client.create(spec)).rejects.toThrow("disposed");
});
test.each(["exit", "timeout", "send failure"])("bounded idempotent shutdown (%s)", async (mode) => {
  const id = await create();
  if (mode === "send failure")
    child.postMessage.mockImplementationOnce(() => {
      throw new Error("gone");
    });
  const closing = client.dispose();
  expect(client.dispose()).toBe(closing);
  client.write(id, "ignored");
  if (mode === "exit") child.emit("exit", 0);
  if (mode === "timeout") await vi.advanceTimersByTimeAsync(12000);
  await closing;
  expect(exited).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
test("a killed session's outstanding barrier response still resolves", async () => {
  const id = await create();
  const attaching = client.attach(id, vi.fn());
  const requestIndex = child.postMessage.mock.calls.length - 1;
  const killing = client.kill(id);
  child.reply();
  await killing;
  child.reply(requestIndex);
  await attaching;
  child.data(id, "stale");
  expect(vi.getTimerCount()).toBe(0);
});

test("confirmed shutdown blocks new terminals, waits for the host and permits retry after failure", async () => {
  const id = await create();
  expect(client.runningCount).toBe(1);
  expect(client.hasPendingExits).toBe(true);
  const shutdown = client.shutdown();
  expect(client.shutdown()).toBe(shutdown);
  await expect(client.create(spec)).rejects.toThrow("shutting down");
  child.reply(undefined, { type: "error" });
  await expect(shutdown).rejects.toThrow("operation failed");
  expect(client.runningCount).toBe(1);
  client.write(id, "still running");
  child.reply();
  const retry = client.shutdown();
  child.reply();
  await retry;
  expect(client.runningCount).toBe(0);
  const exited = client.waitForExit();
  child.emit("exit", 0);
  await exited;
  expect(client.hasPendingExits).toBe(false);
});
test("shutdown without a host prevents subsequent creation", async () => {
  await client.shutdown();
  expect(client.runningCount).toBe(0);
  expect(client.hasPendingExits).toBe(false);
  await expect(client.create(spec)).rejects.toThrow("shutting down");
});

test("sends initial system colors and validated theme changes for live and hidden sessions", async () => {
  mock.theme.shouldUseDarkColors = true;
  const id = await create();
  expect(child.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "create", id, dark: true }),
  );
  mock.theme.shouldUseDarkColors = false;
  const update = mock.theme.on.mock.calls[0]?.[1];
  update?.();
  expect(child.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "theme", id, dark: false }),
  );
  child.reply();
  const closing = client.dispose();
  child.emit("exit", 0);
  await closing;
  expect(mock.theme.removeListener).toHaveBeenCalledWith("updated", update);
});

test("delivers telemetry only for live owned sessions", async () => {
  await client.dispose();
  const onActivity = vi.fn();
  const onQuiet = vi.fn();
  client = new TerminalHostClient(exited, { onActivity, onQuiet });
  const id = await create();
  child.emit("message", {
    type: "activity",
    entries: [
      { id, rate: 4 },
      { id: "foreign", rate: 9 },
    ],
  });
  child.emit("message", { type: "quiet", id });
  expect(onActivity).toHaveBeenCalledWith([{ id, rate: 4 }]);
  expect(onQuiet).toHaveBeenCalledWith(id);
  child.emit("message", { type: "exit", id, code: 0 });
  child.emit("message", { type: "activity", entries: [{ id, rate: 4 }] });
  child.emit("message", { type: "quiet", id });
  child.emit("message", { type: "quiet", id: "foreign" });
  expect(onActivity).toHaveBeenCalledTimes(1);
  expect(onQuiet).toHaveBeenCalledTimes(1);
});
test("telemetry requires no subscriber", async () => {
  const id = await create();
  child.emit("message", { type: "activity", entries: [{ id, rate: 4 }] });
  child.emit("message", { type: "quiet", id });
});

test("stop waits for host completion and preserves the terminal for retry or inspection", async () => {
  const id = await create();
  const stopping = client.stop(id);
  expect(child.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: "stop", id }));
  child.reply(undefined, { signaled: true });
  expect(await stopping).toBe(true);
  const tail = client.tail(id, 1);
  child.reply(undefined, { lines: ["preserved"] });
  expect(await tail).toEqual(["preserved"]);
  child.emit("message", { type: "exit", id, code: 0 });
  const count = child.postMessage.mock.calls.length;
  await client.stop(id);
  await client.stop("unknown");
  expect(child.postMessage).toHaveBeenCalledTimes(count);
});

test("output invalidation is delivered without an attached view and rejects foreign or exited IDs", async () => {
  const output = vi.fn();
  client = new TerminalHostClient(exited, { onOutput: output });
  const id = await create();
  child.emit("message", { type: "output", id });
  child.emit("message", { type: "output", id: "foreign" });
  child.emit("message", { type: "exit", id, code: 0 });
  child.emit("message", { type: "output", id });
  expect(output).toHaveBeenCalledExactlyOnceWith(id);
});

test("fixed themes apply to existing and new terminals and ignore interface changes", async () => {
  const { terminalThemes } = await import("../../../../src/shared/terminal-themes");
  const id = await create();
  client.setTheme("dracula");
  expect(child.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "theme", id, theme: terminalThemes.dracula }),
  );
  child.reply();
  const calls = child.postMessage.mock.calls.length;
  mock.theme.shouldUseDarkColors = !mock.theme.shouldUseDarkColors;
  mock.theme.on.mock.calls[0]?.[1]();
  expect(child.postMessage.mock.calls).toHaveLength(calls);
  await create();
  expect(child.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "create", theme: terminalThemes.dracula }),
  );
  client.setTheme("follow");
  expect(child.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: "theme",
      theme: terminalThemes[mock.theme.shouldUseDarkColors ? "foom-dark" : "foom-light"],
    }),
  );
});

test("shell events are delivered only for live owned sessions", async () => {
  const onForeground = vi.fn();
  const onShellState = vi.fn();
  client = new TerminalHostClient(exited, { onShellState, onForeground });
  const id = await create();
  const state = { phase: "prompt", exitCode: 1 };
  child.emit("message", { type: "foreground", id, name: "vim" });
  expect(onForeground).toHaveBeenCalledWith(id, "vim");
  child.emit("message", { type: "foreground", id: "foreign", name: "vim" });
  child.emit("message", { type: "shell-state", id, state });
  expect(onShellState).toHaveBeenCalledWith(id, state);
  child.emit("message", { type: "shell-state", id: "foreign", state });
  child.emit("message", { type: "shell-state", id, state: { phase: "prompt", exitCode: -1 } });
  child.emit("message", { type: "exit", id, code: 0 });
  child.emit("message", { type: "shell-state", id, state });
  child.emit("message", { type: "foreground", id, name: "vim" });
  expect(onForeground).toHaveBeenCalledTimes(1);
  expect(onShellState).toHaveBeenCalledTimes(1);
});

test("agent evidence is delivered only for live owned sessions", async () => {
  const onEvidence = vi.fn();
  client = new TerminalHostClient(exited, { onEvidence });
  const id = await create();
  const evidence = { title: "Action Required", progress: null };
  child.emit("message", { type: "evidence", id, evidence });
  expect(onEvidence).toHaveBeenCalledWith(id, evidence);
  child.emit("message", { type: "evidence", id: "foreign", evidence });
  child.emit("message", { type: "evidence", id, evidence: { ...evidence, title: "\x1b" } });
  child.emit("message", { type: "exit", id, code: 0 });
  child.emit("message", { type: "evidence", id, evidence });
  expect(onEvidence).toHaveBeenCalledOnce();
});

test("reuses only a removed session ID and rejects malformed or occupied IDs", async () => {
  const id = await create();
  await expect(client.create({ ...spec, id })).rejects.toThrow("occupied");
  await expect(client.create({ ...spec, id: "bad id" })).rejects.toThrow("Invalid");
  child.emit("message", { type: "exit", id, code: 0 });
  const killing = client.kill(id);
  child.reply();
  await killing;
  const resumed = client.create({ ...spec, id });
  child.reply();
  expect(await resumed).toBe(id);
});

function gone(details: object = {}) {
  const options = mock.fork.mock.calls.at(-1)?.[2];
  appEvents.emit(
    "child-process-gone",
    {},
    {
      type: "Utility",
      name: options?.serviceName,
      reason: "crashed",
      exitCode: 3221225477,
      ...details,
    },
  );
}

test.each([true, false])(
  "captures native crash details before or after exit (before=%s)",
  async (before) => {
    const id = await create();
    child.emit("spawn");
    child.stderr.emit("data", Buffer.from("native failure"));
    const shutdown = client.shutdown();
    const rejection = shutdown.catch((error: unknown) => error);
    gone({ type: "GPU" });
    gone({ name: "another utility" });
    if (before) gone();
    child.emit("exit", 3221225477);
    if (!before) gone();
    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Missing host failure");
    expect(error.message).toContain('"exitCode":3221225477');
    expect(error.message).toContain('"reason":"crashed"');
    expect(error.cause).toMatchObject({ pid: 123 });
    expect(error.message).not.toContain("native failure");
    child.stderr.emit("data", Buffer.from(" late stderr"));
    expect(error.message).not.toContain("late stderr");
    expect(exited).toHaveBeenCalledWith(id, -1);
    expect(console.error).toHaveBeenCalledWith(
      "Terminal host diagnostic:",
      expect.stringContaining('"reason":"crashed"'),
    );
  },
);

test("discards host stderr and terminal messages and isolates replacement hosts", async () => {
  const id = await create();
  child.stderr.emit("data", "x".repeat(20000));
  child.stderr.emit("data", Buffer.from("native tail"));
  child.stderr.emit("data", { unexpected: "ignored" });
  child.emit("message", { type: "data", id, token: "view", data: "private terminal output" });
  const pending = client.tail(id, 1);
  const rejected = pending.catch((error: unknown) => error);
  child.emit("exit", 9);
  const error = await rejected;
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw new Error("Missing host failure");
  expect(error.message).not.toContain("native tail");
  expect(
    mock.recordExit.mock.calls
      .flat()
      .map((value) => JSON.stringify(value))
      .join(),
  ).not.toContain("native tail");
  expect(error.message).not.toContain("private terminal output");
  const oldName = mock.fork.mock.calls.at(-1)?.[2]?.serviceName;
  child = new Child();
  mock.fork.mockReturnValue(child);
  await create();
  gone({ name: oldName });
  expect(appEvents.listenerCount("child-process-gone")).toBe(1);
  const closing = client.dispose();
  child.emit("exit", 0);
  await closing;
  expect(appEvents.listenerCount("child-process-gone")).toBe(0);
  expect(console.error).toHaveBeenLastCalledWith(
    "Terminal host diagnostic:",
    expect.stringContaining('"exitCode":9'),
  );
});

test.each([true, false])(
  "clean disposal keeps host stderr private (gone before=%s)",
  async (before) => {
    await create();
    child.stderr.emit("data", "host stderr during normal operation");
    expect(console.error).not.toHaveBeenCalled();
    const closing = client.dispose();
    if (before) gone({ reason: "clean-exit", exitCode: 0 });
    child.emit("exit", 0);
    if (!before) gone({ reason: "clean-exit", exitCode: 0 });
    child.stderr.emit("data", "late stderr");
    await closing;
    expect(console.error).not.toHaveBeenCalled();
  },
);

test("an unexpected zero exit still rejects shutdown and records diagnostics", async () => {
  await create();
  const shutdown = client.shutdown();
  const rejected = expect(shutdown).rejects.toThrow("Terminal host stopped");
  child.emit("exit", 0);
  gone({ reason: "clean-exit", exitCode: 0 });
  await rejected;
  expect(console.error).toHaveBeenCalledWith(
    "Terminal host diagnostic:",
    expect.stringContaining('"exitCode":0'),
  );
});

test.each(["exit", "gone"])("abnormal final disposal omits host stderr (%s)", async (source) => {
  await create();
  child.stderr.emit("data", "native failure during disposal");
  const closing = client.dispose();
  if (source === "gone") gone();
  child.emit("exit", source === "exit" ? 1 : 0);
  child.stderr.emit("data", " late stderr");
  await closing;
  expect(console.error).toHaveBeenLastCalledWith(
    "Terminal host diagnostic:",
    expect.not.stringContaining("native failure during disposal"),
  );
});

test("screen requests require an available host and a validated title", async () => {
  await expect(client.screen("missing")).rejects.toThrow("unavailable");
  const id = await create();
  const reading = client.screen(id);
  child.reply(undefined, { lines: ["visible"], title: "title", cols: 80, rows: 24 });
  expect(await reading).toEqual({ lines: ["visible"], title: "title", cols: 80, rows: 24 });
  const missing = client.screen(id);
  child.reply();
  await expect(missing).rejects.toThrow("Missing terminal title");
});

test("stop preserves the host's natural-exit acknowledgement and rejects a missing acknowledgement", async () => {
  const id = await create();
  const stopping = client.stop(id);
  child.reply(undefined, { signaled: false });
  expect(await stopping).toBe(false);
  const missing = client.stop(id);
  child.reply();
  await expect(missing).rejects.toThrow("Missing terminal stop result");
  child.emit("message", { type: "exit", id, code: 1 });
  expect(await client.stop(id)).toBe(false);
});

function remoteChild(): Child {
  const remote = new Child();
  remote.postMessage.mockImplementation((message) => {
    if (message === "shutdown") {
      queueMicrotask(() => remote.emit("exit", 0));
      return;
    }
    queueMicrotask(() =>
      remote.emit("message", {
        type: "result",
        id: message.id,
        request: message.request,
        lines: ["remote"],
        title: "remote shell",
        cols: 80,
        rows: 24,
        signaled: true,
      }),
    );
  });
  return remote;
}
test("routes remote shell capabilities independently while leaving local terminals in their utility host", async () => {
  const remote = remoteChild();
  mock.remote.mockReturnValue(remote);
  const target = { host: "fixture", artifact: "/fixture/foom-host" };
  const id = await client.create({ ...spec, id: "remote", remote: target });
  expect(mock.fork).not.toHaveBeenCalled();
  expect(client.runningCount).toBe(1);
  expect(client.hasPendingExits).toBe(true);
  await expect(client.create({ ...spec, id, remote: target })).rejects.toThrow("occupied");
  const send = vi.fn();
  await client.attach(id, send);
  remote.data(id, "snapshot");
  expect(send).toHaveBeenCalledWith("view", "snapshot");
  client.write(id, "input");
  await client.reply(id, "reply");
  await client.childInput(id, { kind: "keys", keys: ["enter"] });
  client.resize(id, 100, 30);
  client.acknowledge(id, "view", 8);
  client.setTheme("follow");
  client.detach(id);
  expect(await client.tail(id, 1)).toEqual(["remote"]);
  expect(await client.screen(id)).toEqual({
    lines: ["remote"],
    title: "remote shell",
    cols: 80,
    rows: 24,
  });
  expect(await client.stop(id)).toBe(true);
  await client.kill(id);
  expect(client.runningCount).toBe(0);
  expect(
    remote.postMessage.mock.calls.some(
      ([message]) => message !== "shutdown" && message.type === "kill",
    ),
  ).toBe(true);
  await client.dispose();
  await expect(client.create({ ...spec, remote: target })).rejects.toThrow("disposed");
});
test("remote quit disconnects without requesting PTY termination; failed remote creates release their transport", async () => {
  const remote = remoteChild();
  mock.remote.mockReturnValue(remote);
  await client.create({ ...spec, remote: { host: "fixture", artifact: "/fixture/foom-host" } });
  await client.shutdown();
  expect(client.runningCount).toBe(0);
  expect(remote.kill).toHaveBeenCalled();
  expect(
    remote.postMessage.mock.calls.some(
      ([message]) => message !== "shutdown" && ["stop", "kill", "shutdown"].includes(message.type),
    ),
  ).toBe(false);
  await client.dispose();
  client = new TerminalHostClient(exited);
  const failed = remoteChild();
  failed.postMessage.mockImplementation((message) => {
    if (message === "shutdown") queueMicrotask(() => failed.emit("exit", 0));
    else
      queueMicrotask(() =>
        failed.emit("message", { type: "error", id: message.id, request: message.request }),
      );
  });
  mock.remote.mockReturnValue(failed);
  await expect(
    client.create({ ...spec, remote: { host: "fixture", artifact: "/fixture/foom-host" } }),
  ).rejects.toThrow("failed");
  expect(client.runningCount).toBe(0);
});

test.each([0, 7, -1])(
  "a definitive remote exit %s reaches onExit once before transport cleanup",
  async (code) => {
    const remote = remoteChild();
    mock.remote.mockReturnValue(remote);
    const id = await client.create({
      ...spec,
      remote: { host: "fixture", artifact: "/fixture/foom-host" },
    });
    const send = vi.fn();
    await client.attach(id, send);
    remote.data(id, "last received screen");
    remote.emit("message", { type: "exit", id, code });
    remote.emit("exit", 0);
    expect(exited).toHaveBeenCalledExactlyOnceWith(id, code);
    expect(client.runningCount).toBe(0);
    expect(send).toHaveBeenCalledExactlyOnceWith("view", "last received screen");
  },
);

test("cleanup-only remote removal works without a restored client and disposes its connection", async () => {
  const remote = remoteChild();
  mock.remote.mockReturnValue(remote);
  await client.kill("saved-child", "saved-host");
  expect(mock.remote).toHaveBeenCalled();
  expect(remote.kill).toHaveBeenCalled();
  expect(exited).not.toHaveBeenCalled();
  expect(client.runningCount).toBe(0);
});

test("remote agent create allows bootstrap plus preparation and still expires", async () => {
  const remote = remoteChild();
  remote.postMessage.mockReset();
  mock.remote.mockReturnValue(remote);
  const pending = client.create({
    ...spec,
    remote: {
      host: "fixture",
      agent: {
        spec: {
          agent: "claude",
          repository: "/repo",
          worktree: "/tree",
          defaults: [],
          hooks: false,
        },
        authorize: () => Promise.resolve(),
        start: () => {},
        ready: () => {},
        hook: () => {},
        call: () => Promise.resolve({ type: "error", error: "unavailable" }),
      },
    },
  });
  const rejected = expect(pending).rejects.toThrow("stopped");
  await vi.advanceTimersByTimeAsync(125000);
  expect(remote.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(120000);
  await rejected;
  expect(remote.kill).toHaveBeenCalled();
});

test("image staging distinguishes a live local session from a missing/expired target", async () => {
  const signal = new AbortController().signal;
  await expect(client.imagePath("unknown", new Uint8Array(), signal)).rejects.toThrow(
    "unavailable",
  );
  const id = await create();
  await expect(client.imagePath(id, new Uint8Array(), signal)).resolves.toBeUndefined();
  child.emit("message", { type: "exit", id, code: 0 });
  await expect(client.imagePath(id, new Uint8Array(), signal)).rejects.toThrow("unavailable");
});

test("coalesces liveness checks and ignores errors, ordinary results and foreign/stale pongs", async () => {
  const id = await create();
  const other = await create();
  const first = client.tail(id, 1);
  const second = client.tail(other, 1);
  const rejected = Promise.all([
    expect(first).rejects.toThrow("timed out"),
    expect(second).rejects.toThrow("timed out"),
  ]);
  await vi.advanceTimersByTimeAsync(10000);
  await rejected;
  const pings = child.postMessage.mock.calls
    .map(([message]) => message)
    .filter((message) => message !== "shutdown" && message.type === "ping");
  expect(pings).toHaveLength(1);
  const ping = pings[0];
  if (!ping || ping === "shutdown") throw new Error("Missing ping");
  child.emit("message", { type: "pong", id: "foreign", request: ping.request });
  child.emit("message", { type: "pong", id: "host", request: ping.request + 1 });
  child.emit("message", { type: "pong", id: "host", request: 0 });
  child.reply(undefined, { type: "error" });
  child.reply();
  const waiting = client.tail(other, 1);
  const failed = expect(waiting).rejects.toThrow("stopped");
  await vi.advanceTimersByTimeAsync(4999);
  expect(client.runningCount).toBe(2);
  await vi.advanceTimersByTimeAsync(4);
  await failed;
  expect(child.kill).toHaveBeenCalledOnce();
  expect(exited.mock.calls).toEqual([
    [id, -1],
    [other, -1],
  ]);
  expect(mock.recordExit).toHaveBeenCalledWith(
    "/fixture/profile",
    expect.objectContaining({ reason: "liveness-timeout" }),
  );
});

test("a later timeout starts a fresh probe; a ping send failure retires the transport", async () => {
  const id = await create();
  for (const broken of [false, true]) {
    const pending = client.tail(id, 1);
    const rejected = expect(pending).rejects.toThrow("timed out");
    if (broken)
      child.postMessage.mockImplementationOnce(() => {
        throw new Error("broken pipe");
      });
    await vi.advanceTimersByTimeAsync(10000);
    await rejected;
    if (!broken) {
      const ping = child.postMessage.mock.calls.at(-1)?.[0];
      if (!ping || ping === "shutdown") throw new Error("Missing ping");
      child.emit("message", { type: "pong", id: "host", request: ping.request });
      expect(vi.getTimerCount()).toBe(0);
    }
  }
  expect(child.kill).toHaveBeenCalledOnce();
  expect(exited).toHaveBeenCalledWith(id, -1);
});

test("late attachment responses and output cannot revive a timed-out view", async () => {
  const id = await create();
  const send = vi.fn();
  const attaching = client.attach(id, send);
  const index = child.postMessage.mock.calls.length - 1;
  const rejected = expect(attaching).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(10000);
  await rejected;
  child.data(id, "private late output");
  child.reply(index);
  expect(send).not.toHaveBeenCalled();
  child.reply(); // detach
  child.emit("exit", 1);
  expect(vi.getTimerCount()).toBe(0);
});

test("replays the 10011/10012/10061/16012 trace without blaming a delayed main", async () => {
  vi.setSystemTime(0);
  const id = await create();
  const timers = vi.spyOn(globalThis, "setTimeout");
  const pending = client.tail(id, 1);
  const rejected = expect(pending).rejects.toThrow("timed out");
  const timeout = timers.mock.calls.at(-1)?.[0];
  if (typeof timeout !== "function") throw new Error("Missing request deadline");
  vi.clearAllTimers();
  vi.setSystemTime(10011);
  const send = child.postMessage.getMockImplementation();
  child.postMessage.mockImplementationOnce((message) => {
    vi.setSystemTime(10012);
    send?.(message);
  });
  timeout();
  await rejected;
  const ping = child.postMessage.mock.calls.at(-1)?.[0];
  if (!ping || ping === "shutdown") throw new Error("Missing ping");
  // Probe was sent at 10012; host replied at 10061; main resumes at 16012.
  const queuedPong = { type: "pong", id: "host", request: ping.request };
  const callback = timers.mock.calls.at(-1)?.[0];
  if (typeof callback !== "function") throw new Error("Missing probe timer");
  vi.clearAllTimers();
  vi.setSystemTime(16012);
  callback(); // The overdue timer dispatches first.
  expect(child.kill).not.toHaveBeenCalled();
  vi.setSystemTime(16013);
  child.emit("message", queuedPong);
  expect(client.runningCount).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(mock.recordTimeout).toHaveBeenCalledWith("/fixture/profile", "tail", 10011);
});

test("a pong queued during the 5008-to-16008 drain pause preserves both sessions", async () => {
  vi.setSystemTime(0);
  const a = await create();
  const b = await create();
  const timers = vi.spyOn(globalThis, "setTimeout");
  const pending = client.tail(a, 1);
  const rejected = expect(pending).rejects.toThrow("timed out");
  const timeout = timers.mock.calls.at(-1)?.[0];
  if (typeof timeout !== "function") throw new Error("Missing request deadline");
  vi.clearAllTimers();
  vi.setSystemTime(0);
  timeout(); // Start the independent probe at trace time zero.
  await rejected;
  const ping = child.postMessage.mock.calls.at(-1)?.[0];
  if (!ping || ping === "shutdown") throw new Error("Missing ping");
  const immediate = vi.spyOn(globalThis, "setImmediate");
  await vi.advanceTimersByTimeAsync(5001);
  const final = immediate.mock.calls.at(-1)?.[0];
  if (typeof final !== "function") throw new Error("Missing final drain");
  vi.clearAllTimers();
  // An earlier check callback blocks at 5008. The host posts at 5124, but main
  // cannot dispatch that pong until after the already queued final callback.
  vi.setSystemTime(5008);
  const queuedPong = { type: "pong", id: "host", request: ping.request };
  vi.setSystemTime(16009.089);
  final();
  expect(child.kill).not.toHaveBeenCalled();
  vi.setSystemTime(16009.461);
  child.emit("message", queuedPong);
  await vi.advanceTimersByTimeAsync(10000);
  expect(child.kill).not.toHaveBeenCalled();
  expect(exited).not.toHaveBeenCalled();
  expect(client.runningCount).toBe(2);
  const responsive = client.tail(b, 1);
  child.reply();
  await expect(responsive).resolves.toEqual([]);
});

test("late answered probes record numeric near misses while prompt replies remain silent", async () => {
  const id = await create();
  for (const latency of [50, 1200]) {
    const pending = client.tail(id, 1).catch(() => {});
    await vi.advanceTimersByTimeAsync(10000);
    await pending;
    const ping = child.postMessage.mock.calls.at(-1)?.[0];
    if (!ping || ping === "shutdown" || ping.type !== "ping") throw new Error("Missing ping");
    await vi.advanceTimersByTimeAsync(latency);
    child.emit("message", { type: "pong", id: "host", request: ping.request });
  }
  expect(mock.recordNearMiss).toHaveBeenCalledExactlyOnceWith("/fixture/profile", {
    kind: "late-reply",
    replyLatencyMs: 1200,
    probeElapsedMs: 1200,
    lateCycles: 0,
    mainLagMs: 0,
  });
  expect(child.kill).not.toHaveBeenCalled();
});

test("watchdog snapshot precedes terminal failure and remains fixed through native exit updates", async () => {
  await create();
  child.emit("spawn");
  // Use the live terminal ID from the create command.
  const command = child.postMessage.mock.calls[0]?.[0];
  if (!command || command === "shutdown") throw new Error("Missing create");
  const timed = client.tail(command.id, 1).catch(() => {});
  await vi.advanceTimersByTimeAsync(15004);
  await timed;
  const expected: unknown = expect.objectContaining({
    cause: "watchdog-kill",
    snapshot: { liveTerminals: 1, hostMemoryKB: 4096, lastMessageAgeMs: 15002, mainLagMs: 0 },
  });
  expect(mock.recordExit).toHaveBeenCalledWith("/fixture/profile", expected);
  child.emit("exit", 9);
  expect(mock.recordExit).toHaveBeenLastCalledWith("/fixture/profile", expected);
});

test("self exit snapshots and unavailable memory are contained", async () => {
  await create();
  mock.app.getAppMetrics.mockImplementationOnce(() => {
    throw new Error("unavailable");
  });
  child.emit("exit", 9);
  expect(mock.recordExit).toHaveBeenLastCalledWith(
    "/fixture/profile",
    expect.objectContaining({
      cause: "host-exit",
      snapshot: { liveTerminals: 1, hostMemoryKB: null, lastMessageAgeMs: 0, mainLagMs: 0 },
    }),
  );
});

test("snapshot measures recent main delay and tolerates a host missing from process metrics", async () => {
  const id = await create();
  mock.lagMax = 900e6;
  child.emit("message", { type: "output", id });
  mock.lagMax = 140e6;
  mock.app.getAppMetrics.mockReturnValueOnce([]);
  await vi.advanceTimersByTimeAsync(250);
  child.emit("exit", 9);
  expect(mock.recordExit).toHaveBeenLastCalledWith(
    "/fixture/profile",
    expect.objectContaining({
      cause: "host-exit",
      snapshot: { liveTerminals: 1, hostMemoryKB: null, lastMessageAgeMs: 250, mainLagMs: 120 },
    }),
  );
});
