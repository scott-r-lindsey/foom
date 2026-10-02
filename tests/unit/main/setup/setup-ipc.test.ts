import { beforeEach, expect, test, vi } from "vitest";
import type { BrowserWindow } from "electron";
import type { Setup } from "../../../../src/main/setup/setup";

const mock = vi.hoisted(() => ({
  handle:
    vi.fn<(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => void>(),
  removeHandler: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcMain: { handle: mock.handle, removeHandler: mock.removeHandler },
}));
import { attachSetup } from "../../../../src/main/setup/setup-ipc";

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
  codeSuggestions: vi.fn(() => "suggestions"),
  scanCode: vi.fn((_folder: unknown, onProgress: (progress: unknown) => void) => {
    onProgress({ folders: 1, repositories: 0 });
    return "scanned";
  }),
  applyRepositories: vi.fn(() => "applied"),
};
let attached: ReturnType<typeof attachSetup>;

beforeEach(() => {
  vi.clearAllMocks();
  attached = attachSetup(window, setup as unknown as Setup);
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
    "setup:code-suggestions",
    "setup:scan-code",
    "setup:apply-repositories",
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

test("passes payloads to Setup, which validates them, and never offers a key read", async () => {
  expect(invoke("setup:state")).toBe("state");
  await expect(invoke("setup:save", [{ hooks: false }])).resolves.toBe("saved");
  expect(setup.save).toHaveBeenCalledWith({ hooks: false });
  expect(contents.send).toHaveBeenCalledWith("setup:changed", "saved");
  contents.send.mockClear();
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
  expect(invoke("setup:code-suggestions")).toBe("suggestions");
  expect(invoke("setup:scan-code", ["s1", "/code"])).toBe("scanned");
  expect(setup.scanCode).toHaveBeenCalledWith("/code", expect.any(Function));
  expect(contents.send).toHaveBeenLastCalledWith("setup:scan-progress", "s1", {
    folders: 1,
    repositories: 0,
  });
  expect(() => invoke("setup:scan-code", ["bad id", "/code"])).toThrow("Invalid scan ID");
  await expect(invoke("setup:apply-repositories", [["/code/a"]])).resolves.toBe("applied");
  expect(contents.send).toHaveBeenLastCalledWith("workspace:changed");
  expect(setup.applyRepositories).toHaveBeenCalledWith(["/code/a"]);
  expect(mock.handle.mock.calls.some(([name]) => /get-key|read-key/.test(name))).toBe(false);
});

test("a zoom shortcut saves the next size and tells the renderer", async () => {
  const state = (interfaceScale: number) => ({ settings: { interfaceScale } });
  setup.state.mockReturnValue(state(100) as never);
  setup.save.mockReturnValue(state(110) as never);
  await attached.zoom("in");
  expect(setup.save).toHaveBeenCalledWith({ interfaceScale: 110 });
  expect(contents.send).toHaveBeenCalledWith("setup:changed", state(110));
  // At a limit nothing is saved; a destroyed window gets no message.
  setup.state.mockReturnValue(state(150) as never);
  await attached.zoom("in");
  expect(setup.save).toHaveBeenCalledOnce();
  setup.state.mockReturnValue(state(110) as never);
  contents.isDestroyed.mockReturnValueOnce(true);
  await attached.zoom("reset");
  expect(setup.save).toHaveBeenLastCalledWith({ interfaceScale: 100 });
  expect(contents.send).toHaveBeenCalledOnce();
});

test("a size change from the page anchors the window around the save, even a failed one", async () => {
  const pointerZoom = vi.fn();
  mock.handle.mockClear();
  attachSetup(window, setup as unknown as Setup, pointerZoom);
  setup.save.mockImplementationOnce(() => {
    expect(pointerZoom).toHaveBeenLastCalledWith(true);
    return "saved";
  });
  await expect(invoke("setup:save", [{ interfaceScale: 110 }])).resolves.toBe("saved");
  expect(pointerZoom.mock.calls).toEqual([[true], [false]]);
  setup.save.mockImplementationOnce(() => {
    throw new Error("Invalid settings");
  });
  await expect(invoke("setup:save", [{ interfaceScale: 7 }])).rejects.toThrow("Invalid settings");
  expect(pointerZoom).toHaveBeenLastCalledWith(false);
  // Other settings, and payloads that aren't objects, leave the window alone.
  pointerZoom.mockClear();
  await invoke("setup:save", [{ hooks: false }]);
  await invoke("setup:save", [null]);
  expect(pointerZoom).not.toHaveBeenCalled();
});

test("dispose removes every handler", () => {
  attached.dispose();
  expect(mock.removeHandler.mock.calls.map(([name]: unknown[]) => name)).toEqual(
    mock.handle.mock.calls.map(([name]) => name),
  );
});
