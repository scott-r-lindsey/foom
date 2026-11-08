import { terminalThemes } from "../../../../src/shared/terminal-themes";
import { ApplicationError } from "../../../../src/shared/application-errors";
import { LaunchFailure } from "../../../../src/shared/launch-failure";
import { UnsupportedRemotePlatform } from "../../../../src/main/terminals/remote-bootstrap";
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
  UnsupportedRemotePlatform: class extends Error {},
  selectHostArtifact: mock.artifact,
  sshEnvironment: () => ({ PATH: "/fixture" }),
  bootstrapArguments: (...args: unknown[]) => args,
}));
import { RemoteTransport, remoteManagement } from "../../../../src/main/terminals/remote-transport";
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
    upload: Buffer.from("artifact"),
    platform: "linux",
    arch: "x64",
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
  child.message({ type: "result", id: "one", request: requestOf(child, "theme"), lines: [] });
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
  expect(second.messages).toContainEqual(expect.objectContaining({ type: "open", dark: true }));
  expect(second.messages).not.toContainEqual(expect.objectContaining({ type: "theme" }));
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
    transport.postMessage({ type: "resize", id: "one", request: 3, cols: 100, rows: 30 });
    child.message({ type: "result", id: "one", request: 3, lines: [] });
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
      child.message({ type: "result", id: "one", request: requestOf(child, "resize"), lines: [] });
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
  transport.postMessage({ type: "resize", id: "one", request: 3, cols: 100, rows: 30 });
  child.message({ type: "result", id: "one", request: 3, lines: [] });
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
    child.message({ type: "result", id: "one", request: requestOf(child, "resize"), lines: [] });
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

