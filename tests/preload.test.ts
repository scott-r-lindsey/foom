import { beforeEach, expect, test, vi } from "vitest";
import type { DesktopApi } from "../src/shared/desktop";
const mock = vi.hoisted(() => ({
  expose: vi.fn<(name: string, api: DesktopApi) => void>(),
  invoke: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  send: vi.fn(),
  on: vi.fn<(channel: string, callback: (event: unknown, ...values: unknown[]) => void) => void>(),
  removeListener: vi.fn(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: mock.expose },
  ipcRenderer: mock,
}));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
async function bridge() {
  await import("../src/preload");
  const api = mock.expose.mock.calls[0]?.[1];
  if (!api) throw new Error("Missing bridge");
  return api;
}
test("starts through the dedicated channel and validates the response", async () => {
  const api = await bridge();
  mock.invoke.mockResolvedValue({ id: "one", title: "bash" });
  await expect(api.create(80, 24)).resolves.toEqual({ id: "one", title: "bash" });
  expect(mock.invoke).toHaveBeenCalledWith("terminal:create", 80, 24);
  mock.invoke.mockResolvedValue({});
  await expect(api.create(80, 24)).rejects.toThrow("Invalid terminal response");
  mock.invoke.mockRejectedValue(new Error("spawn failed"));
  await expect(api.create(80, 24)).rejects.toThrow("spawn failed");
});
test("chunks large pastes and forwards resize and flow control", async () => {
  const api = await bridge();
  api.input("one", "x".repeat(65537));
  expect(mock.send.mock.calls).toEqual([
    ["terminal:input", "one", "x".repeat(65536)],
    ["terminal:input", "one", "x"],
  ]);
  api.resize("one", 100, 30);
  api.acknowledge("one", "view", 99);
  expect(mock.send).toHaveBeenCalledWith("terminal:resize", "one", 100, 30);
  expect(mock.send).toHaveBeenCalledWith("terminal:ack", "one", "view", 99);
});
test("strips event objects, validates events, and removes listeners", async () => {
  const api = await bridge();
  const data = vi.fn();
  const exit = vi.fn();
  const offData = api.onData(data);
  const offExit = api.onExit(exit);
  const dataHandler = mock.on.mock.calls[0]?.[1];
  const exitHandler = mock.on.mock.calls[1]?.[1];
  dataHandler?.({}, "one", "view", "hello");
  dataHandler?.({}, null);
  exitHandler?.({}, "one", 0);
  exitHandler?.({}, "bad");
  expect(data.mock.calls).toEqual([["one", "view", "hello"]]);
  expect(exit.mock.calls).toEqual([["one", 0]]);
  offData();
  offExit();
  expect(mock.removeListener).toHaveBeenCalledWith("terminal:data", dataHandler);
  expect(mock.removeListener).toHaveBeenCalledWith("terminal:exit", exitHandler);
});

test("lifecycle requests and code-point-safe paste chunks", async () => {
  const api = await bridge();
  mock.invoke.mockResolvedValue(undefined);
  await api.attach("one");
  await api.detach("one");
  await api.kill("one");
  expect(mock.invoke.mock.calls).toEqual([
    ["terminal:attach", "one"],
    ["terminal:detach", "one"],
    ["terminal:kill", "one"],
  ]);
  api.input("one", "x".repeat(65535) + "😀z");
  expect(mock.send.mock.calls).toEqual([
    ["terminal:input", "one", "x".repeat(65535)],
    ["terminal:input", "one", "😀z"],
  ]);
});

test.each([
  ["emoji across the boundary", "x".repeat(65535) + "😀tail", ["x".repeat(65535), "😀tail"]],
  [
    "emoji ending at the boundary",
    "x".repeat(65534) + "😀tail",
    ["x".repeat(65534) + "😀", "tail"],
  ],
  ["emoji after the boundary", "x".repeat(65536) + "😀", ["x".repeat(65536), "😀"]],
  [
    "successive boundaries",
    "x".repeat(65535) + "😀" + "y".repeat(65533) + "😀",
    ["x".repeat(65535), "😀" + "y".repeat(65533), "😀"],
  ],
  ["lone high surrogate", "x".repeat(65535) + "\ud800z", ["x".repeat(65535) + "\ud800", "z"]],
  [
    "high surrogate followed by BMP text",
    "x".repeat(65535) + "\ud800\ue000",
    ["x".repeat(65535) + "\ud800", "\ue000"],
  ],
  ["empty input", "", []],
])("preserves input with %s", async (_label, input, chunks) => {
  const api = await bridge();
  api.input("one", input);
  expect(mock.send.mock.calls).toEqual(chunks.map((chunk) => ["terminal:input", "one", chunk]));
  expect(chunks.join("")).toBe(input);
  expect(chunks.every((chunk) => chunk.length <= 65536)).toBe(true);
});
