import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SerializeAddon } from "@xterm/addon-serialize";
import type { TerminalTelemetry, TerminalSpec } from "../../../../src/shared/desktop";
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
vi.mock("../../../../src/main/terminals/terminal-host-client", async () => {
  const { TerminalManager } = await import("../../../../src/terminal-host/terminal-manager");
  return {
    TerminalHostClient: class {
      private manager: TerminalManager;
      constructor(onExit: (id: string, code: number) => void, events: TerminalTelemetry) {
        this.manager = new TerminalManager(onExit, events);
      }
      create(spec: TerminalSpec) {
        return this.manager.create(spec);
      }
      attach(id: string, send: (token: string, data: string) => void) {
        return this.manager.attach(id, send);
      }
      tail(id: string, lines: number) {
        return this.manager.tail(id, lines);
      }
      detach(id: string) {
        this.manager.detach(id);
      }
      write(id: string, data: string) {
        this.manager.write(id, data);
      }
      resize(id: string, cols: number, rows: number) {
        this.manager.resize(id, cols, rows);
      }
      acknowledge(id: string, token: string, count: number) {
        this.manager.acknowledge(id, token, count);
      }
      stop(id: string) {
        return this.manager.stop(id);
      }
      kill(id: string) {
        this.manager.kill(id);
      }
      get runningCount() {
        return this.manager.runningCount;
      }
      get hasPendingExits() {
        return this.manager.hasPendingExits;
      }
      shutdown() {
        return this.manager.shutdown();
      }
      waitForExit() {
        return this.manager.waitForExit();
      }
      dispose() {
        this.manager.dispose();
        return Promise.resolve();
      }
    },
  };
});
import { attachTerminal } from "../../../../src/main/terminals/terminal-ipc";
import { TerminalManager } from "../../../../src/terminal-host/terminal-manager";
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
      .fn<(callback: (data: string) => void) => { dispose: () => void }>()
      .mockReturnValue({ dispose: vi.fn() }),
    onExit: vi
      .fn<(callback: (event: { exitCode: number }) => void) => { dispose: () => void }>()
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
  isCrashed: vi.fn(() => false),
  isDestroyed: () => false,
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
async function create() {
  const result = await invoke("create", [80, 24]);
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
let terminalControl: ReturnType<typeof attachTerminal>;
const exited = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  ptys = [];
  mock.app.isPackaged = false;
  contents.send.mockImplementation((channel: string, ids: unknown, token: unknown) => {
    if (channel === "terminal:flush-views") send("views-flushed", [ids, token]);
  });
  mock.spawn.mockImplementation(() => {
    const next = fakePty();
    ptys.push(next);
    return next;
  });
  terminalControl = attachTerminal(window as unknown as BrowserWindow);
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
  expect(pty().pause).toHaveBeenCalledOnce();
  expect(pty().resume).toHaveBeenCalledOnce();
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
  const id = await create();
  const second = await create();
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
  const id = await create();
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
    await expect(invoke("create", pair)).rejects.toThrow("Invalid terminal size");
    send("resize", [id, ...pair]);
  }
  for (const sender of [
    { sender: {}, senderFrame: frame },
    { sender: contents, senderFrame: null },
    { sender: contents, senderFrame: { url: frame.url } },
  ]) {
    const invalid = sender as unknown as typeof event;
    await expect(invoke("create", [80, 24], invalid)).rejects.toThrow("Untrusted IPC sender");
    for (const op of ["attach", "detach", "kill"])
      await expect(invoke(op, [id], invalid)).rejects.toThrow("Untrusted IPC sender");
    send("input", [id, "bad"], invalid);
    send("resize", [id, 80, 24], invalid);
    send("ack", [id, "view", 1], invalid);
  }
  frame.url = "https://evil.example";
  await expect(create()).rejects.toThrow("Untrusted IPC sender");
  frame.url = "app://bundle/index.html";
  expect(pty().write).not.toHaveBeenCalled();
  expect(pty().resize).not.toHaveBeenCalled();
});

