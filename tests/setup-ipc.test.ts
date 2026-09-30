import { beforeEach, expect, test, vi } from "vitest";
import type { BrowserWindow } from "electron";
import type { Setup } from "../src/setup";

const mock = vi.hoisted(() => ({
  handle:
    vi.fn<(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => void>(),
  removeHandler: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcMain: { handle: mock.handle, removeHandler: mock.removeHandler },
}));
import { attachSetup } from "../src/setup-ipc";

const frame = { url: "app://bundle/index.html" };
const contents = { mainFrame: frame };
const window = { webContents: contents } as unknown as BrowserWindow;
const trusted = { sender: contents, senderFrame: frame };
const setup = {
  state: vi.fn(() => "state"),
  save: vi.fn(() => "saved"),
  setKey: vi.fn(() => "set"),
  removeKey: vi.fn(() => "removed"),
  check: vi.fn(() => "checked"),
};
let dispose: () => void;

beforeEach(() => {
  vi.clearAllMocks();
  dispose = attachSetup(window, setup as unknown as Setup);
});

function invoke(channel: string, args: unknown[] = [], event: unknown = trusted) {
  const handler = mock.handle.mock.calls.find(([name]) => name === channel)?.[1];
  if (!handler) throw new Error(`Missing ${channel}`);
  return handler(event, ...args);
}

test("every channel rejects untrusted senders", () => {
  const channels = mock.handle.mock.calls.map(([name]) => name);
  expect(channels).toEqual([
    "setup:state",
    "setup:save",
    "setup:set-key",
    "setup:remove-key",
    "setup:check",
  ]);
  for (const channel of channels)
    for (const event of [
      { sender: {}, senderFrame: frame },
      { sender: contents, senderFrame: { url: frame.url } },
      { sender: contents, senderFrame: null },
    ])
      expect(() => invoke(channel, [], event)).toThrow("Untrusted IPC sender");
  frame.url = "https://example.com/";
  expect(() => invoke("setup:state")).toThrow("Untrusted IPC sender");
  frame.url = "app://bundle/index.html";
  expect(setup.state).not.toHaveBeenCalled();
});

test("passes payloads to Setup, which validates them, and never offers a key read", () => {
  expect(invoke("setup:state")).toBe("state");
  expect(invoke("setup:save", [{ hooks: false }])).toBe("saved");
  expect(setup.save).toHaveBeenCalledWith({ hooks: false });
  expect(invoke("setup:set-key", ["openai", "sk"])).toBe("set");
  expect(setup.setKey).toHaveBeenCalledWith("openai", "sk");
  expect(invoke("setup:remove-key", ["openai"])).toBe("removed");
  expect(invoke("setup:check", [{ kind: "rules" }])).toBe("checked");
  expect(mock.handle.mock.calls.some(([name]) => /get-key|read-key/.test(name))).toBe(false);
});

test("dispose removes every handler", () => {
  dispose();
  expect(mock.removeHandler.mock.calls.map(([name]: unknown[]) => name)).toEqual(
    mock.handle.mock.calls.map(([name]) => name),
  );
});
