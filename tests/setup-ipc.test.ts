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
const contents = { mainFrame: frame, isDestroyed: vi.fn(() => false), send: vi.fn() };
const window = { webContents: contents } as unknown as BrowserWindow;
const trusted = { sender: contents, senderFrame: frame };
const setup = {
  state: vi.fn(() => "state"),
  save: vi.fn(() => "saved"),
  setKey: vi.fn(() => "set"),
  removeKey: vi.fn(() => "removed"),
  check: vi.fn(
    (_id: string, _config: unknown, _limit: unknown, onUpdate: (update: unknown) => void) => {
      onUpdate({ kind: "stream", thinking: 1, reply: "{" });
      return "checked";
    },
  ),
  cancel: vi.fn(),
  models: vi.fn(() => "models"),
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
    "setup:check-cancel",
    "setup:models",
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
  expect(invoke("setup:check", ["id-1", { kind: "rules" }, 5000])).toBe("checked");
  expect(setup.check).toHaveBeenCalledWith("id-1", { kind: "rules" }, 5000, expect.any(Function));
  expect(contents.send).toHaveBeenCalledWith("setup:check-progress", "id-1", {
    kind: "stream",
    thinking: 1,
    reply: "{",
  });
  // Progress never goes to another document or a destroyed window.
  frame.url = "https://example.com/";
  setup.check.mock.calls[0]?.[3]({ kind: "stream", thinking: 2, reply: "" });
  frame.url = "app://bundle/index.html";
  contents.isDestroyed.mockReturnValueOnce(true);
  setup.check.mock.calls[0]?.[3]({ kind: "stream", thinking: 3, reply: "" });
  expect(contents.send).toHaveBeenCalledOnce();
  for (const id of [7, "", "has space", "x".repeat(65)])
    expect(() => invoke("setup:check", [id, { kind: "rules" }, 5000])).toThrow("Invalid check ID");
  invoke("setup:check-cancel", ["id-1"]);
  invoke("setup:check-cancel", [7]);
  expect(setup.cancel).toHaveBeenCalledExactlyOnceWith("id-1");
  expect(invoke("setup:models", ["http://127.0.0.1:11434/v1"])).toBe("models");
  expect(mock.handle.mock.calls.some(([name]) => /get-key|read-key/.test(name))).toBe(false);
});

test("dispose removes every handler", () => {
  dispose();
  expect(mock.removeHandler.mock.calls.map(([name]: unknown[]) => name)).toEqual(
    mock.handle.mock.calls.map(([name]) => name),
  );
});
