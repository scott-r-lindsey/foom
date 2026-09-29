import { afterEach, beforeEach, expect, test, vi } from "vitest";
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
  app: {
    isPackaged: false,
    on: vi.fn<(name: string, callback: (event: { preventDefault(): void }) => void) => void>(),
    removeListener: vi.fn(),
    quit: vi.fn(),
  },
  spawn: vi.fn(),
}));
vi.mock("electron", () => ({ app: mock.app, ipcMain: mock }));
vi.mock("node-pty", () => ({ spawn: mock.spawn }));
import { attachTerminal } from "../src/terminal";
import { TerminalManager } from "../src/terminal-manager";
function fakePty() {
  const exits = new Set<(event: { exitCode: number }) => void>();
  const emitExit = () => {
    for (const listener of exits) listener({ exitCode: 0 });
  };
  return {
    emitExit,
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(emitExit),
    onData: vi
      .fn<(callback: (data: string) => void) => { dispose(): void }>()
      .mockReturnValue({ dispose: vi.fn() }),
    onExit: vi
      .fn<(callback: (event: { exitCode: number }) => void) => { dispose(): void }>()
      .mockImplementation((callback) => {
        exits.add(callback);
        return {
          dispose: vi.fn(() => {
            exits.delete(callback);
          }),
        };
      }),
  };
}
let ptys: ReturnType<typeof fakePty>[];
const frame = { url: "app://bundle/index.html" };
const contents = {
  mainFrame: frame,
  send: vi.fn(),
  on: vi.fn<(name: string, callback: (...args: never[]) => void) => void>(),
  removeListener: vi.fn(),
};
const window = {
  get webContents() {
    return contents;
  },
  once: vi.fn<(name: string, callback: () => void) => void>(),
};
// Minimal platform fixtures exercise identity checks without a display.
const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent &
  IpcMainEvent;
function invoke(channel: string, args: unknown[] = [], sender = event) {
  const handler = mock.handle.mock.calls.find(([name]) => name === `terminal:${channel}`)?.[1];
  if (!handler) throw new Error("Missing handler");
  return handler(sender, ...args);
}
function send(channel: string, args: unknown[], sender = event) {
  mock.on.mock.calls.find(([name]) => name === `terminal:${channel}`)?.[1](sender, ...args);
}
function create() {
  const result = invoke("create", [80, 24]);
  if (typeof result !== "object" || !result || !("id" in result) || typeof result.id !== "string")
    throw new Error("Missing ID");
  return result.id;
}
function pty(index = 0) {
  const value = ptys[index];
  if (!value) throw new Error("Missing PTY");
  return value;
}
function output(data: string, index = 0) {
  pty(index).onData.mock.calls[0]?.[0](data);
}
const spec = { command: "/bin/bash", args: ["-l"], cwd: "/tmp", cols: 80, rows: 24 };
let manager: TerminalManager;
const exited = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  ptys = [];
  mock.app.isPackaged = false;
  mock.spawn.mockImplementation(() => {
    const next = fakePty();
    ptys.push(next);
    return next;
  });
  attachTerminal(window as unknown as BrowserWindow);
  manager = new TerminalManager(exited);
});
afterEach(async () => {
  for (const terminal of ptys) terminal.emitExit();
  manager.dispose();
  window.once.mock.calls[0]?.[1]();
  await manager.waitForExit();
  vi.unstubAllEnvs();
});

test("passes main-owned launch environment additions to the PTY", () => {
  manager.create({
    ...spec,
    env: { PATH: "/login/bin", FOOM_SESSION: "launch", FOOM_TOKEN: "token" },
  });
  const options: unknown = mock.spawn.mock.calls[0]?.[2];
  if (typeof options !== "object" || !options || !("env" in options))
    throw new Error("Missing environment");
  expect(options.env).toMatchObject({
    PATH: "/login/bin",
    FOOM_SESSION: "launch",
    FOOM_TOKEN: "token",
    TERM_PROGRAM: "Foom",
  });
});

test("detached output continuously updates real headless screen and scrollback", async () => {
  const id = manager.create(spec);
  for (let i = 0; i < 5000; i++) output(`line ${String(i)} ${"x".repeat(60)}\r\n`);
  expect((await manager.tail(id, 3)).join("\n")).toContain("line 4999");
  expect(pty().pause).not.toHaveBeenCalled();
  const data = vi.fn();
  await manager.attach(id, data);
  expect(data.mock.calls[0]?.[1]).toContain("line 4999");
  output("live");
  await manager.tail(id, 1);
  expect(data).toHaveBeenLastCalledWith(expect.any(String), "live");
  manager.resize(id, 100, 30);
  manager.write(id, "hello");
  expect(pty().resize).toHaveBeenCalledWith(100, 30);
  expect(pty().write).toHaveBeenCalledWith("hello");
});