test.each(["win32", "linux"])(
  "selects the %s shell, scrubs environment and retries spawn failure",
  async (platform) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform as NodeJS.Platform);
    vi.stubEnv("SHELL", "");
    vi.stubEnv("npm_secret", "secret");
    vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
    vi.stubEnv("FOOM_KEEP", "yes");
    mock.app.isPackaged = true;
    mock.spawn.mockImplementationOnce(() => {
      throw new Error("missing shell");
    });
    await expect(create()).rejects.toThrow("missing shell");
    await create();
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
  const id = await create();
  await invoke("attach", [id]);
  output("x".repeat(270000));
  await vi.waitFor(() => {
    expect(pty().pause).toHaveBeenCalledOnce();
  });
  contents.on.mock.calls.find(([name]) => name === "render-process-gone")?.[1]();
  await vi.waitFor(() => {
    expect(pty().resume).toHaveBeenCalledOnce();
  });
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

test("window shutdown disposes sessions without accessing the destroyed window", async () => {
  await create();
  vi.spyOn(window, "webContents", "get").mockImplementation(() => {
    throw new Error("Object has been destroyed");
  });
  expect(() => window.once.mock.calls[0]?.[1]()).not.toThrow();
  expect(pty().kill).toHaveBeenCalledOnce();
  expect(contents.removeListener).toHaveBeenCalledWith("render-process-gone", expect.any(Function));
  expect(mock.removeHandler).toHaveBeenCalledWith("terminal:create");
});

