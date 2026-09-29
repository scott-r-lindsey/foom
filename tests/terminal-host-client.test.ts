import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { HostRequest } from "../src/shared/terminal-host";
const mock = vi.hoisted(() => ({
  fork: vi.fn(),
  theme: {
    shouldUseDarkColors: false,
    on: vi.fn<(event: string, callback: () => void) => void>(),
    removeListener: vi.fn(),
  },
}));
vi.mock("electron", () => ({ utilityProcess: mock, nativeTheme: mock.theme }));
import { TerminalHostClient } from "../src/terminal-host-client";
class Child extends EventEmitter {
  postMessage = vi.fn<(message: HostRequest | "shutdown") => void>();
  kill = vi.fn();
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
let child: Child;
let client: TerminalHostClient;
const exited = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
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
    expect.objectContaining({ serviceName: "Foom terminal host" }),
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
test("times out a hung host and rejects creation without leaking requests", async () => {
  const creating = client.create(spec);
  const rejected = expect(creating).rejects.toThrow("stopped");
  await vi.advanceTimersByTimeAsync(10000);
  await rejected;
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
