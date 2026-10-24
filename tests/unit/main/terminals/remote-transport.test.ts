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
  kill = vi.fn(() => true);
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
  child.message({ type: "result", request: 1, id: "one", lines: [] });
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
  child.message({ type: "result", request: 1, id: "one", lines: [] });
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
  second.message({ type: "result", id: "one", request: open.request, lines: [] });
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
      child.message({ type: "result", id: "one", request: requestOf(child, "open"), lines: [] });
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
    child.message({ type: "result", id: "one", request: requestOf(child, "open"), lines: [] });
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
        child.message({ type: "result", id: "one", request: requestOf(child, "open"), lines: [] });
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
  child.message({ type: "result", id: "one", request: requestOf(child, "open"), lines: [] });
  child.message({ type: "error", id: "one", request: requestOf(child, "theme") });
  expect(child.kill).toHaveBeenCalled();
});
