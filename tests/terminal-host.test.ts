import { EventEmitter } from "node:events";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
const mock = vi.hoisted(() => ({
  create: vi.fn(),
  attach: vi.fn(),
  detach: vi.fn(),
  kill: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  acknowledge: vi.fn(),
  tail: vi.fn(),
  dispose: vi.fn(),
  onExit: vi.fn<(id: string, code: number) => void>(),
}));
vi.mock("../src/terminal-manager", () => ({
  TerminalManager: class {
    create = mock.create;
    attach = mock.attach;
    detach = mock.detach;
    kill = mock.kill;
    write = mock.write;
    resize = mock.resize;
    acknowledge = mock.acknowledge;
    tail = mock.tail;
    dispose = mock.dispose;
    constructor(onExit: (id: string, code: number) => void) {
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
  expect(mock.create).toHaveBeenCalledWith(spec, "one");
  mock.attach.mockImplementation((_id: string, send: (token: string, data: string) => void) => {
    send("view", "snapshot");
  });
  mock.tail.mockResolvedValue(["tail"]);
  for (const operation of [
    { type: "attach", view: "view" },
    { type: "detach" },
    { type: "write", data: "input" },
    { type: "resize", cols: 90, rows: 25 },
    { type: "acknowledge", token: "view", count: 8 },
    { type: "tail", lines: 1 },
  ])
    await message({ ...operation, id: "one", request: 2 });
  expect(mock.write).toHaveBeenCalledWith("one", "input");
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
test("shutdown and process exit dispose PTYs", () => {
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("exit");
  });
  expect(() => port.emit("message", { data: "shutdown" })).toThrow("exit");
  expect(mock.dispose).toHaveBeenCalledOnce();
  exitListener?.(0);
  expect(mock.dispose).toHaveBeenCalledTimes(2);
});
