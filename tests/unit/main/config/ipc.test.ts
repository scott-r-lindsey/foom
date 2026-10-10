import { beforeEach, expect, test, vi } from "vitest";
import type { BrowserWindow } from "electron";
const mock = vi.hoisted(() => ({
  handle:
    vi.fn<(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => void>(),
  removeHandler: vi.fn(),
  openPath: vi.fn(() => Promise.resolve("")),
}));
vi.mock("electron", () => ({ ipcMain: mock, shell: mock }));
import { attachConfig } from "../../../../src/main/config/ipc";

const frame = { url: "app://bundle/index.html" };
const contents = { mainFrame: frame };
const trusted = { sender: contents, senderFrame: frame };
const status = { folder: "/home/.foom/config", available: true, changes: [] };
const service = {
  folder: "/home/.foom/config",
  status: vi.fn(() => status),
  decide: vi.fn(() => Promise.resolve(status)),
  revert: vi.fn(() => Promise.resolve(status)),
};
let dispose: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  frame.url = "app://bundle/index.html";
  dispose = attachConfig(
    { webContents: contents } as unknown as BrowserWindow,
    service as unknown as Parameters<typeof attachConfig>[1],
  );
});
function invoke(channel: string, args: unknown[] = [], event: unknown = trusted) {
  const handler = mock.handle.mock.calls.find(([name]) => name === channel)?.[1];
  if (!handler) throw new Error("missing handler");
  return handler(event, ...args);
}

test("checks the sender, top frame and URL on every channel", async () => {
  for (const channel of ["config:status", "config:decide", "config:revert", "config:open-folder"])
    for (const event of [
      { sender: {}, senderFrame: frame },
      { sender: contents, senderFrame: null },
      { sender: contents, senderFrame: { url: frame.url } },
    ])
      await expect(invoke(channel, [], event)).rejects.toThrow("Untrusted");
  frame.url = "https://example.org";
  await expect(invoke("config:status")).rejects.toThrow("Untrusted");
  expect(service.status).not.toHaveBeenCalled();
});

test("validates argument counts, decisions and commit IDs at runtime", async () => {
  await expect(invoke("config:status", [1])).rejects.toThrow("arguments");
  await expect(invoke("config:open-folder", ["/etc"])).rejects.toThrow("arguments");
  for (const value of [undefined, "yes", { allow: true }])
    await expect(invoke("config:decide", [value])).rejects.toThrow("arguments");
  await expect(invoke("config:decide", ["allow", "extra"])).rejects.toThrow("arguments");
  for (const value of ["HEAD", "HEAD~1", "a".repeat(39), `${"a".repeat(40)}\n`, 7])
    await expect(invoke("config:revert", [value])).rejects.toThrow("arguments");
  expect(service.decide).not.toHaveBeenCalled();
  expect(service.revert).not.toHaveBeenCalled();
});

test("routes valid requests, opens only the fixed folder and disposes", async () => {
  await expect(invoke("config:status")).resolves.toBe(status);
  await expect(invoke("config:decide", ["keep"])).resolves.toBe(status);
  expect(service.decide).toHaveBeenCalledWith("keep");
  const commit = "a".repeat(40);
  await expect(invoke("config:revert", [commit])).resolves.toBe(status);
  expect(service.revert).toHaveBeenCalledWith(commit);
  await expect(invoke("config:open-folder")).resolves.toBeUndefined();
  expect(mock.openPath).toHaveBeenCalledWith("/home/.foom/config");
  mock.openPath.mockResolvedValueOnce("failed");
  await expect(invoke("config:open-folder")).rejects.toThrow("Unable to open");
  dispose();
  expect(mock.removeHandler).toHaveBeenCalledTimes(4);
});
