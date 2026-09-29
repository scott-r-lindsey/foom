import { beforeEach, expect, test, vi } from "vitest";
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from "electron";
const mock = vi.hoisted(() => ({
  handle:
    vi.fn<
      (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void
    >(),
  on: vi.fn<
    (channel: string, handler: (event: IpcMainEvent, ...args: unknown[]) => void) => void
  >(),
  removeHandler: vi.fn(),
  removeListener: vi.fn(),
  app: { isPackaged: false },
  pty: {
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn<(callback: (data: string) => void) => { dispose(): void }>(),
    onExit: vi.fn<(callback: (event: { exitCode: number }) => void) => { dispose(): void }>(),
  },
  spawn: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("electron", () => ({ app: mock.app, ipcMain: mock }));
vi.mock("node-pty", () => ({ spawn: mock.spawn }));
import { attachTerminal } from "../src/terminal";
const frame = { url: "app://bundle/index.html" };
const contents = { mainFrame: frame, send: vi.fn() };
const window = {
  webContents: contents,
  once: vi.fn<(name: string, callback: () => void) => void>(),
};
// Minimal Electron fixtures let us exercise sender identity and detached/subframe checks.
const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent &
  IpcMainEvent;
function start(cols: unknown = 80, rows: unknown = 24, sender = event) {
  const handler = mock.handle.mock.calls[0]?.[1];
  if (!handler) throw new Error("Missing start handler");
  return handler(sender, cols, rows);
}
function send(channel: string, args: unknown[], sender = event) {
  mock.on.mock.calls.find(([name]) => name === `terminal:${channel}`)?.[1](sender, ...args);
}
beforeEach(() => {
  vi.clearAllMocks();
  mock.app.isPackaged = false;
  mock.spawn.mockReturnValue(mock.pty);
  mock.pty.onData.mockReturnValue({ dispose: mock.dispose });
  mock.pty.onExit.mockReturnValue({ dispose: mock.dispose });
  attachTerminal(window as unknown as BrowserWindow);
});
test("starts a shell, delivers output, applies backpressure and reports exit", () => {
  expect(start()).toEqual(expect.any(String));
  const output = mock.pty.onData.mock.calls[0]?.[0];
  output?.("x".repeat(262145));
  expect(mock.pty.pause).toHaveBeenCalledOnce();
  expect(contents.send).toHaveBeenCalledWith("terminal:data", "x".repeat(262145));
  send("ack", [1]);
  expect(mock.pty.resume).not.toHaveBeenCalled();
  send("ack", [262144]);
  expect(mock.pty.resume).toHaveBeenCalledOnce();
  send("input", ["ls\r"]);
  send("resize", [100, 30]);
  expect(mock.pty.write).toHaveBeenCalledWith("ls\r");
  expect(mock.pty.resize).toHaveBeenCalledWith(100, 30);
  mock.pty.onExit.mock.calls[0]?.[0]({ exitCode: 3 });
  expect(contents.send).toHaveBeenCalledWith("terminal:exit", 3);
  send("input", ["ignored"]);
  send("resize", [80, 24]);
  expect(mock.pty.write).toHaveBeenCalledOnce();
});
test("validates dimensions, input and acknowledgements", () => {
  for (const pair of [
    [null, 24],
    [80, "24"],
    [1, 24],
    [501, 24],
    [80, 1],
    [80, 301],
    [80.5, 24],
    [80, 24.5],
  ]) {
    expect(() => start(pair[0], pair[1])).toThrow("Invalid terminal size");
    send("resize", pair);
  }
  start();
  send("input", [null]);
  send("input", ["x".repeat(65537)]);
  for (const count of [null, -1, 0, 1.2, Infinity, 99]) send("ack", [count]);
  expect(mock.pty.write).not.toHaveBeenCalled();
  expect(mock.pty.resize).not.toHaveBeenCalled();
  expect(mock.pty.resume).not.toHaveBeenCalled();
});
test("rejects foreign senders, navigated pages, subframes and detached frames", () => {
  for (const sender of [
    { sender: {}, senderFrame: frame },
    { sender: contents, senderFrame: null },
    { sender: contents, senderFrame: { url: frame.url } },
    { sender: { mainFrame: frame }, senderFrame: frame },
  ]) {
    const invalid = sender as unknown as typeof event;
    expect(() => start(80, 24, invalid)).toThrow("Untrusted IPC sender");
    send("input", ["bad"], invalid);
    send("resize", [80, 24], invalid);
    send("ack", [1], invalid);
  }
  frame.url = "https://evil.example";
  expect(() => start()).toThrow("Untrusted IPC sender");
  frame.url = "app://bundle/index.html";
  expect(mock.spawn).not.toHaveBeenCalled();
});
test("cleans up on restart and close, including listeners", () => {
  start();
  start();
  expect(mock.pty.kill).toHaveBeenCalledOnce();
  window.once.mock.calls[0]?.[1]();
  expect(mock.pty.kill).toHaveBeenCalledTimes(2);
  expect(mock.dispose).toHaveBeenCalledTimes(4);
  expect(mock.removeHandler).toHaveBeenCalledWith("terminal:start");
  expect(mock.removeListener).toHaveBeenCalledTimes(3);
});
test.each(["win32", "linux"])(
  "selects a platform shell on %s and uses home for packaged app",
  (platform) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform as NodeJS.Platform);
    vi.stubEnv("SHELL", "");
    mock.app.isPackaged = true;
    start();
    expect(mock.spawn).toHaveBeenCalledWith(
      platform === "win32" ? "powershell.exe" : "/bin/bash",
      expect.any(Array),
      expect.objectContaining({ cols: 80, rows: 24, name: "xterm-256color" }),
    );
    vi.unstubAllEnvs();
  },
);
test("propagates spawn failures and can retry", () => {
  mock.spawn.mockImplementationOnce(() => {
    throw new Error("missing shell");
  });
  expect(() => start()).toThrow("missing shell");
  expect(() => start()).not.toThrow();
});
