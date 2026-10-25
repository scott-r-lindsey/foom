import type { RemoteTarget } from "../../../../src/shared/remote-host";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  remoteFrame,
  remoteResponseFrames,
  RemoteFrames,
} from "../../../../src/shared/remote-host-protocol";
import type { HostRequest } from "../../../../src/shared/terminal-host";
const mock = vi.hoisted(() => ({ spawn: vi.fn(), artifact: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mock.spawn }));
vi.mock("../../../../src/main/terminals/remote-bootstrap", () => ({
  hostArtifact: mock.artifact,
  bootstrapArguments: (...args: unknown[]) => args,
}));
import { RemoteTransport } from "../../../../src/main/terminals/remote-transport";
class Child extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn<(signal?: NodeJS.Signals) => boolean>(() => true);
  messages: unknown[] = [];
  frames = new RemoteFrames();
  constructor() {
    super();
    this.stdin.on("data", (bytes: Buffer) => {
      if (bytes.toString() !== "artifact")
        this.frames.push(bytes, (value) => this.messages.push(value));
    });
  }
  header(text = "FOOM-READY\n") {
    this.stdout.write(text);
  }
  message(message: Parameters<typeof remoteFrame>[0]) {
    this.stdout.write(remoteFrame(message));
  }
  greet() {
    this.header();
    this.message({ type: "hello", build: "a".repeat(64) });
  }
}
const create: Extract<HostRequest, { type: "create" }> = {
  type: "create",
  id: "one",
  request: 1,
  spec: {
    command: "NEVER SENT",
    args: [],
    env: { SECRET: "NEVER SENT" },
    cwd: "/local/NEVER SENT",
    cols: 80,
    rows: 24,
  },
};
let child: Child;
let transport: RemoteTransport;
let events: unknown[];
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  child = new Child();
  mock.spawn.mockReturnValue(child);
  mock.artifact.mockResolvedValue({
    bytes: Buffer.from("artifact"),
    version: "0.1.0",
    sha256: "a".repeat(64),
  });
  transport = new RemoteTransport({ host: "fixture", artifact: "/artifact" }, "0.1.0");
  events = [];
  transport.on("message", (message) => events.push(message));
});
afterEach(() => {
  transport.kill();
  vi.useRealTimers();
});
async function ready() {
  transport.postMessage(create);
  await Promise.resolve();
  child.greet();
  child.message({ type: "open-result", request: 1, id: "one", state: "live" });
}
test("uploads only on request, negotiates exact build, strips local launch facts and forwards operations", async () => {
  transport.postMessage(create);
  await Promise.resolve();
  child.header("FOOM-UP");
  child.header("LOAD\nFOOM-READY\n");
  child.message({ type: "hello", build: "a".repeat(64) });
  expect(mock.spawn).toHaveBeenCalledWith(
    "ssh",
    expect.any(Array),
    expect.objectContaining({ shell: false }),
  );
  expect(JSON.stringify(child.messages)).not.toContain("NEVER SENT");
  child.message({ type: "open-result", request: 1, id: "one", state: "live" });
  transport.postMessage({ type: "attach", id: "one", request: 2, view: "v" });
  child.message({ type: "data", id: "one", view: "old", token: "t", data: "stale" });
  child.message({ type: "data", id: "one", view: "v", token: "t", data: "screen" });
  child.message({ type: "result", request: 2, id: "one", lines: [] });
  child.message({ type: "result", request: 222, id: "one", lines: [] });
  expect(events).toContainEqual(expect.objectContaining({ data: "screen" }));
  expect(events).not.toContainEqual(expect.objectContaining({ data: "stale" }));
  expect(() => {
    transport.postMessage(create);
  }).toThrow("already");
  expect(() => {
    transport.postMessage({ type: "detach", id: "foreign", request: 3 });
  }).toThrow("Unsupported");
  expect(() => {
    transport.postMessage({
      type: "child-input",
      id: "one",
      request: 3,
      input: { kind: "prompt", text: "x" },
    });
  }).toThrow("Unsupported");
  transport.postMessage({ type: "detach", id: "one", request: 4 });
  transport.postMessage({ type: "shutdown", id: "host", request: 5 });
  expect(events).toContainEqual(expect.objectContaining({ type: "result", request: 5 }));
  expect(() => {
    transport.postMessage(create);
  }).toThrow("closed");
});
test("reconnect opens the same ID, restores view state, resets snapshot and never replays interrupted input", async () => {
  await ready();
  for (const message of [
    { type: "attach", view: "v" },
    { type: "resize", cols: 100, rows: 30 },
    { type: "theme", dark: true },
    { type: "write", data: "do-once" },
  ] as const)
    transport.postMessage({ ...message, id: "one", request: 10 + child.messages.length });
  child.emit("close");
  expect(events).toContainEqual(expect.objectContaining({ type: "error" }));
  transport.postMessage({ type: "write", id: "one", request: 99, data: "offline" });
  expect(events).toContainEqual({ type: "error", request: 99, id: "one" });
  const second = new Child();
  mock.spawn.mockReturnValue(second);
  await vi.advanceTimersByTimeAsync(1000);
  second.greet();
  const open = second.messages.find(
    (value) =>
      typeof value === "object" && value !== null && "type" in value && value.type === "open",
  );
  if (
    typeof open !== "object" ||
    open === null ||
    !("request" in open) ||
    typeof open.request !== "number"
  )
    throw new Error("Missing reopen");
  second.message({ type: "open-result", id: "one", request: open.request, state: "live" });
  expect(JSON.stringify(second.messages)).not.toContain("do-once");
  expect(JSON.stringify(second.messages)).not.toContain("offline");
  expect(second.messages).toContainEqual(expect.objectContaining({ type: "resize", cols: 100 }));
  second.message({ type: "data", id: "one", view: "v", token: "new", data: "\x1bcreplay" });
  expect(events).toContainEqual(expect.objectContaining({ data: "\x1bcreplay" }));
  transport.postMessage({ type: "acknowledge", id: "one", request: 100, token: "new", count: 8 });
  expect(second.messages).toContainEqual({
    type: "acknowledge",
    id: "one",
    request: 100,
    token: "new",
    count: 8,
  });
  for (let i = 0; i < 6; i++) {
    second.emit("close");
    await vi.advanceTimersByTimeAsync(1000);
  }
  expect(transport.kill()).toBe(false);
});
test.each(["nonsense\n", "x".repeat(33), "FOOM-UPLOAD\nFOOM-UPLOAD\n"])(
  "rejects bootstrap output %s",
  async (header) => {
    await Promise.resolve();
    child.header(header);
    expect(child.kill).toHaveBeenCalled();
  },
);
test.each([
  { type: "hello", build: "b".repeat(64) },
  { type: "exit", id: "one", code: 0 },
] as const)("rejects unnegotiated or mismatched hello %j", async (message) => {
  await Promise.resolve();
  child.header();
  child.stdout.write(Buffer.from(remoteFrame(message)));
  expect(child.kill).toHaveBeenCalled();
});
test("rejects malformed/foreign responses and bounds bootstrap time", async () => {
  await ready();
  child.message({ type: "exit", id: "foreign", code: 0 });
  expect(child.kill).toHaveBeenCalled();
  child.message({ type: "activity", entries: [] });
  child.stdout.write(Buffer.from([0, 0, 0, 1, 255]));
  child.emit("error", new Error("spawn failure"));
  child.stdin.emit("error", new Error("closed"));
  transport.kill();
  child.stdout.emit("data", Buffer.from("ignored"));
  child.emit("close");
  const next = new Child();
  mock.spawn.mockReturnValue(next);
  const slow = new RemoteTransport({ host: "fixture", artifact: "/artifact" }, "0.1.0");
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(120000);
  expect(next.kill).toHaveBeenCalled();
  next.emit("close");
  expect(slow.kill()).toBe(false);
});
test("failed artifacts and cancellation never start SSH; hosts reject options synchronously", async () => {
  transport.kill();
  const count = mock.spawn.mock.calls.length;
  const canceled = new RemoteTransport({ host: "fixture", artifact: "/artifact" }, "0.1.0");
  canceled.kill();
  await Promise.resolve();
  expect(mock.spawn.mock.calls.length).toBe(count);
  expect(
    () => new RemoteTransport({ host: "-oProxyCommand=id", artifact: "/artifact" }, "0.1.0"),
  ).toThrow("host");
  mock.artifact.mockRejectedValue(new Error("bad artifact"));
  const bad = new RemoteTransport({ host: "fixture", artifact: "/artifact" }, "0.1.0");
  await Promise.resolve();
  await Promise.resolve();
  expect(bad.kill()).toBe(false);
  bad.postMessage("shutdown");
});