test.each(["open", "resize", "attach"])(
  "an unanswered reconnect %s expires the whole restoration deadline and exhausts retries",
  async (stalled) => {
    await ready();
    transport.postMessage({ type: "resize", id: "one", request: 3, cols: 100, rows: 30 });
    child.message({ type: "result", id: "one", request: 3, lines: [] });
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
        child.message({
          type: "result",
          id: "one",
          request: requestOf(child, "resize"),
          lines: [],
        });
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
  transport.postMessage({ type: "resize", id: "one", request: 3, cols: 100, rows: 30 });
  child.message({ type: "result", id: "one", request: 3, lines: [] });
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
    child.message({ type: "result", id: "one", request: requestOf(child, "resize"), lines: [] });
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
    transport.postMessage({ type: "resize", id: "one", request: 3, cols: 100, rows: 30 });
    child.message({ type: "result", id: "one", request: 3, lines: [] });
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
      child.message({ type: "result", id: "one", request: requestOf(child, "resize"), lines: [] });
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
  transport.postMessage({ type: "resize", id: "one", request: 3, cols: 100, rows: 30 });
  child.message({ type: "result", id: "one", request: 3, lines: [] });
  transport.postMessage({ type: "attach", id: "one", request: 2, view: "v" });
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
  child.message({ type: "error", id: "one", request: requestOf(child, "resize") });
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

async function remoteAgent(
  palette: Pick<typeof create, "dark" | "theme"> = {},
  pressure = false,
  capable = false,
) {
  transport.kill();
  child = new Child();
  mock.spawn.mockReturnValue(child);
  const agent = {
    pressure: vi.fn(),
    spec: {
      ...(pressure ? { childPressure: true as const } : {}),
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
  transport.postMessage({ ...create, ...palette });
  await Promise.resolve();
  child.header();
  child.message({ type: "hello", build: "a".repeat(64), ...(capable ? { childPressure: 1 } : {}) });
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

test("arbitrary artifact error text cannot select a trusted launch failure", async () => {
  transport.kill();
  mock.artifact.mockRejectedValue(new Error("foom-error:remote-host-unavailable"));
  const bad = new RemoteTransport({ host: "fixture", artifact: "/artifact" }, "0.1.0");
  await Promise.resolve();
  await Promise.resolve();
  expect(bad.failureReason).toBeUndefined();
  expect(bad.kill()).toBe(false);
});

test("a cleanup-only connection sends bounded agent-close without attaching or creating a PTY", async () => {
  transport.kill();
  transport = new RemoteTransport({ host: "fixture", cleanup: true }, "0.1.0");
  transport.on("message", (message) => events.push(message));
  transport.postMessage(create);
  await Promise.resolve();
  child.greet();
  expect(child.messages).toContainEqual({ type: "agent-close", id: "one", request: 1 });
  child.message({ type: "result", id: "one", request: 1, lines: [] });
  expect(events).toContainEqual({ type: "result", id: "one", request: 1, lines: [] });
  expect(
    child.messages.some(
      (value) =>
        typeof value === "object" && value !== null && "type" in value && value.type === "open",
    ),
  ).toBe(false);
});

test.each([
  "remote_agent_unavailable",
  "remote_worktree_unavailable",
  "remote_prepare_refused",
  "remote_start_refused",
] as const)("preserves only the fixed host failure code %s", async (reason) => {
  await remoteAgent();
  child.message({ type: "agent-failed", id: "one", reason });
  expect(transport.launchFailure?.reason).toBe(reason);
  expect(events).toContainEqual({ type: "error", id: "one", request: 1 });
});

test("management connections use no terminal ID or PTY and return fixed failures", async () => {
  transport.kill();
  const pending = remoteManagement({ host: "fixture" }, "0.1.0", {
    type: "manage",
    operation: "inspect",
    codeFolder: "~/foom",
  });
  await Promise.resolve();
  child.greet();
  expect(child.messages).toContainEqual({
    type: "manage",
    operation: "inspect",
    codeFolder: "~/foom",
  });
  expect(
    child.messages.some((value) => typeof value === "object" && value !== null && "id" in value),
  ).toBe(false);
  child.message({ type: "managed", result: { ok: false, reason: "unsafe-folder" } });
  await expect(pending).resolves.toEqual({ ok: false, reason: "unsafe-folder" });
  child = new Child();
  mock.spawn.mockReturnValue(child);
  const failed = remoteManagement({ host: "fixture" }, "0.1.0", {
    type: "manage",
    operation: "inspect",
    codeFolder: "~/foom",
  });
  await Promise.resolve();
  child.greet();
  child.message({ type: "exit", id: "foreign", code: 0 });
  await expect(failed).resolves.toEqual({ ok: false, reason: "invalid-reply" });
});
test("ordinary sessions reject management responses", async () => {
  await ready();
  child.message({ type: "managed", result: { ok: false, reason: "unreachable" } });
  expect(child.kill).toHaveBeenCalled();
});

test("management shutdown cancels an in-flight SSH connection and unsupported platforms stay fixed", async () => {
  transport.kill();
  const cancellation = new AbortController();
  const pending = remoteManagement(
    { host: "fixture" },
    "0.1.0",
    { type: "manage", operation: "inspect", codeFolder: "~/foom" },
    cancellation.signal,
  );
  await Promise.resolve();
  child.greet();
  cancellation.abort();
  await expect(pending).resolves.toEqual({ ok: false, reason: "cancelled" });
  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  mock.artifact.mockRejectedValueOnce(new UnsupportedRemotePlatform("fixed"));
  await expect(
    remoteManagement({ host: "fixture" }, "0.1.0", {
      type: "manage",
      operation: "inspect",
      codeFolder: "~/foom",
    }),
  ).resolves.toEqual({ ok: false, reason: "unsupported" });
  const already = new AbortController();
  already.abort();
  await expect(
    remoteManagement(
      { host: "fixture" },
      "0.1.0",
      { type: "manage", operation: "inspect", codeFolder: "~/foom" },
      already.signal,
    ),
  ).resolves.toEqual({ ok: false, reason: "cancelled" });
});

test("clone management connections allow the clone deadline plus bootstrap and validation time", async () => {
  transport.kill();
  child = new Child();
  mock.spawn.mockReturnValue(child);
  const pending = remoteManagement({ host: "fixture" }, "0.1.0", {
    type: "manage",
    operation: "clone",
    codeFolder: "~/foom",
    origin: "git@forge.test:team/repo.git",
    directory: "repo",
  });
  await Promise.resolve();
  child.greet();
  await vi.advanceTimersByTimeAsync(120000);
  expect(child.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(300000 - 1);
  expect(child.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(pending).resolves.toEqual({ ok: false, reason: "unreachable" });
  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
});

test("new hubs negotiate a compatible busy build; idle upgrade retries are bounded before opening", async () => {
  transport.postMessage(create);
  await Promise.resolve();
  child.header();
  child.message({ type: "upgrade", build: "b".repeat(64) });
  const replacement = new Child();
  mock.spawn.mockReturnValue(replacement);
  await vi.advanceTimersByTimeAsync(1000);
  replacement.header();
  replacement.message({ type: "hello", build: "b".repeat(64), startupTheme: 1, compatible: 2 });
  expect(replacement.messages).toContainEqual(
    expect.objectContaining({ type: "open", reattach: false }),
  );
  replacement.message({ type: "open-result", id: "one", request: 1, state: "live" });
  expect(events).toContainEqual({ type: "result", id: "one", request: 1, lines: [] });
  replacement.message({ type: "upgrade", build: "b".repeat(64) });
  expect(replacement.kill).toHaveBeenCalled();
});

test.each(["gone", "exited"] as const)(
  "initial saved reattach reports %s without spawning a replacement",
  async (state) => {
    transport.kill();
    transport = new RemoteTransport(
      { host: "fixture", reattach: true, human: true, profile: "a".repeat(32) },
      "0.1.0",
    );
    events = [];
    transport.on("message", (value) => events.push(value));
    transport.postMessage(create);
    await Promise.resolve();
    child.greet();
    expect(child.messages).toContainEqual(
      expect.objectContaining({
        type: "open",
        reattach: true,
        human: true,
        profile: "a".repeat(32),
      }),
    );
    child.message(
      state === "gone"
        ? { type: "open-result", id: "one", request: 1, state }
        : { type: "open-result", id: "one", request: 1, state, code: 7 },
    );
    expect(events).toContainEqual({ type: "error", id: "one", request: 1 });
    const count = mock.spawn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(mock.spawn).toHaveBeenCalledTimes(count);
  },
);

test("inventory uses a bounded connection, rejects unexpected replies and supports cancellation", async () => {
  const { remoteInventory } = await import("../../../../src/main/terminals/remote-transport");
  transport.kill();
  const pending = remoteInventory({ host: "fixture" }, "0.1.0", {
    type: "inventory",
    profile: "a".repeat(32),
  });
  await Promise.resolve();
  child.greet();
  const result = { type: "inventory-result", own: [{ id: "one" }], foreign: [] } as const;
  child.message({ ...result, own: [...result.own], foreign: [] });
  await expect(pending).resolves.toEqual(result);
  child = new Child();
  mock.spawn.mockReturnValue(child);
  const cancellation = new AbortController();
  const aborted = remoteInventory(
    { host: "fixture" },
    "0.1.0",
    { type: "inventory", profile: "a".repeat(32) },
    cancellation.signal,
  );
  const assertion = expect(aborted).rejects.toThrow("unavailable");
  await Promise.resolve();
  child.greet();
  cancellation.abort();
  await assertion;
  child = new Child();
  mock.spawn.mockReturnValue(child);
  transport = new RemoteTransport({ host: "fixture" }, "0.1.0");
  transport.postMessage(create);
  await Promise.resolve();
  child.greet();
  child.message({ type: "inventory-result", own: [], foreign: [] });
  expect(child.kill).toHaveBeenCalled();
});

test.each(["inventory", "end-sessions"] as const)(
  "%s keeps the management budget on a compatible busy daemon and accepts cancellation",
  async (type) => {
    const { remoteInventory } = await import("../../../../src/main/terminals/remote-transport");
    transport.kill();
    child = new Child();
    mock.spawn.mockReturnValue(child);
    const cancellation = new AbortController();
    const pending = remoteInventory(
      { host: "fixture" },
      "0.1.0",
      type === "inventory"
        ? { type, profile: "a".repeat(32) }
        : { type, profile: "a".repeat(32), ids: [] },
      cancellation.signal,
    );
    const rejected = expect(pending).rejects.toThrow("unavailable");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(119000);
    child.header();
    child.message({ type: "hello", build: "b".repeat(64), compatible: 2 });
    await vi.advanceTimersByTimeAsync(7 * 60 * 1000 - 1);
    expect(child.kill).not.toHaveBeenCalled();
    cancellation.abort();
    await rejected;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  },
);

test.each(["inspect", "create-worktree"] as const)(
  "%s gets a fresh management budget after bootstrap",
  async (operation) => {
    transport.kill();
    child = new Child();
    mock.spawn.mockReturnValue(child);
    const request =
      operation === "inspect"
        ? { type: "manage" as const, operation, codeFolder: "~/foom" }
        : {
            type: "manage" as const,
            operation,
            codeFolder: "~/foom",
            directory: "repo",
            origin: "git@fixture.test:team/repo.git",
            branch: "feature",
            profile: "a".repeat(32),
          };
    const pending = remoteManagement({ host: "fixture" }, "0.1.0", request);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(119000);
    child.greet();
    await vi.advanceTimersByTimeAsync(7 * 60 * 1000 - 1);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ok: false, reason: "unreachable" });
  },
);
test.each([false, true])(
  "agent preparation is bounded independently of negotiation (expire: %s)",
  async (expire) => {
    await remoteAgent();
    await vi.advanceTimersByTimeAsync(11000);
    expect(child.kill).not.toHaveBeenCalled();
    if (expire) {
      await vi.advanceTimersByTimeAsync(120000 - 11000);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } else {
      child.message({ type: "agent-prepared", id: "one" });
      await Promise.resolve();
      child.message({
        type: "agent-ready",
        id: "one",
        ready: { channels: [], hooks: false, mcp: false },
      });
      child.message({ type: "open-result", id: "one", request: 1, state: "live" });
      await vi.advanceTimersByTimeAsync(120000);
      expect(child.kill).not.toHaveBeenCalled();
    }
  },
);

test("image management uses owner capability on a separate SSH connection and never opens a remote path", async () => {
  await remoteStarted();
  // A fresh ready metadata event occurs only on a new connection; use the regular fixture helper with an owner below.
  await expect(
    transport.putImage(new Uint8Array([1]), new AbortController().signal),
  ).rejects.toThrow();
  await remoteAgent();
  child.message({ type: "agent-prepared", id: "one" });
  await vi.advanceTimersByTimeAsync(0);
  const owner = "d".repeat(64);
  child.message({
    type: "agent-ready",
    id: "one",
    imageOwner: owner,
    ready: { hooks: true, mcp: true, channels: ["lifecycle"] },
  });
  child.message({ type: "open-result", id: "one", request: 1, state: "live" });
  const upload = new Child();
  mock.spawn.mockReturnValue(upload);
  const pending = transport.putImage(new Uint8Array(33), new AbortController().signal);
  await vi.advanceTimersByTimeAsync(0);
  upload.greet();
  const request = upload.messages.find(
    (value) =>
      typeof value === "object" && value !== null && "type" in value && value.type === "image-put",
  );
  const { imagePut } = await import("../../../../src/shared/image-paste");
  if (!imagePut(request)) throw new Error("Missing image request");
  expect(request.owner).toBe(owner);
  expect(request.data).toBe(Buffer.alloc(33).toString("base64"));
  await expect(
    transport.putImage(new Uint8Array([1]), new AbortController().signal),
  ).rejects.toThrow();
  const remote = `/remote/.foom-host/images/${"a".repeat(32)}/image-${"b".repeat(32)}.png`;
  upload.message({
    type: "image-result",
    id: request.id,
    owner,
    upload: request.upload,
    ok: true,
    path: remote,
  });
  expect(await pending).toBe(remote);
  const next = new Child();
  mock.spawn.mockReturnValue(next);
  const cancel = new AbortController();
  const cancelled = transport.putImage(new Uint8Array(33), cancel.signal);
  const assertion = expect(cancelled).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(0);
  cancel.abort();
  await assertion;
  expect(next.kill).toHaveBeenCalled();
});

test("image upload refuses a session-inventory response on its management connection", async () => {
  transport.kill();
  transport = new RemoteTransport({ host: "fixture" }, "0.1.0", {
    type: "image-put",
    id: "one",
    owner: "d".repeat(64),
    upload: "e".repeat(32),
    size: 33,
    sha256: "f".repeat(64),
    data: Buffer.alloc(33).toString("base64"),
  });
  const inventory = vi.fn();
  transport.on("inventory", inventory);
  await Promise.resolve();
  child.greet();
  child.message({ type: "inventory-result", own: [], foreign: [] });
  expect(inventory).not.toHaveBeenCalled();
  expect(child.kill).toHaveBeenCalled();
});

test.each([
  ["FOOM-LIBC-TOO-OLD", "libc-too-old"],
  ["FOOM-LIBC-UNSUPPORTED", "libc-unsupported"],
])("bootstrap %s retains its specific management reason", async (marker, reason) => {
  await Promise.resolve();
  child.header(`${marker}\n`);
  expect(transport.managementFailure).toBe(reason);
  expect(transport.launchFailure?.reason).toBe(
    reason === "libc-too-old" ? "remote_host_libc_too_old" : "remote_host_libc_unsupported",
  );
  expect(child.kill).toHaveBeenCalled();
});

test("recipe reconnect reattaches the same PTY and never repeats its recipe selector", async () => {
  transport.kill();
  const recipe = {
    tool: "git",
    action: "install" as const,
    distro: "debian" as const,
    digest: "a".repeat(64),
  };
  const profile = "f".repeat(32);
  transport = new RemoteTransport(
    { host: "fixture", artifact: "/artifact", profile, human: true, recipe },
    "0.1.0",
  );
  await ready();
  expect(child.messages).toContainEqual({
    type: "open",
    id: "one",
    request: 1,
    cols: 80,
    rows: 24,
    dark: false,
    reattach: false,
    profile,
    human: true,
    recipe,
  });
  const next = new Child();
  mock.spawn.mockReturnValue(next);
  child.emit("close");
  await vi.advanceTimersByTimeAsync(1000);
  next.greet();
  expect(next.messages).toContainEqual(
    expect.objectContaining({
      type: "open",
      id: "one",
      cols: 80,
      rows: 24,
      reattach: true,
      profile,
      human: true,
    }),
  );
  expect(JSON.stringify(next.messages)).not.toContain("digest");
});

test.each([false, true])(
  "compatible host facts capability gates read-only requests (%s)",
  async (supported) => {
    transport.kill();
    child = new Child();
    mock.spawn.mockReturnValue(child);
    const request = {
      type: "manage" as const,
      operation: "inspect" as const,
      readOnly: true as const,
      codeFolder: "/remote/code",
      agents: [],
    };
    const pending = remoteManagement({ host: "fixture" }, "0.1.0", request);
    await Promise.resolve();
    child.header();
    child.message({
      type: "hello",
      build: "b".repeat(64),
      startupTheme: 1,
      compatible: 2,
      ...(supported ? { hostFacts: 1 as const } : {}),
    });
    if (supported) {
      expect(child.messages).toContainEqual(request);
      child.message({ type: "managed", result: { ok: false, reason: "folder-refused" } });
      await expect(pending).resolves.toEqual({ ok: false, reason: "folder-refused" });
    } else {
      await expect(pending).resolves.toEqual({ ok: false, reason: "facts-unavailable" });
      expect(child.messages).not.toContainEqual(request);
    }
  },
);

test.each(["handshake", "reply", "artifact", "ssh"])(
  "management distinguishes %s failures",
  async (step) => {
    transport.kill();
    if (step === "artifact")
      mock.artifact.mockRejectedValueOnce(new ApplicationError("remote-host-unavailable"));
    if (step === "ssh")
      mock.artifact.mockRejectedValueOnce(new LaunchFailure("remote_host_unreachable"));
    const pending = remoteManagement({ host: "fixture" }, "0.1.0", {
      type: "manage",
      operation: "inspect",
      codeFolder: "~/foom",
    });
    await Promise.resolve();
    if (step === "handshake") {
      child.header();
      child.message({ type: "hello", build: "b".repeat(64) });
    }
    if (step === "reply") {
      child.greet();
      child.stdout.write(Buffer.from([0, 0, 0, 1, 255]));
    }
    await expect(pending).resolves.toEqual({
      ok: false,
      reason:
        step === "handshake"
          ? "version-mismatch"
          : step === "reply"
            ? "invalid-reply"
            : step === "artifact"
              ? "artifact-unavailable"
              : "unreachable",
    });
  },
);

test.each([false, true])(
  "preflight capability gates every new operation on older peers (%s)",
  async (supported) => {
    for (const request of [
      {
        type: "manage",
        operation: "inspect",
        codeFolder: "/remote/code",
        readOnly: true,
        partial: true,
      },
      {
        type: "manage",
        operation: "origin",
        codeFolder: "/remote/code",
        directory: "repo",
        origin: "git@fixture.test:team/repo.git",
      },
      { type: "manage", operation: "create-folder", codeFolder: "/remote/code" },
    ] as const) {
      transport.kill();
      child = new Child();
      mock.spawn.mockReturnValue(child);
      const pending = remoteManagement({ host: "fixture" }, "0.1.0", request);
      await Promise.resolve();
      child.header();
      child.message({
        type: "hello",
        build: "b".repeat(64),
        compatible: 2,
        hostFacts: 1,
        hostRowCheck: 1,
        ...(supported ? { hostPreflight: 1 as const } : {}),
      });
      if (supported) {
        expect(child.messages).toContainEqual(request);
        child.message({ type: "managed", result: { ok: false, reason: "folder-refused" } });
      } else expect(child.messages).not.toContainEqual(request);
      await expect(pending).resolves.toMatchObject({
        ok: false,
        reason: supported ? "folder-refused" : "facts-unavailable",
      });
    }
  },
);

test.each([false, true].flatMap((supported) => ["a", "b"].map((build) => ({ supported, build }))))(
  "human machine home capability gates same and older builds ($supported, $build)",
  async ({ supported, build }) => {
    transport.kill();
    child = new Child();
    mock.spawn.mockReturnValue(child);
    const machineHome = vi.fn();
    transport = new RemoteTransport(
      {
        host: "fixture",
        human: true,
        machineHome,
        context: {
          machine: true,
          repository: "/placeholder",
          worktree: "/placeholder",
          branch: null,
          agent: "claude",
        },
        machine: { codeFolder: "/remote/code", agent: "claude", defaults: [] },
      },
      "0.1.0",
    );
    transport.postMessage(create);
    await Promise.resolve();
    child.header();
    child.message({
      type: "hello",
      build: build.repeat(64),
      startupTheme: 1,
      compatible: 2,
      humanMachines: 1,
      ...(supported ? { machineHome: "/home/remote-user" } : {}),
    });
    if (supported) {
      expect(machineHome).toHaveBeenCalledWith("/home/remote-user");
      expect(child.messages).toContainEqual(
        expect.objectContaining({
          type: "open",
          human: true,
          machine: { codeFolder: "/remote/code", agent: "claude", defaults: [] },
          context: expect.objectContaining({
            repository: "/home/remote-user",
            worktree: "/home/remote-user",
          }) as unknown,
        }),
      );
    } else
      expect(
        child.messages.some(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "open",
        ),
      ).toBe(false);
  },
);

test.each([true, false])(
  "origin trust on a compatible older daemon requires its capability: %s",
  async (supported) => {
    transport.kill();
    transport = new RemoteTransport(
      {
        host: "fixture",
        artifact: "/artifact",
        human: true,
        trustOrigin: "git@forge.test:team/repo.git",
      },
      "0.1.0",
    );
    await Promise.resolve();
    transport.postMessage({
      type: "create",
      id: "trust",
      request: 1,
      spec: { command: "/bin/sh", args: [], cwd: "/", cols: 80, rows: 24 },
    });
    child.header();
    child.message({
      type: "hello",
      build: "b".repeat(64),
      startupTheme: 1,
      compatible: 2,
      ...(supported ? { originTrust: 1 } : {}),
    });
    if (supported)
      expect(child.messages).toContainEqual(
        expect.objectContaining({
          type: "open",
          human: true,
          trustOrigin: "git@forge.test:team/repo.git",
        }),
      );
    else {
      expect(transport.launchFailure?.reason).toBe("remote_host_facts_unavailable");
      expect(child.messages).not.toContainEqual(expect.objectContaining({ type: "open" }));
    }
  },
);

test.each(["repository", "checkout", "reattach"] as const)(
  "older daemon retains machine %s support without home capability",
  async (kind) => {
    transport.kill();
    const machineHome = vi.fn();
    transport = new RemoteTransport(
      {
        host: "fixture",
        human: true,
        machineHome,
        machine: {
          codeFolder: "/code",
          ...(kind === "repository"
            ? {
                repository: {
                  directory: `repository-${"a".repeat(24)}`,
                  origin: "https://fixture.test/repo.git",
                },
              }
            : {}),
        },
        ...(kind === "checkout"
          ? { checkout: { repository: "/code/repo", path: "/code/tree", identity: "a".repeat(64) } }
          : {}),
        ...(kind === "reattach" ? { reattach: true } : {}),
      },
      "0.1.0",
    );
    transport.postMessage(create);
    await Promise.resolve();
    child.header();
    child.message({
      type: "hello",
      build: "b".repeat(64),
      startupTheme: 1,
      compatible: 2,
      humanMachines: 1,
    });
    expect(child.messages).toContainEqual(
      expect.objectContaining({ type: "open", reattach: kind === "reattach" }),
    );
    expect(machineHome).not.toHaveBeenCalled();
  },
);

test("startup cancellation before open stops SSH and ignores buffered negotiation", async () => {
  transport.postMessage(create);
  await Promise.resolve();
  expect(transport.cancelStartup()).toBe(true);
  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  child.greet();
  expect(
    child.messages.some(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "open",
    ),
  ).toBe(false);
});

test("startup cancellation after open was sent requires the owner to settle and close the session", async () => {
  transport.postMessage(create);
  await Promise.resolve();
  child.greet();
  expect(transport.cancelStartup()).toBe(false);
  expect(child.kill).not.toHaveBeenCalled();
  child.message({ type: "open-result", request: 1, id: "one", state: "live" });
  expect(events).toContainEqual(expect.objectContaining({ type: "result", id: "one", request: 1 }));
});

test.each([false, true])(
  "row inspection capability refuses old daemons without falling back (%s)",
  async (supported) => {
    for (const request of [
      {
        type: "manage",
        operation: "inspect",
        codeFolder: "/remote/code",
        readOnly: true,
        partial: true,
        target: { kind: "tool", tool: "git" },
      },
      { type: "manage", operation: "create-folder", codeFolder: "/remote/code" },
    ] as const) {
      transport.kill();
      child = new Child();
      mock.spawn.mockReturnValue(child);
      const pending = remoteManagement({ host: "fixture" }, "0.1.0", request);
      await Promise.resolve();
      child.header();
      child.message({
        type: "hello",
        build: "b".repeat(64),
        compatible: 2,
        hostFacts: 1,
        hostPreflight: 1,
        ...(supported ? { hostRowCheck: 1 as const } : {}),
      });
      if (supported) {
        expect(child.messages).toContainEqual(request);
        child.message({ type: "managed", result: { ok: false, reason: "folder-refused" } });
      } else expect(child.messages).not.toContainEqual(request);
      await expect(pending).resolves.toMatchObject({
        ok: false,
        reason: supported ? "folder-refused" : "facts-unavailable",
      });
    }
  },
);

test.each([true, false])(
  "shell open carries the resolved startup palette (dark=%s)",
  async (dark) => {
    const theme = terminalThemes[dark ? "foom-dark" : "foom-light"];
    transport.postMessage({ ...create, dark, theme });
    await Promise.resolve();
    child.greet();
    expect(child.messages).toContainEqual(expect.objectContaining({ type: "open", dark, theme }));
    child.message({ type: "open-result", id: "one", request: 1, state: "live" });
    expect(child.messages).not.toContainEqual(expect.objectContaining({ type: "theme" }));
  },
);
test.each([undefined, 1] as const)(
  "fresh launches require startup palettes from a compatible older daemon (%s)",
  async (startupTheme) => {
    transport.postMessage(create);
    await Promise.resolve();
    child.header();
    child.message({
      type: "hello",
      build: "b".repeat(64),
      compatible: 2,
      ...(startupTheme ? { startupTheme } : {}),
    });
    expect(
      child.messages.some(
        (value) =>
          typeof value === "object" && value !== null && "type" in value && value.type === "open",
      ),
    ).toBe(startupTheme === 1);
    if (!startupTheme)
      expect(transport.launchFailure?.reason).toBe("remote_host_facts_unavailable");
  },
);

test.each([true, false])(
  "agent-open carries the resolved startup palette (dark=%s)",
  async (dark) => {
    const theme = terminalThemes[dark ? "foom-dark" : "foom-light"];
    await remoteAgent({ dark, theme });
    expect(child.messages).toContainEqual(
      expect.objectContaining({ type: "agent-open", dark, theme }),
    );
  },
);

test("hub restart reattaches an older compatible daemon without replacing retained colors", async () => {
  transport.kill();
  transport = new RemoteTransport(
    { host: "fixture", artifact: "/artifact", reattach: true },
    "0.1.0",
  );
  transport.postMessage({ ...create, dark: true, theme: terminalThemes["foom-dark"] });
  await Promise.resolve();
  child.header();
  child.message({ type: "hello", build: "b".repeat(64), compatible: 2 });
  expect(child.messages).toContainEqual(expect.objectContaining({ type: "open", reattach: true }));
  child.message({ type: "open-result", id: "one", request: 1, state: "live" });
  expect(child.messages).not.toContainEqual(expect.objectContaining({ type: "theme" }));
  expect(transport.launchFailure).toBeUndefined();
});

test("initial reattach delivers a theme changed before hello and preserves it after acknowledgement", async () => {
  transport.kill();
  transport = new RemoteTransport(
    { host: "fixture", artifact: "/artifact", reattach: true },
    "0.1.0",
  );
  transport.postMessage({ ...create, dark: false, theme: terminalThemes["foom-light"] });
  transport.postMessage({
    type: "theme",
    id: "one",
    request: 2,
    dark: true,
    theme: terminalThemes["foom-dark"],
  });
  await Promise.resolve();
  child.greet();
  expect(child.messages).not.toContainEqual(expect.objectContaining({ type: "theme" }));
  const atCreateResult: unknown[][] = [];
  transport.on("message", (message: { type: string; request?: number }) => {
    if (message.type === "result" && message.request === 1)
      atCreateResult.push([...child.messages]);
  });
  child.message({ type: "open-result", id: "one", request: 1, state: "live" });
  expect(atCreateResult).toEqual([
    [
      expect.objectContaining({ type: "hello" }),
      expect.objectContaining({ type: "open", reattach: true }),
      expect.objectContaining({ type: "theme", dark: true, theme: terminalThemes["foom-dark"] }),
    ],
  ]);
  expect(child.messages).toContainEqual(
    expect.objectContaining({ type: "theme", dark: true, theme: terminalThemes["foom-dark"] }),
  );
  child.message({ type: "result", id: "one", request: requestOf(child, "theme"), lines: [] });
  await reconnectLive();
  expect(child.messages).not.toContainEqual(expect.objectContaining({ type: "theme" }));
  expect(child.messages).not.toContainEqual(expect.objectContaining({ type: "resize" }));
  await vi.advanceTimersByTimeAsync(120_001);
  expect(child.kill).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test("initial reattach does not repeat an in-flight theme on the same connection", async () => {
  transport.kill();
  transport = new RemoteTransport(
    { host: "fixture", artifact: "/artifact", reattach: true },
    "0.1.0",
  );
  transport.postMessage({ ...create, dark: false, theme: terminalThemes["foom-light"] });
  await Promise.resolve();
  child.greet();
  transport.postMessage({
    type: "theme",
    id: "one",
    request: 2,
    dark: true,
    theme: terminalThemes["foom-dark"],
  });
  const sent = [
    expect.objectContaining({ type: "hello" }),
    expect.objectContaining({ type: "open", reattach: true }),
    expect.objectContaining({ type: "theme", dark: true, theme: terminalThemes["foom-dark"] }),
  ];
  expect(child.messages).toEqual(sent);
  const atCreateResult: unknown[][] = [];
  transport.on("message", (message: { type: string; request?: number }) => {
    if (message.type === "result" && message.request === 1)
      atCreateResult.push([...child.messages]);
  });
  child.message({ type: "open-result", id: "one", request: 1, state: "live" });
  expect(atCreateResult).toEqual([sent]);
  expect(child.messages).toEqual(sent);
  // Losing the acknowledgement still requires a replacement on the next stream.
  await reconnectLive();
  expect(child.messages).toEqual(sent);
  child.message({ type: "result", id: "one", request: requestOf(child, "theme"), lines: [] });
  await reconnectLive();
  expect(child.messages).toEqual(sent.slice(0, 2));
});

test.each(["offline", "in-flight"])(
  "replays a %s theme update after reconnect, then preserves colors after acknowledgement",
  async (loss) => {
    const light = terminalThemes["foom-light"];
    const dark = terminalThemes["foom-dark"];
    transport.postMessage({ ...create, dark: false, theme: light });
    await Promise.resolve();
    child.greet();
    child.message({ type: "open-result", id: "one", request: 1, state: "live" });
    transport.postMessage({ type: "attach", id: "one", request: 2, view: "v" });
    child.message({ type: "result", id: "one", request: 2, lines: [] });
    const update = { type: "theme", id: "one", request: 3, dark: true, theme: dark } as const;
    if (loss === "offline") child.emit("close");
    transport.postMessage(update);
    if (loss === "in-flight") child.emit("close");
    expect(events).toContainEqual({ type: "error", id: "one", request: 3 });
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
    expect(child.messages).toContainEqual(
      expect.objectContaining({ type: "theme", dark: true, theme: dark }),
    );
    expect(child.messages).not.toContainEqual(expect.objectContaining({ type: "resize" }));
    child.message({ type: "result", id: "one", request: requestOf(child, "theme"), lines: [] });
    child.message({ type: "result", id: "one", request: requestOf(child, "attach"), lines: [] });
    // A subsequent disconnect must not reset application-set colors again.
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
    expect(child.messages).not.toContainEqual(expect.objectContaining({ type: "theme" }));
    child.message({ type: "result", id: "one", request: requestOf(child, "attach"), lines: [] });
    await vi.advanceTimersByTimeAsync(120001);
    expect(child.kill).not.toHaveBeenCalled();
  },
);

test("reattaches a hidden restored session without inventing an 80x24 resize or retaining a deadline", async () => {
  transport.kill();
  transport = new RemoteTransport(
    { host: "fixture", artifact: "/artifact", reattach: true },
    "0.1.0",
  );
  transport.postMessage(create);
  await Promise.resolve();
  child.greet();
  child.message({ type: "open-result", id: "one", request: 1, state: "live" });
  const initialConnections = mock.spawn.mock.calls.length;
  // There is no view and no reported size. Each successful open completes the
  // restoration and renews the retry allowance without touching the remote PTY.
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
    expect(child.messages).not.toContainEqual(expect.objectContaining({ type: "resize" }));
    expect(child.messages).not.toContainEqual(expect.objectContaining({ type: "theme" }));
    await vi.advanceTimersByTimeAsync(120001);
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  }
  expect(mock.spawn).toHaveBeenCalledTimes(initialConnections + 6);
});

async function reconnectLive() {
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
}

test("a connected theme acknowledgement preserves application colors on reconnect", async () => {
  await ready();
  transport.postMessage({ type: "theme", id: "one", request: 2, dark: true });
  child.message({ type: "result", id: "one", request: 2, lines: [] });
  await reconnectLive();
  expect(child.messages).not.toContainEqual(expect.objectContaining({ type: "theme" }));
});

test("returning to the confirmed palette while offline does not replace application colors", async () => {
  await ready();
  child.emit("close");
  transport.postMessage({ type: "theme", id: "one", request: 2, dark: true });
  transport.postMessage({ type: "theme", id: "one", request: 3, dark: false });
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
  expect(child.messages).not.toContainEqual(expect.objectContaining({ type: "theme" }));
});

test.each(["error", "disconnect"])(
  "a theme %s leaves the latest replacement pending until confirmed",
  async (outcome) => {
    await ready();
    transport.postMessage({ type: "theme", id: "one", request: 2, dark: true });
    if (outcome === "error") child.message({ type: "error", id: "one", request: 2 });
    await reconnectLive();
    const missed = requestOf(child, "theme");
    // A newer update is sent while the first restoration reply is outstanding.
    transport.postMessage({ type: "theme", id: "one", request: 3, dark: false });
    child.message({ type: "result", id: "one", request: missed, lines: [] });
    await reconnectLive();
    expect(child.messages).toContainEqual(expect.objectContaining({ type: "theme", dark: false }));
    child.message({ type: "result", id: "one", request: requestOf(child, "theme"), lines: [] });
    await reconnectLive();
    expect(child.messages).not.toContainEqual(expect.objectContaining({ type: "theme" }));
  },
);

test("an older delayed theme acknowledgement cannot roll back a newer confirmed palette", async () => {
  await ready();
  transport.postMessage({ type: "theme", id: "one", request: 2, dark: true });
  transport.postMessage({ type: "theme", id: "one", request: 3, dark: false });
  child.message({ type: "result", id: "one", request: 3, lines: [] });
  child.message({ type: "result", id: "one", request: 2, lines: [] });
  await reconnectLive();
  expect(child.messages).not.toContainEqual(expect.objectContaining({ type: "theme" }));
});

test("explicit management output observes upload steps and stderr without exposing protocol frames", async () => {
  transport.kill();
  const output = vi.fn();
  const managed = remoteManagement(
    { host: "fixture", artifact: "/artifact" },
    "0.1.0",
    { type: "manage", operation: "inspect", readOnly: true, partial: true, codeFolder: "~/code" },
    undefined,
    output,
  );
  await Promise.resolve();
  child.stderr.write("SSH diagnostic\n");
  child.header("FOOM-UPLOAD\nFOOM-READY\n");
  child.message({ type: "hello", build: "a".repeat(64) });
  child.message({ type: "managed", result: { ok: false, reason: "folder-missing" } });
  await expect(managed).resolves.toMatchObject({ ok: false, reason: "folder-missing" });
  expect(output.mock.calls).toEqual([
    ["SSH diagnostic\n"],
    ["Uploading daemon…\n", true],
    ["Daemon ready · Inspecting…\n", true],
  ]);
});

test.each([true, false])(
  "child pressure capability %s gates request fields and reports older daemons unmeasured",
  async (capable) => {
    const agent = await remoteAgent({}, true, capable);
    const opening = child.messages.find(
      (value) =>
        value && typeof value === "object" && "type" in value && value.type === "agent-open",
    );
    expect(opening).toMatchObject({ spec: { agent: "claude" } });
    if (capable) expect(opening).toMatchObject({ spec: { childPressure: true } });
    else expect(JSON.stringify(opening)).not.toContain("childPressure");
    const pressure = {
      measured: true as const,
      loadPerCore: 0.5,
      memoryAvailable: 8 * 1024 ** 3,
      memoryTotal: 16 * 1024 ** 3,
      sessions: 1,
      reservations: 0,
      budget: 4,
    };
    child.message({ type: "agent-prepared", id: "one", ...(capable ? { pressure } : {}) });
    await vi.advanceTimersByTimeAsync(0);
    expect(agent.pressure).toHaveBeenCalledWith(capable ? pressure : { measured: false });
  },
);
test("host_busy remote failures retain validated facts without retrying the start", async () => {
  await remoteAgent({}, true, true);
  const pressure = {
    measured: true as const,
    loadPerCore: 1,
    memoryAvailable: 8 * 1024 ** 3,
    memoryTotal: 16 * 1024 ** 3,
    sessions: 1,
    reservations: 0,
    budget: 4,
  };
  const starts = mock.spawn.mock.calls.length;
  child.message({ type: "agent-failed", id: "one", reason: "host_busy", pressure });
  expect(transport.launchFailure).toMatchObject({ reason: "host_busy", pressure });
  await vi.advanceTimersByTimeAsync(1000);
  expect(mock.spawn).toHaveBeenCalledTimes(starts);
});