test("backpressure only affects attached views and old view acknowledgements are ignored", async () => {
  const id = manager.create(spec);
  const data = vi.fn();
  await manager.attach(id, data);
  const token: unknown = data.mock.calls[0]?.[0];
  if (typeof token !== "string") throw new Error("Missing token");
  output("x".repeat(270000));
  await manager.tail(id, 1);
  expect(pty().pause).toHaveBeenCalledOnce();
  for (const count of [0, -1, 1.2, Infinity, 999999]) manager.acknowledge(id, token, count);
  manager.acknowledge(id, "foreign", 270000);
  expect(pty().resume).not.toHaveBeenCalled();
  manager.acknowledge(id, token, 1);
  expect(pty().resume).not.toHaveBeenCalled();
  manager.acknowledge(id, token, 269999);
  expect(pty().resume).toHaveBeenCalledOnce();
  output("y".repeat(270000));
  await manager.tail(id, 1);
  manager.detach(id);
  expect(pty().resume).toHaveBeenCalledTimes(2);
  manager.acknowledge(id, token, 1);
  const next = vi.fn();
  await manager.attach(id, next);
  const nextToken: unknown = next.mock.calls[0]?.[0];
  expect(nextToken).not.toBe(token);
  manager.acknowledge(id, token, 270000);
  expect(pty().resume).toHaveBeenCalledTimes(2);
});

test("independent terminals retain final output and exit state until killed", async () => {
  const first = manager.create(spec);
  const second = manager.create(spec);
  output("first");
  output("second", 1);
  expect(await manager.tail(first, 1)).toEqual(["first"]);
  expect(await manager.tail(second, 1)).toEqual(["second"]);
  manager.write(second, "input");
  expect(pty().write).not.toHaveBeenCalled();
  pty().onExit.mock.calls[0]?.[0]({ exitCode: 3 });
  await manager.tail(first, 1);
  expect(exited).toHaveBeenCalledWith(first, 3);
  manager.write(first, "ignored");
  manager.resize(first, 90, 25);
  expect(pty().write).not.toHaveBeenCalled();
  expect(pty().resize).not.toHaveBeenCalled();
  await manager.attach(first, vi.fn());
  manager.kill(first);
  expect(pty().kill).not.toHaveBeenCalled();
  expect(() => {
    manager.write(first, "stale");
  }).toThrow("Unknown terminal ID");
  expect(await manager.tail(second, 1)).toEqual(["second"]);
});

test("cancels in-flight attachments and safely drains callbacks on kill", async () => {
  const id = manager.create(spec);
  const data = vi.fn();
  output("queued");
  const attaching = manager.attach(id, data);
  manager.detach(id);
  await attaching;
  expect(data).not.toHaveBeenCalled();
  output("last");
  pty().onExit.mock.calls[0]?.[0]({ exitCode: 0 });
  const pending = manager.attach(id, data);
  manager.kill(id);
  await pending;
  expect(exited).not.toHaveBeenCalled();
  expect(data).not.toHaveBeenCalled();
  for (const lines of [0, -1, 10001, 1.2])
    await expect(manager.tail(id, lines)).rejects.toThrow("Invalid tail length");
});

test("IPC isolates IDs, validates input and cleans up", async () => {
  const id = create();
  const second = create();
  expect(id).not.toBe(second);
  await invoke("attach", [id]);
  output("hello");
  await vi.waitFor(() => {
    expect(contents.send).toHaveBeenCalledWith("terminal:data", id, expect.any(String), "hello");
  });
  send("input", [id, "ls\r"]);
  send("resize", [id, 100, 30]);
  expect(pty().write).toHaveBeenCalledWith("ls\r");
  expect(pty().resize).toHaveBeenCalledWith(100, 30);
  const token: unknown = contents.send.mock.calls[0]?.[2];
  send("ack", [id, token, 5]);
  send("ack", [id, null, 5]);
  send("ack", [id, token, null]);
  send("input", [id, null]);
  send("input", [id, "x".repeat(65537)]);
  for (const invalid of [null, "unknown", second + "foreign"]) {
    for (const op of ["attach", "detach", "kill"])
      await expect(invoke(op, [invalid])).rejects.toThrow("Unknown or foreign");
    send("input", [invalid, "bad"]);
    send("resize", [invalid, 80, 24]);
    send("ack", [invalid, "view", 1]);
  }
  expect(pty().write).toHaveBeenCalledOnce();
  await invoke("detach", [id]);
  await invoke("kill", [id]);
  send("input", [id, "stale"]);
  expect(pty().kill).toHaveBeenCalledOnce();
  pty(1).onExit.mock.calls[0]?.[0]({ exitCode: 2 });
  await vi.waitFor(() => {
    expect(contents.send).toHaveBeenCalledWith("terminal:exit", second, 2);
  });
});

