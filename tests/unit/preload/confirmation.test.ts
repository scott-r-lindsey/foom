import { expect, test, vi } from "vitest";
import type { ConfirmationWindowApi, DialogRequest } from "../../../src/shared/confirmation";
const mock = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn<(name: string, api: ConfirmationWindowApi) => void>(),
  on: vi.fn<(channel: string, listener: (event: unknown, value: unknown) => void) => void>(),
  send: vi.fn(),
}));
vi.mock("electron", () => ({ contextBridge: mock, ipcRenderer: mock }));
test("buffers main's request before React subscribes and exposes only render and answer", async () => {
  await import("../../../src/preload/confirmation");
  const api = mock.exposeInMainWorld.mock.calls[0]?.[1];
  if (!api) throw Error("Missing API");
  expect(Object.keys(api)).toEqual(["render", "answer"]);
  const listener = mock.on.mock.calls[0]?.[1];
  const request = { id: "one" };
  listener?.({}, request);
  const render = vi.fn<(request: DialogRequest | null) => void>();
  const dispose = api.render(render);
  expect(render).toHaveBeenCalledWith(request);
  listener?.({}, null);
  expect(render).toHaveBeenLastCalledWith(null);
  api.answer("one", false);
  expect(mock.send).toHaveBeenCalledWith("confirmation:answer", "one", false);
  dispose();
  listener?.({}, request);
  expect(render).toHaveBeenCalledTimes(2);
});
