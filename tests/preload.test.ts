import { beforeEach, expect, test, vi } from "vitest";
import type { DesktopApi } from "../src/shared/desktop";
const mock = vi.hoisted(() => ({
  expose: vi.fn<(name: string, api: DesktopApi) => void>(),
  invoke: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  send: vi.fn(),
  on: vi.fn<(channel: string, callback: (event: unknown, value: unknown) => void) => void>(),
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
  mock.invoke.mockResolvedValue("bash");
  await expect(api.start(80, 24)).resolves.toBe("bash");
  expect(mock.invoke).toHaveBeenCalledWith("terminal:start", 80, 24);
  mock.invoke.mockResolvedValue({});
  await expect(api.start(80, 24)).rejects.toThrow("Invalid terminal response");
  mock.invoke.mockRejectedValue(new Error("spawn failed"));
  await expect(api.start(80, 24)).rejects.toThrow("spawn failed");
});
test("chunks large pastes and forwards resize and flow control", async () => {
  const api = await bridge();
  api.input("x".repeat(65537));
  expect(mock.send.mock.calls).toEqual([
    ["terminal:input", "x".repeat(65536)],
    ["terminal:input", "x"],
  ]);
  api.resize(100, 30);
  api.acknowledge(99);
  expect(mock.send).toHaveBeenCalledWith("terminal:resize", 100, 30);
  expect(mock.send).toHaveBeenCalledWith("terminal:ack", 99);
});
test("strips event objects, validates events, and removes listeners", async () => {
  const api = await bridge();
  const data = vi.fn();
  const exit = vi.fn();
  const offData = api.onData(data);
  const offExit = api.onExit(exit);
  const dataHandler = mock.on.mock.calls[0]?.[1];
  const exitHandler = mock.on.mock.calls[1]?.[1];
  dataHandler?.({}, "hello");
  dataHandler?.({}, null);
  exitHandler?.({}, 0);
  exitHandler?.({}, "bad");
  expect(data.mock.calls).toEqual([["hello"]]);
  expect(exit.mock.calls).toEqual([[0]]);
  offData();
  offExit();
  expect(mock.removeListener).toHaveBeenCalledWith("terminal:data", dataHandler);
  expect(mock.removeListener).toHaveBeenCalledWith("terminal:exit", exitHandler);
});
