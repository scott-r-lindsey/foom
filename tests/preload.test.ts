import { beforeEach, expect, test, vi } from "vitest";
import type { DesktopApi } from "../src/shared/desktop";

const bridge = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn<(name: string, api: DesktopApi) => void>(),
  invoke: vi.fn<(channel: string) => Promise<unknown>>(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: bridge.exposeInMainWorld },
  ipcRenderer: { invoke: bridge.invoke },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

async function loadBridge() {
  await import("../src/preload");
  const call = bridge.exposeInMainWorld.mock.calls[0];
  if (!call) throw new Error("Preload did not expose its API");
  expect(call[0]).toBe("desktop");
  return call[1];
}

test("exposes only the greeting capability and uses the dedicated IPC channel", async () => {
  bridge.invoke.mockResolvedValue("Hello!");
  const api = await loadBridge();
  expect(Object.keys(api)).toEqual(["sayHello"]);
  await expect(api.sayHello()).resolves.toBe("Hello!");
  expect(bridge.invoke).toHaveBeenCalledExactlyOnceWith("app:hello");
});

test.each([null, 42, {}, ["hello"]])(
  "rejects malformed main-process replies: %j",
  async (reply) => {
    bridge.invoke.mockResolvedValue(reply);
    const api = await loadBridge();
    await expect(api.sayHello()).rejects.toThrow("Invalid hello response");
  },
);

test("propagates IPC failures to the UI", async () => {
  bridge.invoke.mockRejectedValue(new Error("Disconnected"));
  const api = await loadBridge();
  await expect(api.sayHello()).rejects.toThrow("Disconnected");
});