function requestOf(child: Child, type: string): number {
  const message = child.messages.find(
    (value) =>
      typeof value === "object" && value !== null && "type" in value && value.type === type,
  );
  if (
    typeof message !== "object" ||
    message === null ||
    !("request" in message) ||
    typeof message.request !== "number"
  )
    throw new Error("Missing request");
  return message.request;
}

test.each(["partial", "complete"])(
  "open acknowledgements and %s replay without attach completion exhaust exactly five reconnect attempts",
  async (kind) => {
    await ready();
    transport.postMessage({ type: "attach", id: "one", request: 2, view: "v" });
    const exit = vi.fn();
    transport.on("exit", exit);
    for (let attempt = 0; attempt < 5; attempt++) {
      child.emit("close");
      child = new Child();
      mock.spawn.mockReturnValue(child);
      await vi.advanceTimersByTimeAsync(1000);
      child.greet();
      child.message({
        type: "open-result",
        id: "one",
        request: requestOf(child, "open"),
        state: "live",
      });
      child.message({ type: "result", id: "one", request: requestOf(child, "theme"), lines: [] });
      const replay = {
        type: "data",
        id: "one",
        view: "v",
        token: "t",
        data: "screen".repeat(20000),
      } as const;
      for (const frame of remoteResponseFrames(replay)) {
        child.stdout.write(frame);
        if (kind === "partial") break;
      }
    }
    child.emit("close");
    await vi.advanceTimersByTimeAsync(10000);
    expect(mock.spawn).toHaveBeenCalledTimes(6);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(
      events.filter(
        (event) =>
          typeof event === "object" && event !== null && "type" in event && event.type === "data",
      ),
    ).toHaveLength(kind === "complete" ? 5 : 0);
    expect(transport.kill()).toBe(false);
  },
);