test("snapshot failure rejects attachment without leaving a partial live view", async () => {
  const id = manager.create(spec);
  const data = vi.fn();
  const serialize = vi.spyOn(SerializeAddon.prototype, "serialize").mockImplementationOnce(() => {
    throw new Error("Incompatible snapshot");
  });
  await expect(manager.attach(id, data)).rejects.toThrow("Unable to snapshot terminal");
  output("still running");
  expect(await manager.tail(id, 1)).toEqual(["still running"]);
  expect(data).not.toHaveBeenCalled();
  serialize.mockRestore();
  await manager.attach(id, data);
  expect(data).toHaveBeenCalledOnce();
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

test("detaching cannot bypass parser backpressure, and a drained parser cannot bypass view backpressure", async () => {
  const id = manager.create(spec);
  await manager.attach(id, vi.fn());
  output("x".repeat(270000));
  manager.detach(id);
  expect(pty().pause).toHaveBeenCalledOnce();
  expect(pty().resume).not.toHaveBeenCalled();
  await manager.tail(id, 1);
  expect(pty().resume).toHaveBeenCalledOnce();
  const send = vi.fn();
  await manager.attach(id, send);
  output("y".repeat(270000));
  await manager.tail(id, 1);
  expect(pty().pause).toHaveBeenCalledTimes(2);
  expect(pty().resume).toHaveBeenCalledOnce();
  manager.detach(id);
  expect(pty().resume).toHaveBeenCalledTimes(2);
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
  const id = await create();
  await create();
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
    await create();
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

function exitPty(index = 0) {
  pty(index).emitExit();
}

test("shutdown counts only live PTYs and waits for all exits before disposal", async () => {
  const first = manager.create(spec);
  manager.create(spec);
  manager.create(spec);
  expect(manager.runningCount).toBe(3);
  exitPty(2);
  expect(manager.runningCount).toBe(2);
  await manager.attach(first, vi.fn());
  output("x".repeat(270000));
  await manager.tail(first, 1);
  for (const terminal of ptys) terminal.kill.mockImplementation(() => {});
  const stopped = vi.fn();
  const shutdown = manager.shutdown().then(stopped);
  expect(() => manager.create(spec)).toThrow("shutting down");
  expect(pty().resume).toHaveBeenCalledOnce();
  expect(pty().kill).toHaveBeenCalledOnce();
  expect(pty(1).kill).toHaveBeenCalledOnce();
  expect(pty(2).kill).not.toHaveBeenCalled();
  output("x".repeat(270000));
  await manager.tail(first, 1);
  expect(pty().pause).toHaveBeenCalledOnce();
  exitPty();
  await Promise.resolve();
  expect(stopped).not.toHaveBeenCalled();
  exitPty(1);
  await shutdown;
  expect(manager.runningCount).toBe(0);
  expect(() => {
    manager.write(first, "stale");
  }).toThrow("Unknown terminal ID");
});

test.each(["linux", "win32"] as const)(
  "shutdown escalation respects %s signal support",
  async (platform) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    vi.useFakeTimers();
    try {
      manager.create(spec);
      pty().kill.mockImplementation(() => {});
      const shutdown = manager.shutdown();
      await vi.advanceTimersByTimeAsync(1000);
      if (platform === "win32") expect(pty().kill).toHaveBeenCalledExactlyOnceWith();
      else expect(pty().kill).toHaveBeenLastCalledWith("SIGKILL");
      exitPty();
      await shutdown;
      const subscription = pty().onExit.mock.results[1];
      if (subscription?.type !== "return") throw new Error("Missing exit subscription");
      expect(subscription.value.dispose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  },
);

test.each(["graceful", "force", "timeout"])(
  "shutdown reports %s failure and can be retried",
  async (failure) => {
    vi.useFakeTimers();
    try {
      const id = manager.create(spec);
      pty().kill.mockImplementation(() => {});
      const error = new Error("kill failed");
      if (failure === "graceful")
        pty().kill.mockImplementationOnce(() => {
          throw error;
        });
      if (failure === "force")
        pty()
          .kill.mockImplementationOnce(() => {})
          .mockImplementationOnce(() => {
            throw error;
          });
      const shutdown = manager.shutdown();
      const rejected = expect(shutdown).rejects.toThrow(
        failure === "timeout" ? "did not exit" : "Unable to stop terminal",
      );
      await vi.advanceTimersByTimeAsync(5000);
      await rejected;
      const subscription = pty().onExit.mock.results[1];
      if (subscription?.type !== "return") throw new Error("Missing exit subscription");
      expect(subscription.value.dispose).toHaveBeenCalledOnce();
      expect(manager.runningCount).toBe(1);
      manager.write(id, "still usable");
      expect(pty().write).toHaveBeenCalledWith("still usable");
      manager.create(spec);
      const retry = manager.shutdown();
      exitPty();
      exitPty(1);
      await retry;
      expect(manager.runningCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  },
);

test("confirmed shutdown waits for a previously removed PTY before completing", async () => {
  const removed = manager.create(spec);
  pty().kill.mockImplementation(() => {});
  manager.kill(removed);
  expect(manager.runningCount).toBe(0);
  const stopped = vi.fn();
  const shutdown = manager.shutdown().then(stopped);
  await Promise.resolve();
  expect(stopped).not.toHaveBeenCalled();
  expect(manager.hasPendingExits).toBe(true);
  pty().emitExit();
  await shutdown;
  expect(stopped).toHaveBeenCalledOnce();
  expect(manager.hasPendingExits).toBe(false);
});

test("confirmed shutdown can retry when a removed PTY's exit times out", async () => {
  vi.useFakeTimers();
  try {
    const removed = manager.create(spec);
    pty().kill.mockImplementation(() => {});
    manager.kill(removed);
    const shutdown = manager.shutdown();
    const rejected = expect(shutdown).rejects.toThrow("did not exit");
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    pty().emitExit();
    await manager.shutdown();
    expect(manager.hasPendingExits).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("shutdown revokes terminal IPC capabilities before late renderer events", async () => {
  const id = await create();
  expect(terminalControl.runningCount).toBe(1);
  await invoke("attach", [id]);
  await terminalControl.shutdown();
  expect(terminalControl.runningCount).toBe(0);
  expect(() => {
    send("ack", [id, "old-attachment", 1]);
    send("input", [id, "late input"]);
    send("resize", [id, 80, 24]);
    contents.on.mock.calls.find(([name]) => name === "render-process-gone")?.[1]();
  }).not.toThrow();
  for (const operation of ["attach", "detach", "kill"]) {
    await expect(invoke(operation, [id])).rejects.toThrow("Unknown or foreign terminal ID");
  }
});

test("theme updates reset host overrides, synchronize snapshots, and ignore removed sessions", async () => {
  const id = manager.create(spec);
  output("\x1b]11;#123456\x07");
  await manager.tail(id, 1);
  manager.setTheme(id, true);
  output("\x1b]11;?\x07");
  await manager.tail(id, 1);
  expect(pty().write).toHaveBeenLastCalledWith("\x1b]11;rgb:0505/0404/0a0a\x1b\\");
  const data = vi.fn();
  await manager.attach(id, data);
  expect(data.mock.calls[0]?.[1]).toContain("#f4efff;#05040a;#9b6bff");
  manager.setTheme(id, false);
  await manager.tail(id, 1);
  expect(data.mock.calls.at(-1)?.[1]).toContain("#14101f;#f3f0fa;#5b2bd9");
  manager.setTheme(id, true);
  manager.kill(id);
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  expect(() => {
    manager.setTheme(id, false);
  }).toThrow("Unknown terminal");
});

test("removed ConPTYs are drained without closing their native handle twice", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.useFakeTimers();
  try {
    const id = manager.create(spec);
    pty().kill.mockImplementation(() => {});
    manager.kill(id);
    const shutdown = manager.shutdown();
    const rejected = expect(shutdown).rejects.toThrow("did not exit");
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(pty().kill).toHaveBeenCalledExactlyOnceWith();
    const retry = manager.shutdown();
    expect(pty().kill).toHaveBeenCalledExactlyOnceWith();
    pty().emitExit();
    await retry;
    expect(manager.hasPendingExits).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("a failed ConPTY termination request stays retryable after removal", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const id = manager.create(spec);
  pty().kill.mockImplementationOnce(() => {
    throw new Error("close failed");
  });
  expect(() => {
    manager.kill(id);
  }).toThrow("close failed");
  expect(manager.hasPendingExits).toBe(true);
  await manager.shutdown();
  expect(pty().kill).toHaveBeenCalledTimes(2);
  expect(manager.hasPendingExits).toBe(false);
});

test("tail IPC checks ownership, sender and bounds before returning parsed plain text", async () => {
  const id = await create();
  output("\x1b[31mhello\x1b[0m\r\nContinue?");
  await expect(invoke("tail", [id, 2])).resolves.toEqual(["hello", "Continue?"]);
  await expect(invoke("tail", ["foreign", 1])).rejects.toThrow("foreign");
  await expect(invoke("tail", [id, 1], { ...event, senderFrame: null })).rejects.toThrow(
    "Untrusted",
  );
  for (const lines of [null, 0, 10001, 1.5])
    await expect(invoke("tail", [id, lines])).rejects.toThrow("tail length");
});

test("detached terminals emit activity, but navigation, foreign IDs and destroyed contents cannot receive it", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  const destroyed = vi.spyOn(contents, "isDestroyed");
  try {
    const id = await create();
    output("Continue?");
    await invoke("tail", [id, 1]);
    vi.advanceTimersByTime(100);
    expect(contents.send).toHaveBeenCalledWith("terminal:activity", [
      expect.objectContaining({ id }),
    ]);
    contents.send.mockClear();
    frame.url = "https://example.com";
    vi.advanceTimersByTime(100);
    expect(contents.send).not.toHaveBeenCalled();
    frame.url = "app://bundle/index.html";
    destroyed.mockReturnValue(true);
    vi.advanceTimersByTime(100);
    expect(contents.send).not.toHaveBeenCalled();
  } finally {
    frame.url = "app://bundle/index.html";
    destroyed.mockRestore();
    for (const terminal of ptys) terminal.emitExit();
    vi.useRealTimers();
  }
});

test("quiet detection reads parsed headless tails and stops on exit without an attached view", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  const quiet = vi.fn();
  manager.dispose();
  manager = new TerminalManager(exited, { onQuiet: quiet });
  try {
    const id = manager.create(spec);
    output("\x1b[31mContinue?\x1b[0m");
    await manager.tail(id, 1);
    vi.advanceTimersByTime(500);
    expect(quiet).toHaveBeenCalledWith(id);
    output("again?");
    pty().emitExit();
    await manager.tail(id, 1);
    vi.advanceTimersByTime(3000);
    expect(quiet).toHaveBeenCalledTimes(1);
  } finally {
    manager.dispose();
    vi.useRealTimers();
  }
});

test("reports quiet, input, exit and removal for owned terminals and grants main launches", async () => {
  {
    const events = {
      onOutput: vi.fn(),
      onQuiet: vi.fn(),
      onExit: vi.fn(),
      onInput: vi.fn(),
      onRemoved: vi.fn(),
    };
    const handles = mock.handle.mock.calls.length;
    const listeners = mock.on.mock.calls.length;
    const control = attachTerminal(window as unknown as BrowserWindow, events);
    const latest = (channel: string) =>
      mock.handle.mock.calls.slice(handles).find(([name]) => name === `terminal:${channel}`)?.[1];
    const latestSend = (channel: string) =>
      mock.on.mock.calls.slice(listeners).find(([name]) => name === `terminal:${channel}`)?.[1];

    const id = await control.create({ ...spec, env: { FOOM_TOKEN: "t" } });
    expect(control.owns(id)).toBe(true);
    expect(control.owns("other")).toBe(false);
    const index = ptys.length - 1;
    output("Continue? (y/n) ", index);
    expect(events.onOutput).toHaveBeenCalledWith(id);
    await expect(control.tail(id, 1)).resolves.toEqual(["Continue? (y/n) "]);
    // A trailing y/n prompt goes quiet after 500 ms of silence.
    await vi.waitFor(
      () => {
        expect(events.onQuiet).toHaveBeenCalledWith(id);
      },
      { timeout: 3000 },
    );

    // Focus reports reach the PTY but aren't a reply.
    latestSend("input")?.(event, id, "\x1b[O");
    expect(pty(index).write).toHaveBeenCalledWith("\x1b[O");
    expect(events.onInput).not.toHaveBeenCalled();
    latestSend("input")?.(event, id, "\x1b[B", "wheel");
    expect(pty(index).write).toHaveBeenCalledWith("\x1b[B");
    expect(events.onInput).not.toHaveBeenCalled();
    const writes = pty(index).write.mock.calls.length;
    latestSend("input")?.(event, id, "x", "invalid");
    latestSend("input")?.(event, "foreign", "\x1b[B", "wheel");
    expect(pty(index).write).toHaveBeenCalledTimes(writes);
    latestSend("input")?.(event, id, "\x1b[B");
    latestSend("input")?.(event, "foreign", "y");
    expect(events.onInput).toHaveBeenCalledExactlyOnceWith(id);

    pty(index).emitExit();
    await vi.waitFor(() => {
      expect(events.onExit).toHaveBeenCalledWith(id, 0);
    });
    await latest("kill")?.(event, id);
    expect(events.onRemoved).toHaveBeenCalledWith(id);
    expect(control.owns(id)).toBe(false);
    expect(window.webContents.send).toHaveBeenCalledWith("terminal:availability", [id], false);
    const internalId = await control.create(spec);
    await control.kill(internalId);
    expect(control.owns(internalId)).toBe(false);
    expect(events.onRemoved).not.toHaveBeenCalledWith(internalId);
    window.once.mock.calls.at(-1)?.[1]();
  }
});

test("stopping waits for native exit and retains an owned readable terminal", async () => {
  const id = await terminalControl.create(spec);
  const index = ptys.length - 1;
  output("preserved screen", index);
  pty(index).kill.mockImplementation(() => {});
  const stopped = vi.fn();
  const stopping = terminalControl.stop(id).then(stopped);
  await Promise.resolve();
  expect(stopped).not.toHaveBeenCalled();
  expect(terminalControl.owns(id)).toBe(true);
  exitPty(index);
  await stopping;
  expect(await terminalControl.tail(id, 1)).toEqual(["preserved screen"]);
  await terminalControl.stop(id);
  expect(pty(index).kill).toHaveBeenCalledOnce();
});

test("a detached host answers foreground, background and palette queries with the chosen theme", async () => {
  const { terminalThemes } = await import("../../../../src/shared/terminal-themes");
  const id = manager.create(spec, "theme-test", terminalThemes.dracula);
  output("\x1b]10;?\x07\x1b]11;?\x07\x1b]4;1;?\x07");
  await manager.tail(id, 1);
  expect(pty().write.mock.calls.slice(-3)).toEqual([
    ["\x1b]10;rgb:f8f8/f8f8/f2f2\x1b\\"],
    ["\x1b]11;rgb:2828/2a2a/3636\x1b\\"],
    ["\x1b]4;1;rgb:ffff/5555/5555\x1b\\"],
  ]);
  manager.setTheme(id, terminalThemes["solarized-light"]);
  output("\x1b]11;?\x07");
  await manager.tail(id, 1);
  expect(pty().write).toHaveBeenLastCalledWith("\x1b]11;rgb:fdfd/f6f6/e3e3\x1b\\");
  const data = vi.fn();
  await manager.attach(id, data);
  expect(data.mock.calls[0]?.[1]).toContain("#657b83;#fdf6e3;#586e75");
});

test("owned Bash lifecycle markers cross the terminal bridge; arbitrary OSC payloads do not", async () => {
  const onShellState = vi.fn();
  terminalControl = attachTerminal(window as unknown as BrowserWindow, { onShellState });
  const id = await terminalControl.create({ ...spec, shellIntegration: true });
  const args: unknown = mock.spawn.mock.calls.at(-1)?.[1];
  if (!Array.isArray(args) || typeof args[1] !== "string")
    throw new Error("Missing Bash startup file");
  const { readFileSync } = await import("node:fs");
  const token = /633;([a-f0-9-]+);prompt/.exec(readFileSync(args[1], "utf8"))?.[1];
  if (!token) throw new Error("Missing integration token");
  output(`\x1b]633;${token};running\x07`);
  await terminalControl.tail(id, 1);
  expect(onShellState).toHaveBeenCalledWith(id, { phase: "running" });
  output("\x1b]633;foreign;running\x07");
  await terminalControl.tail(id, 1);
  expect(onShellState).toHaveBeenCalledTimes(1);
});

test("failed Bash spawn removes the private startup directory", () => {
  mock.spawn.mockImplementationOnce(() => {
    throw new Error("spawn failed");
  });
  expect(() => manager.create({ ...spec, shellIntegration: true })).toThrow("spawn failed");
});

test("tile hide, close and preset detach sequences leave every PTY consuming output", async () => {
  const first = await create();
  const second = await create();
  await invoke("attach", [first]);
  await invoke("attach", [second]);
  await invoke("detach", [first]);
  output("first hidden\r\n", 0);
  output("second visible\r\n", 1);
  await invoke("detach", [second]);
  await invoke("attach", [first]);
  await invoke("detach", [first]);
  output("first still running\r\n", 0);
  output("second still running\r\n", 1);
  expect(await invoke("tail", [first, 40])).toContain("first still running");
  expect(await invoke("tail", [second, 40])).toContain("second still running");
  for (const index of [0, 1]) {
    expect(pty(index).kill).not.toHaveBeenCalled();
    expect(pty(index).pause).not.toHaveBeenCalled();
  }
});

test("failed shutdown restores availability without revoking ownership", async () => {
  const id = await create();
  pty().kill.mockImplementationOnce(() => {
    throw new Error("kill refused");
  });
  await expect(terminalControl.shutdown()).rejects.toThrow("Unable to stop terminal");
  expect(contents.send).toHaveBeenCalledWith("terminal:availability", [id], false);
  expect(contents.send).toHaveBeenCalledWith("terminal:availability", [id], true);
  expect(terminalControl.owns(id)).toBe(true);
  await terminalControl.shutdown();
});

test("shutdown flush validates its sender and envelope before stopping native processes", async () => {
  const id = await create();
  contents.send.mockImplementation(() => {});
  const closing = terminalControl.shutdown();
  expect(contents.send).toHaveBeenCalledWith("terminal:flush-views", [id], 1);
  send("views-flushed", [[id], 1], { ...event, senderFrame: null });
  send("views-flushed", [[id], 2]);
  send("views-flushed", [null, 1]);
  send("views-flushed", [[], 1]);
  send("views-flushed", [["foreign"], 1]);
  expect(pty().kill).not.toHaveBeenCalled();
  send("views-flushed", [[id], 1]);
  await closing;
  expect(pty().kill).toHaveBeenCalledOnce();
  send("views-flushed", [[id], 1]);
});
test("an unresponsive renderer cannot block native shutdown indefinitely", async () => {
  vi.useFakeTimers();
  try {
    await create();
    contents.send.mockImplementation(() => {});
    const closing = terminalControl.shutdown();
    await vi.advanceTimersByTimeAsync(3000);
    await closing;
    expect(pty().kill).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

test("renderer loss releases an in-flight flush and a crashed board needs no acknowledgement", async () => {
  const first = await create();
  expect(terminalControl.runningSessions()).toEqual([expect.objectContaining({ id: first })]);
  contents.send.mockImplementation(() => {});
  const closing = terminalControl.shutdown();
  contents.on.mock.calls.find(([name]) => name === "render-process-gone")?.[1]();
  await closing;
  expect(terminalControl.runningSessions()).toEqual([]);
});
test("a crashed board is skipped until a completed reload", async () => {
  await create();
  contents.on.mock.calls.find(([name]) => name === "render-process-gone")?.[1]();
  contents.send.mockClear();
  await terminalControl.shutdown();
  expect(contents.send.mock.calls.some(([name]) => name === "terminal:flush-views")).toBe(false);
});
test("a reloaded board resumes the view acknowledgement protocol", async () => {
  await create();
  contents.on.mock.calls.find(([name]) => name === "render-process-gone")?.[1]();
  contents.on.mock.calls.find(([name]) => name === "did-finish-load")?.[1]();
  contents.send.mockImplementation((channel: string, ids: unknown, token: unknown) => {
    if (channel === "terminal:flush-views") send("views-flushed", [ids, token]);
  });
  await terminalControl.shutdown();
  expect(contents.send.mock.calls.some(([name]) => name === "terminal:flush-views")).toBe(true);
});

test("headless titles and progress reach main only after parsing, without a view", async () => {
  const onEvidence = vi.fn();
  terminalControl = attachTerminal(window as unknown as BrowserWindow, { onEvidence });
  const id = await terminalControl.create(spec);
  output("\x1b]0;⠋ codex\x07\x1b]9;4;1;50\x07screen");
  await terminalControl.tail(id, 1);
  expect(onEvidence).toHaveBeenLastCalledWith(id, {
    title: "⠋ codex",
    progress: { state: 1, value: 50 },
  });
  output("\x1b]2;Action Required\x07\x1b]9;4;0\x07");
  await terminalControl.tail(id, 1);
  expect(onEvidence).toHaveBeenLastCalledWith(id, {
    title: "Action Required",
    progress: { state: 0, value: null },
  });
  const count = onEvidence.mock.calls.length;
  output("\x1b]2;Action Required\x07\x1b]9;4;0\x07\x1b]9;garbage\x07");
  await terminalControl.tail(id, 1);
  expect(onEvidence).toHaveBeenCalledTimes(count);
  output("\x1b]9;4;1;60\x07");
  await terminalControl.tail(id, 1);
  expect(onEvidence).toHaveBeenLastCalledWith(id, {
    title: "Action Required",
    progress: { state: 1, value: 60 },
  });
  output("\x1b]9;4;1;61\x07");
  await terminalControl.tail(id, 1);
  expect(onEvidence).toHaveBeenLastCalledWith(id, {
    title: "Action Required",
    progress: { state: 1, value: 61 },
  });
});