test("rejects malformed dimensions and untrusted frames on every channel", async () => {
  const id = create();
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
    expect(() => invoke("create", pair)).toThrow("Invalid terminal size");
    send("resize", [id, ...pair]);
  }
  for (const sender of [
    { sender: {}, senderFrame: frame },
    { sender: contents, senderFrame: null },
    { sender: contents, senderFrame: { url: frame.url } },
  ]) {
    const invalid = sender as unknown as typeof event;
    expect(() => invoke("create", [80, 24], invalid)).toThrow("Untrusted IPC sender");
    for (const op of ["attach", "detach", "kill"])
      await expect(invoke(op, [id], invalid)).rejects.toThrow("Untrusted IPC sender");
    send("input", [id, "bad"], invalid);
    send("resize", [id, 80, 24], invalid);
    send("ack", [id, "view", 1], invalid);
  }
  frame.url = "https://evil.example";
  expect(() => create()).toThrow("Untrusted IPC sender");
  frame.url = "app://bundle/index.html";
  expect(pty().write).not.toHaveBeenCalled();
  expect(pty().resize).not.toHaveBeenCalled();
});

test.each(["win32", "linux"])(
  "selects the %s shell, scrubs environment and retries spawn failure",
  (platform) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform as NodeJS.Platform);
    vi.stubEnv("SHELL", "");
    vi.stubEnv("npm_secret", "secret");
    vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
    vi.stubEnv("FOOM_KEEP", "yes");
    mock.app.isPackaged = true;
    mock.spawn.mockImplementationOnce(() => {
      throw new Error("missing shell");
    });
    expect(() => create()).toThrow("missing shell");
    create();
    expect(mock.spawn).toHaveBeenLastCalledWith(
      platform === "win32" ? "powershell.exe" : "/bin/bash",
      expect.any(Array),
      expect.objectContaining({
        useConptyDll: true,
      }),
    );
    const options: unknown = mock.spawn.mock.calls[1]?.[2];
    if (typeof options !== "object" || !options || !("env" in options))
      throw new Error("Missing environment");
    expect(options.env).toMatchObject({ FOOM_KEEP: "yes" });
    expect(options.env).not.toHaveProperty("npm_secret");
    expect(options.env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
  },
);

test("renderer loss detaches paused views without terminating the PTY", async () => {
  const id = create();
  await invoke("attach", [id]);
  output("x".repeat(270000));
  await vi.waitFor(() => {
    expect(pty().pause).toHaveBeenCalledOnce();
  });
  contents.on.mock.calls.find(([name]) => name === "render-process-gone")?.[1]();
  expect(pty().resume).toHaveBeenCalledOnce();
  expect(pty().kill).not.toHaveBeenCalled();
  await invoke("attach", [id]);
  const navigation = contents.on.mock.calls.find(([name]) => name === "did-start-navigation")?.[1];
  // Use Reflect to simulate Electron's native event signature on the minimal fixture.
  if (!navigation) throw new Error("Missing navigation listener");
  Reflect.apply(navigation, undefined, [{}, "app://bundle/index.html", false, false]);
  Reflect.apply(navigation, undefined, [{}, "app://bundle/index.html", false, true]);
  const foreign = manager.create(spec);
  await expect(invoke("attach", [foreign])).rejects.toThrow("Unknown or foreign");
});

test("window shutdown disposes sessions without accessing the destroyed window", () => {
  create();
  vi.spyOn(window, "webContents", "get").mockImplementation(() => {
    throw new Error("Object has been destroyed");
  });
  expect(() => window.once.mock.calls[0]?.[1]()).not.toThrow();
  expect(pty().kill).toHaveBeenCalledOnce();
  expect(contents.removeListener).toHaveBeenCalledWith("render-process-gone", expect.any(Function));
  expect(mock.removeHandler).toHaveBeenCalledWith("terminal:create");
});

test("alternate-screen snapshots restore fullscreen state and preserve the normal screen", async () => {
  const id = manager.create(spec);
  output("normal screen");
  output("\x1b[?1049h\x1b[Hfullscreen marker");
  expect(await manager.tail(id, 1)).toEqual(["fullscreen marker"]);
  const data = vi.fn();
  await manager.attach(id, data);
  expect(data.mock.calls[0]?.[1]).toContain("\x1b[?1049h");
  expect(data.mock.calls[0]?.[1]).toContain("fullscreen marker");
  output("\x1b[?1049l");
  expect(await manager.tail(id, 1)).toEqual(["normal screen"]);
});

