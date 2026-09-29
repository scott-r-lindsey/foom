import type { TerminalTelemetry } from "../src/shared/desktop";
import { EventEmitter } from "node:events";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
const mock = vi.hoisted(() => {
  const events: TerminalTelemetry = {};
  return {
    events,
    create: vi.fn(),
    attach: vi.fn(),
    detach: vi.fn(),
    kill: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    setTheme: vi.fn(),
    acknowledge: vi.fn(),
    tail: vi.fn(),
    dispose: vi.fn(),
    shutdown: vi.fn<() => Promise<void>>(),
    onExit: vi.fn<(id: string, code: number) => void>(),
  };
});
vi.mock("../src/terminal-manager", () => ({
  TerminalManager: class {
    create = mock.create;
    attach = mock.attach;
    detach = mock.detach;
    kill = mock.kill;
    write = mock.write;
    resize = mock.resize;
    setTheme = mock.setTheme;
    acknowledge = mock.acknowledge;
    tail = mock.tail;
    dispose = mock.dispose;
    shutdown = mock.shutdown;
    constructor(onExit: (id: string, code: number) => void, events: TerminalTelemetry) {
      mock.events = events;
      mock.onExit.mockImplementation(onExit);
    }
  },
}));
class Port extends EventEmitter {
  postMessage = vi.fn();
}
let port: Port;
const original = Object.getOwnPropertyDescriptor(process, "parentPort");
let exitListener: ((code: number) => void) | undefined;
beforeEach(async () => {
  vi.clearAllMocks();
  mock.shutdown.mockResolvedValue();
  vi.resetModules();
  port = new Port();
  Object.defineProperty(process, "parentPort", { configurable: true, value: port });
  const previous = process.listeners("exit");
  await import("../src/terminal-host");
  exitListener = process.listeners("exit").find((listener) => !previous.includes(listener));
});
afterEach(() => {
  if (exitListener) process.removeListener("exit", exitListener);
  if (original) Object.defineProperty(process, "parentPort", original);
  else Reflect.deleteProperty(process, "parentPort");
});
const spec = { command: "/bin/bash", args: ["-l"], cwd: "/tmp", cols: 80, rows: 24 };
async function message(data: unknown) {
  port.emit("message", { data });
  await Promise.resolve();
  await Promise.resolve();
}
test("dispatches validated terminal operations and reports events with IDs", async () => {
  await message({ type: "create", id: "one", request: 1, spec });
  expect(mock.create).toHaveBeenCalledWith(spec, "one", undefined);
  mock.attach.mockImplementation((_id: string, send: (token: string, data: string) => void) => {
    send("view", "snapshot");
  });
  mock.tail.mockResolvedValue(["tail"]);
  for (const operation of [
    { type: "attach", view: "view" },
    { type: "detach" },
    { type: "theme", dark: true },
    { type: "write", data: "input" },
    { type: "resize", cols: 90, rows: 25 },
    { type: "acknowledge", token: "view", count: 8 },
    { type: "tail", lines: 1 },
  ])
    await message({ ...operation, id: "one", request: 2 });
  expect(mock.write).toHaveBeenCalledWith("one", "input");
  expect(mock.setTheme).toHaveBeenCalledWith("one", true);
  expect(mock.resize).toHaveBeenCalledWith("one", 90, 25);
  expect(mock.acknowledge).toHaveBeenCalledWith("one", "view", 8);
  expect(port.postMessage).toHaveBeenCalledWith({
    type: "data",
    view: "view",
    id: "one",
    token: "view",
    data: "snapshot",
  });
  expect(port.postMessage).toHaveBeenCalledWith({
    type: "result",
    id: "one",
    request: 2,
    lines: ["tail"],
  });
  mock.onExit("one", 3);
  expect(port.postMessage).toHaveBeenCalledWith({ type: "exit", id: "one", code: 3 });
  await message({ type: "kill", id: "one", request: 3 });
  expect(mock.kill).toHaveBeenCalledWith("one");
  await message({ type: "write", id: "one", request: 4, data: "stale" });
  expect(port.postMessage).toHaveBeenLastCalledWith({ type: "error", id: "one", request: 4 });
});
test("rejects invalid, foreign and duplicate requests; a spawn failure can retry", async () => {
  await message(null);
  expect(port.postMessage).not.toHaveBeenCalled();
  await message({ type: "attach", view: "view", id: "foreign", request: 1 });
  expect(port.postMessage).toHaveBeenLastCalledWith({ type: "error", id: "foreign", request: 1 });
  mock.create.mockImplementationOnce(() => {
    throw new Error("missing binary");
  });
  await message({ type: "create", id: "one", request: 2, spec });
  expect(port.postMessage).toHaveBeenLastCalledWith({ type: "error", id: "one", request: 2 });
  await message({ type: "create", id: "one", request: 3, spec });
  await message({ type: "create", id: "one", request: 4, spec });
  expect(mock.create).toHaveBeenCalledTimes(2);
  expect(port.postMessage).toHaveBeenLastCalledWith({ type: "error", id: "one", request: 4 });
});
test("shutdown waits for PTY exits and reports failure so quitting can retry", async () => {
  await message({ type: "shutdown", id: "host", request: 1 });
  expect(mock.shutdown).toHaveBeenCalledOnce();
  expect(port.postMessage).toHaveBeenLastCalledWith({
    type: "result",
    id: "host",
    request: 1,
    lines: [],
  });
  mock.shutdown.mockRejectedValueOnce(new Error("native exit timed out"));
  await message({ type: "shutdown", id: "host", request: 2 });
  await Promise.resolve();
  expect(port.postMessage).toHaveBeenLastCalledWith({ type: "error", id: "host", request: 2 });
});
test.each([false, true])(
  "dispose exits only after native shutdown settles (failure=%s)",
  async (failure) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "exit");
    const exit = vi.fn();
    Object.defineProperty(process, "exit", { configurable: true, value: exit });
    try {
      let done: () => void = () => {};
      mock.shutdown.mockImplementationOnce(
        () =>
          new Promise<void>((resolve, reject) => {
            done = () => {
              if (failure) reject(new Error("timeout"));
              else resolve();
            };
          }),
      );
      await message("shutdown");
      expect(exit).not.toHaveBeenCalled();
      done();
      await Promise.resolve();
      await Promise.resolve();
      expect(exit).toHaveBeenCalledWith(failure ? 1 : 0);
      exitListener?.(0);
      expect(mock.dispose).toHaveBeenCalledOnce();
    } finally {
      if (descriptor) Object.defineProperty(process, "exit", descriptor);
    }
  },
);

test("forwards activity batches and quiet IDs from the host meter", () => {
  mock.events.onActivity?.([{ id: "one", rate: 42 }]);
  mock.events.onQuiet?.("one");
  expect(port.postMessage).toHaveBeenCalledWith({
    type: "activity",
    entries: [{ id: "one", rate: 42 }],
  });
  expect(port.postMessage).toHaveBeenCalledWith({ type: "quiet", id: "one" });
});