test("a complete fragmented replay and attach result restore the retry allowance", async () => {
  await ready();
  transport.postMessage({ type: "attach", id: "one", request: 2, view: "v" });
  for (let attempt = 0; attempt < 6; attempt++) {
    child.emit("close");
    child = new Child();
    mock.spawn.mockReturnValue(child);
    await vi.advanceTimersByTimeAsync(1000);
    child.greet();
    child.message({
      type: "open-result",
      id: "one",
      request: requestOf(child, "open"),
      state: "live",
    });
    child.message({ type: "result", id: "one", request: requestOf(child, "theme"), lines: [] });
    const replay = {
      type: "data",
      id: "one",
      view: "v",
      token: "t",
      data: "screen".repeat(20000),
    } as const;
    for (const frame of remoteResponseFrames(replay)) child.stdout.write(frame);
    child.message({ type: "result", id: "one", request: requestOf(child, "attach"), lines: [] });
    expect(events).toContainEqual(replay);
  }
  expect(mock.spawn).toHaveBeenCalledTimes(7);
  await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
  expect(child.kill).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  expect(transport.kill()).toBe(true);
});

test.each(["open", "theme", "attach"])(
  "an unanswered reconnect %s expires the whole restoration deadline and exhausts retries",
  async (stalled) => {
    await ready();
    transport.postMessage({ type: "attach", id: "one", request: 2, view: "v" });
    child.message({ type: "result", id: "one", request: 2, lines: [] });
    const exit = vi.fn();
    transport.on("exit", exit);
    child.emit("close");
    for (let attempt = 0; attempt < 5; attempt++) {
      child = new Child();
      child.kill.mockImplementation(() => {
        child.emit("close");
        return true;
      });
      mock.spawn.mockReturnValue(child);
      await vi.advanceTimersByTimeAsync(1000);
      child.greet();
      if (stalled !== "open")
        child.message({
          type: "open-result",
          id: "one",
          request: requestOf(child, "open"),
          state: "live",
        });
      if (stalled === "attach")
        child.message({ type: "result", id: "one", request: requestOf(child, "theme"), lines: [] });
      await vi.advanceTimersByTimeAsync(119999);
      expect(child.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(child.kill).toHaveBeenCalledOnce();
    }
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(mock.spawn).toHaveBeenCalledTimes(6);
    expect(exit).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(transport.kill()).toBe(false);
  },
);

test("replies buffered after restoration expiry cannot renew the retry budget", async () => {
  await ready();
  transport.postMessage({ type: "attach", id: "one", request: 2, view: "v" });
  child.message({ type: "result", id: "one", request: 2, lines: [] });
  const exit = vi.fn();
  transport.on("exit", exit);
  child.emit("close");
  for (let attempt = 0; attempt < 5; attempt++) {
    child = new Child();
    mock.spawn.mockReturnValue(child);
    await vi.advanceTimersByTimeAsync(1000);
    child.greet();
    child.message({
      type: "open-result",
      id: "one",
      request: requestOf(child, "open"),
      state: "live",
    });
    child.message({ type: "result", id: "one", request: requestOf(child, "theme"), lines: [] });
    await vi.advanceTimersByTimeAsync(120000);
    expect(child.kill).toHaveBeenCalledOnce();
    const before = [...events];
    // SIGTERM has happened, but the fixture deliberately delays close.
    child.message({ type: "result", id: "one", request: requestOf(child, "attach"), lines: [] });
    child.message({ type: "data", id: "one", view: "v", token: "late", data: "stale" });
    expect(events).toEqual(before);
    child.emit("close");
  }
  await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
  expect(mock.spawn).toHaveBeenCalledTimes(6);
  expect(exit).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  expect(transport.kill()).toBe(false);
});

test.each(["deadline", "protocol"])(
  "%s retirement ignores buffered replies and exhausts retries even when SSH never closes",
  async (cause) => {
    await ready();
    transport.postMessage({ type: "attach", id: "one", request: 2, view: "v" });
    child.message({ type: "result", id: "one", request: 2, lines: [] });
    const exit = vi.fn();
    transport.on("exit", exit);
    child.emit("close");
    const retired: Child[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      child = new Child();
      mock.spawn.mockReturnValue(child);
      await vi.advanceTimersByTimeAsync(1000);
      child.greet();
      child.message({
        type: "open-result",
        id: "one",
        request: requestOf(child, "open"),
        state: "live",
      });
      child.message({ type: "result", id: "one", request: requestOf(child, "theme"), lines: [] });
      const before = [...events];
      if (cause === "deadline") await vi.advanceTimersByTimeAsync(120000);
      else child.message({ type: "fragment", id: "foreign", offset: 0, total: 1, data: "x" });
      expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
      child.message({ type: "result", id: "one", request: requestOf(child, "attach"), lines: [] });
      child.message({ type: "data", id: "one", view: "v", token: "late", data: "stale" });
      expect(events).toEqual(before);
      retired.push(child);
      // No exit or close, even after either signal. Each next iteration must
      // reconnect anyway; the last iteration must fail the terminal anyway.
    }
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    for (const old of retired) {
      expect(old.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
      expect(old.stdin.destroyed).toBe(true);
      expect(old.stdout.destroyed).toBe(true);
      expect(old.stderr.destroyed).toBe(true);
      old.emit("exit");
      old.emit("close");
    }
    expect(mock.spawn).toHaveBeenCalledTimes(6);
    expect(exit).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(transport.kill()).toBe(false);
  },
);

test.each(["close", "deadline"])(
  "%s first retires each connection once when close and the deadline race",
  async (first) => {
    await ready();
    const exit = vi.fn();
    transport.on("exit", exit);
    child.emit("close");
    for (let attempt = 0; attempt < 5; attempt++) {
      child = new Child();
      mock.spawn.mockReturnValue(child);
      await vi.advanceTimersByTimeAsync(attempt > 0 && first === "close" ? 999 : 1000);
      child.greet();
      await vi.advanceTimersByTimeAsync(119999);
      if (first === "close") child.emit("close");
      await vi.advanceTimersByTimeAsync(1);
      child.emit("close");
      child.emit("exit");
      child.stdin.emit("error", new Error("late stream error"));
      expect(child.kill.mock.calls).toEqual(first === "close" ? [] : [["SIGTERM"]]);
      expect(mock.spawn).toHaveBeenCalledTimes(attempt + 2);
    }
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(mock.spawn).toHaveBeenCalledTimes(6);
    expect(exit).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

test.each(["stdin", "process", "write", "dispose", "exit"])(
  "%s uses the same retirement and bounded cleanup path",
  async (cause) => {
    await ready();
    const old = child;
    old.kill.mockImplementation((signal) => {
      if (signal === "SIGTERM") throw new Error("signal failed");
      return true;
    });
    if (cause === "stdin") old.stdin.emit("error", new Error("broken pipe"));
    if (cause === "process") old.emit("error", new Error("process failure"));
    if (cause === "write") {
      old.stdin.end();
      expect(() => {
        transport.postMessage({ type: "write", id: "one", request: 2, data: "x" });
      }).toThrow("unavailable");
      expect(events).toContainEqual({ type: "error", request: 2, id: "one" });
    }
    if (cause === "dispose") transport.kill();
    if (cause === "exit") old.emit("exit"); // Stdio remains open after process exit.
    const before = [...events];
    old.message({ type: "data", id: "one", view: "v", token: "late", data: "stale" });
    expect(events).toEqual(before);
    child = new Child();
    mock.spawn.mockReturnValue(child);
    await vi.advanceTimersByTimeAsync(999);
    expect(old.stdout.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(old.kill.mock.calls).toEqual(cause === "exit" ? [] : [["SIGTERM"], ["SIGKILL"]]);
    expect(old.stdout.destroyed).toBe(true);
    expect(mock.spawn).toHaveBeenCalledTimes(cause === "dispose" ? 1 : 2);
    old.emit("close");
    if (cause !== "dispose") child.greet();
    // Old close must not clear the new connection's deadline or schedule another retry.
    await vi.advanceTimersByTimeAsync(1);
    expect(mock.spawn).toHaveBeenCalledTimes(cause === "dispose" ? 1 : 2);
  },
);

test("disposal during a frame callback drops the rest of that buffered batch", async () => {
  await ready();
  transport.postMessage({ type: "attach", id: "one", request: 2, view: "v" });
  transport.on("message", (value: unknown) => {
    if (typeof value === "object" && value !== null && "data" in value && value.data === "first")
      transport.kill();
  });
  child.stdout.write(
    Buffer.concat(
      ["first", "stale"].map((data) =>
        remoteFrame({
          type: "data",
          id: "one",
          view: "v",
          token: "t",
          data,
        }),
      ),
    ),
  );
  expect(events).toContainEqual(expect.objectContaining({ data: "first" }));
  expect(events).not.toContainEqual(expect.objectContaining({ data: "stale" }));
  await vi.advanceTimersByTimeAsync(1000);
  expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  expect(mock.spawn).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test("process exit with inherited pipes open retires once and still releases stdio", async () => {
  await ready();
  child.message({ type: "fragment", id: "foreign", offset: 0, total: 1, data: "x" });
  const old = child;
  old.emit("exit");
  child = new Child();
  mock.spawn.mockReturnValue(child);
  await vi.advanceTimersByTimeAsync(1000);
  child.greet();
  expect(old.kill.mock.calls).toEqual([["SIGTERM"]]);
  expect(old.stdout.destroyed).toBe(true);
  old.emit("close");
  expect(mock.spawn).toHaveBeenCalledTimes(2);
  transport.kill();
  await vi.advanceTimersByTimeAsync(1000);
  expect(vi.getTimerCount()).toBe(0);
});

test("foreign fragments and failed restoration responses terminate the SSH stream", async () => {
  await ready();
  child.stdout.write(
    remoteFrame({ type: "fragment", id: "other", offset: 0, total: 1, data: "x" }),
  );
  expect(child.kill).toHaveBeenCalled();
  child.emit("close");
  child = new Child();
  mock.spawn.mockReturnValue(child);
  await vi.advanceTimersByTimeAsync(1000);
  child.greet();
  child.message({
    type: "open-result",
    id: "one",
    request: requestOf(child, "open"),
    state: "live",
  });
  child.message({ type: "error", id: "one", request: requestOf(child, "theme") });
  expect(child.kill).toHaveBeenCalled();
});

test.each([{ state: "gone" }, { state: "exited", code: 0 }, { state: "exited", code: 7 }] as const)(
  "a definitive reconnect outcome %j exits normally without replay, replacement or further retries",
  async (outcome) => {
    await ready();
    expect(child.messages).toContainEqual(
      expect.objectContaining({ type: "open", reattach: false }),
    );
    transport.postMessage({ type: "attach", id: "one", request: 2, view: "v" });
    child.message({
      type: "data",
      id: "one",
      view: "v",
      token: "last",
      data: "last displayed screen",
    });
    child.emit("close");
    child = new Child();
    mock.spawn.mockReturnValue(child);
    await vi.advanceTimersByTimeAsync(1000);
    child.greet();
    expect(child.messages).toContainEqual(
      expect.objectContaining({ type: "open", reattach: true }),
    );
    const count = events.length;
    child.message({
      type: "open-result",
      id: "one",
      request: requestOf(child, "open"),
      ...outcome,
    });
    expect(events.slice(count)).toEqual([
      { type: "exit", id: "one", code: outcome.state === "exited" ? outcome.code : -1 },
    ]);
    expect(child.messages).not.toContainEqual(expect.objectContaining({ type: "attach" }));
    child.message({ type: "data", id: "one", view: "v", token: "replacement", data: "new shell" });
    child.emit("close");
    await vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1000);
    expect(mock.spawn).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(events).not.toContainEqual(expect.objectContaining({ data: "new shell" }));
    expect(transport.kill()).toBe(false);
  },
);

test.each(["legacy", "foreign-request", "ended-first-open"])(
  "rejects unexpected %s open replies",
  async (kind) => {
    transport.postMessage(create);
    await Promise.resolve();
    child.greet();
    if (kind === "legacy") child.message({ type: "result", id: "one", request: 1, lines: [] });
    else
      child.message({
        type: "open-result",
        id: "one",
        request: kind === "foreign-request" ? 2 : 1,
        state: kind === "ended-first-open" ? "gone" : "live",
      });
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.kill).toHaveBeenCalled();
    expect(mock.spawn).toHaveBeenCalledOnce();
  },
);

async function remoteAgent() {
  transport.kill();
  child = new Child();
  mock.spawn.mockReturnValue(child);
  const agent = {
    spec: {
      agent: "claude",
      repository: "/remote/repo",
      worktree: "/remote/tree",
      defaults: [],
      hooks: true,
    },
    authorize: vi.fn(() => Promise.resolve()),
    start: vi.fn(),
    ready: vi.fn(),
    hook: vi.fn(() => Promise.resolve()),
    call: vi.fn(() =>
      Promise.resolve({ type: "error" as const, error: "phase_2_restricted" as const }),
    ),
  };
  const target: RemoteTarget = { host: "fixture", artifact: "/artifact", agent };
  transport = new RemoteTransport(target, "0.1.0");
  transport.on("message", (message) => events.push(message));
  transport.postMessage(create);
  await Promise.resolve();
  child.greet();
  return {
    ...agent,
    activate: () => {
      target.agent?.activate?.();
    },
  };
}
async function remoteStarted() {
  const agent = await remoteAgent();
  child.message({ type: "agent-prepared", id: "one" });
  await vi.advanceTimersByTimeAsync(0);
  child.message({
    type: "agent-ready",
    id: "one",
    ready: { hooks: true, mcp: true, channels: ["lifecycle"] },
  });
  child.message({ type: "open-result", id: "one", request: 1, state: "live" });
  agent.activate();
  return agent;
}
test("remote agent preparation requires fresh main authorization and relays typed calls, hooks, input and activity", async () => {
  const agent = await remoteStarted();
  expect(agent.authorize).toHaveBeenCalledOnce();
  expect(child.messages).toContainEqual({ type: "agent-start", id: "one" });
  expect(child.messages).toContainEqual(
    expect.objectContaining({ type: "agent-open", spec: agent.spec }),
  );
  expect(JSON.stringify(child.messages)).not.toContain("NEVER SENT");
  child.message({ type: "agent-call", id: "one", call: 1, method: "sessions", params: {} });
  await vi.advanceTimersByTimeAsync(0);
  expect(agent.call).toHaveBeenCalledWith("sessions", {});
  expect(child.messages).toContainEqual({
    type: "agent-reply",
    id: "one",
    call: 1,
    result: { type: "error", error: "phase_2_restricted" },
  });
  child.message({
    type: "agent-hook",
    id: "one",
    signal: {
      terminalId: "one",
      action: "working",
      signal: "plugin:claude:UserPromptSubmit",
      channel: "lifecycle",
      caseId: "UserPromptSubmit",
      conversationId: "conversation",
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(agent.hook).toHaveBeenCalledOnce();
  transport.postMessage({
    type: "child-input",
    id: "one",
    request: 2,
    input: { kind: "keys", keys: ["y"] },
  });
  expect(child.messages).toContainEqual(expect.objectContaining({ type: "child-input" }));
  child.message({ type: "activity", entries: [{ id: "one", rate: 1 }] });
  expect(events).toContainEqual({ type: "activity", entries: [{ id: "one", rate: 1 }] });
  child.message({ type: "activity", entries: [{ id: "other", rate: 1 }] });
  expect(child.kill).toHaveBeenCalled();
});
test("failed main authorization never sends agent-start, and duplicate preparation or ready metadata fails closed", async () => {
  const agent = await remoteAgent();
  agent.authorize.mockRejectedValueOnce(new Error("revoked"));
  child.message({ type: "agent-prepared", id: "one" });
  await vi.advanceTimersByTimeAsync(0);
  expect(child.messages).not.toContainEqual({ type: "agent-start", id: "one" });
  expect(child.kill).toHaveBeenCalled();
  await remoteAgent();
  child.message({ type: "agent-prepared", id: "one" });
  child.message({ type: "agent-prepared", id: "one" });
  expect(child.kill).toHaveBeenCalled();
  await remoteStarted();
  child.message({ type: "agent-ready", id: "one", ready: { hooks: false, mcp: false } });
  expect(child.kill).toHaveBeenCalled();
});
test("remote relay concurrency is bounded and duplicate pending call IDs close the channel", async () => {
  const agent = await remoteStarted();
  agent.call.mockImplementation(() => new Promise(() => {}));
  child.message({ type: "agent-call", id: "one", call: 1, method: "manual", params: {} });
  child.message({ type: "agent-call", id: "one", call: 1, method: "manual", params: {} });
  expect(child.kill).toHaveBeenCalled();
  const next = await remoteStarted();
  next.call.mockImplementation(() => new Promise(() => {}));
  for (let call = 1; call <= 5; call++)
    child.message({ type: "agent-call", id: "one", call, method: "manual", params: {} });
  expect(next.call).toHaveBeenCalledTimes(4);
  expect(child.kill).toHaveBeenCalled();
});

test("final synchronous authority check can revoke a prepared launch before agent-start", async () => {
  const agent = await remoteAgent();
  agent.start.mockImplementationOnce(() => {
    throw new Error("parent replaced");
  });
  child.message({ type: "agent-prepared", id: "one" });
  await vi.advanceTimersByTimeAsync(0);
  expect(agent.authorize).toHaveBeenCalledOnce();
  expect(agent.start).toHaveBeenCalledOnce();
  expect(child.messages).not.toContainEqual({ type: "agent-start", id: "one" });
  expect(child.kill).toHaveBeenCalled();
});