test.each(["", "\x1b[?1049h"])(
  "tails include lower populated rows after cursor home (%j)",
  async (screen) => {
    const id = manager.create(spec);
    output(`${screen}\x1b[Hheader\x1b[20;1HProceed? (y/n)\x1b[H`);
    const tail = await manager.tail(id, 40);
    expect(tail).toHaveLength(20);
    expect(tail[0]).toBe("header");
    expect(tail[19]).toBe("Proceed? (y/n)");
    expect(await manager.tail(id, 1)).toEqual(["Proceed? (y/n)"]);
    expect(await manager.tail(id, 2)).toEqual(["", "Proceed? (y/n)"]);
  },
);

test("tails trim blank suffixes while preserving interior blank rows and scrollback", async () => {
  const id = manager.create(spec);
  expect(await manager.tail(id, 40)).toEqual([]);
  for (let i = 0; i < 50; i++) output(`line ${String(i)}\r\n`);
  output("\r\nlast\r\n   \r\n\x1b[H");
  expect(await manager.tail(id, 3)).toEqual(["line 49", "", "last"]);
  expect(await manager.tail(id, 100)).toHaveLength(52);
  output("\x1b[2J");
  expect((await manager.tail(id, 1))[0]).toMatch(/^line /);
});

test("main answers protocol queries through attachment transitions and ignores replies after exit", async () => {
  const id = manager.create(spec);
  for (const attached of [false, true, false, true]) {
    if (attached) await manager.attach(id, vi.fn());
    else manager.detach(id);
    pty().write.mockClear();
    output("\x1b[3;7H\x1b[6n");
    await manager.tail(id, 1);
    expect(pty().write.mock.calls).toEqual([["\x1b[3;7R"]]);
  }
  pty().onExit.mock.calls[0]?.[0]({ exitCode: 0 });
  pty().write.mockClear();
  output("\x1b[6n");
  await manager.tail(id, 1);
  expect(pty().write).not.toHaveBeenCalled();
});

test("tracks killed PTYs until their exit callbacks and bounds stalled shutdown", async () => {
  vi.useFakeTimers();
  try {
    const id = manager.create(spec);
    pty().kill.mockImplementation(() => {});
    manager.kill(id);
    expect(manager.hasPendingExits).toBe(true);
    const pending = manager.waitForExit();
    const rejected = expect(pending).rejects.toThrow("Terminal shutdown timed out");
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(manager.hasPendingExits).toBe(true);
    pty().emitExit();
    await manager.waitForExit();
    expect(manager.hasPendingExits).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(exited).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test("quit waits for native exits, including previously removed terminals, and deduplicates requests", async () => {
  const id = create();
  create();
  for (const terminal of ptys) terminal.kill.mockImplementation(() => {});
  await invoke("kill", [id]);
  const willQuit = mock.app.on.mock.calls.find(([name]) => name === "will-quit")?.[1];
  if (!willQuit) throw new Error("Missing quit barrier");
  const event = { preventDefault: vi.fn() };
  willQuit(event);
  willQuit(event);
  expect(event.preventDefault).toHaveBeenCalledTimes(2);
  expect(mock.app.quit).not.toHaveBeenCalled();
  for (const terminal of ptys) expect(terminal.kill).toHaveBeenCalledOnce();
  pty().emitExit();
  await Promise.resolve();
  expect(mock.app.quit).not.toHaveBeenCalled();
  pty(1).emitExit();
  await vi.waitFor(() => {
    expect(mock.app.quit).toHaveBeenCalledOnce();
  });
  expect(mock.app.removeListener).toHaveBeenCalledWith("will-quit", willQuit);
  willQuit(event);
  expect(event.preventDefault).toHaveBeenCalledTimes(2);
});

test("failed quit reports the timeout and allows a later request to retry", async () => {
  vi.useFakeTimers();
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    create();
    pty().kill.mockImplementation(() => {});
    const willQuit = mock.app.on.mock.calls.find(([name]) => name === "will-quit")?.[1];
    if (!willQuit) throw new Error("Missing quit barrier");
    const event = { preventDefault: vi.fn() };
    willQuit(event);
    // The closed-window cleanup must also preserve the quit barrier on failure.
    window.once.mock.calls[0]?.[1]();
    await vi.advanceTimersByTimeAsync(5000);
    expect(diagnostic).toHaveBeenCalledWith(
      "Unable to finish terminal shutdown:",
      expect.any(Error),
    );
    expect(mock.app.quit).not.toHaveBeenCalled();
    expect(mock.app.removeListener).not.toHaveBeenCalled();
    willQuit(event);
    pty().emitExit();
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.app.quit).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
