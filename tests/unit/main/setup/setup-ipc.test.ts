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
const contents = {
  on: vi.fn<(event: string, listener: (...args: unknown[]) => void) => void>(),
  removeListener: vi.fn(),
  mainFrame: frame,
  isDestroyed: vi.fn(() => false),
  send: vi.fn(),
  getZoomFactor: vi.fn(() => 1),
  setZoomFactor: vi.fn(),
};
const window = { webContents: contents } as unknown as BrowserWindow;
const trusted = { sender: contents, senderFrame: frame };
const setup = {
  cancelHostTrust: vi.fn(),
  localAgentInstall: vi.fn(() => "installer"),
  githubSignIn: vi.fn(() => "device-state"),
  copyHost: vi.fn(),
  hosts: vi.fn(() => "hosts"),
  repositoryRequirements: vi.fn(() => null),
  restartToUpdate: vi.fn(() => Promise.resolve()),
  readiness: vi.fn(() => "readiness"),
  state: vi.fn(() => ({ settings: { interfaceScale: 100 } })),
  save: vi.fn<(_patch?: unknown) => unknown>(() => "saved"),
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
  contents.getZoomFactor.mockReturnValue(1);
  setup.state.mockReturnValue({ settings: { interfaceScale: 100 } });
  setup.save.mockReturnValue({ settings: { interfaceScale: 100 } });
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
    "setup:terminal-fonts",
    "setup:readiness",
    "setup:copy-host",
    "setup:github-sign-in",
    "setup:state",
    "setup:local-agent-install",
    "setup:repository-requirements",
    "setup:hosts",
    "setup:restart-update",
    "setup:save",
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
  expect(invoke("setup:state")).toEqual({ settings: { interfaceScale: 100 } });
  await expect(invoke("setup:save", [{ hooks: false }])).resolves.toEqual({
    settings: { interfaceScale: 100 },
  });
  expect(setup.save).toHaveBeenCalledWith({ hooks: false });
  const digest = "a".repeat(64);
  await invoke("setup:save", [{ interfaceTheme: "user:custom.json" }, digest]);
  expect(setup.save).toHaveBeenCalledWith({ interfaceTheme: "user:custom.json" }, digest);
  expect(contents.send).toHaveBeenCalledWith("setup:changed", {
    settings: { interfaceScale: 100 },
  });
  contents.send.mockClear();
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
  setup.state.mockReturnValue(state(100));
  setup.save.mockReturnValue(state(110));
  await attached.zoom("in");
  expect(setup.save).toHaveBeenCalledWith({ interfaceScale: 110 });
  expect(contents.send).toHaveBeenCalledWith("setup:changed", state(110));
  // At a limit nothing is saved; a destroyed window gets no message.
  setup.state.mockReturnValue(state(300));
  contents.getZoomFactor.mockReturnValue(3);
  await attached.zoom("in");
  expect(setup.save).toHaveBeenCalledOnce();
  setup.state.mockReturnValue(state(110));
  contents.getZoomFactor.mockReturnValue(1.1);
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
    return { settings: { interfaceScale: 110 } };
  });
  await expect(invoke("setup:save", [{ interfaceScale: 110 }])).resolves.toEqual({
    settings: { interfaceScale: 110 },
  });
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

test("removed inference channels have no handlers", () => {
  for (const name of [
    "setup:set-key",
    "setup:remove-key",
    "setup:check",
    "setup:check-cancel",
    "setup:models",
  ])
    expect(mock.handle.mock.calls.some(([channel]) => channel === name)).toBe(false);
});

test("font enumeration accepts only an optional boolean refresh flag", async () => {
  expect(() => invoke("setup:terminal-fonts", ["injected"])).toThrow("Invalid font request");
  for (const args of [[true, false], [null], [{}], [0]])
    expect(() => invoke("setup:terminal-fonts", args)).toThrow("Invalid font request");
  expect(Array.isArray(await invoke("setup:terminal-fonts"))).toBe(true);
  expect(Array.isArray(await invoke("setup:terminal-fonts", [true]))).toBe(true);
  expect(Array.isArray(await invoke("setup:terminal-fonts", [false]))).toBe(true);
});

test("readiness accepts no payload and only the trusted frame", () => {
  expect(invoke("setup:readiness")).toBe("readiness");
  expect(() => invoke("setup:readiness", [{}])).toThrow("Invalid readiness request");
});

test("update restart validates arguments before entering the normal quit path", async () => {
  expect(() => invoke("setup:restart-update", [true])).toThrow("Invalid update request");
  await invoke("setup:restart-update");
  expect(setup.restartToUpdate).toHaveBeenCalledOnce();
});

test("host management requires one payload and the trusted setup sender", () => {
  expect(invoke("setup:hosts", [{ action: "list" }])).toBe("hosts");
  expect(setup.hosts).toHaveBeenCalledWith({ action: "list" });
  expect(() => invoke("setup:hosts")).toThrow();
  expect(() => invoke("setup:hosts", [{}, {}])).toThrow();
});

test("host requirements accept one request from the trusted Settings document", () => {
  const channel = "setup:repository-requirements";
  const request = { action: "read", repository: "/fixture/repo" };
  expect(invoke(channel, [request])).toBeNull();
  expect(setup.repositoryRequirements).toHaveBeenCalledExactlyOnceWith(request);
  for (const args of [[], [request, request]])
    expect(() => invoke(channel, args)).toThrow("Invalid host requirements request");
});

test("host copy accepts exactly one validated command and routes no raw text", () => {
  const command = { kind: "copy-host-alias", host: "worker" };
  invoke("setup:copy-host", [command]);
  expect(setup.copyHost).toHaveBeenCalledExactlyOnceWith(command);
  for (const args of [[], [command, "arbitrary"]])
    expect(() => invoke("setup:copy-host", args)).toThrow();
});

test("navigation, renderer loss and disposal cancel only the window's host trust run", () => {
  for (const event of ["destroyed", "render-process-gone"]) {
    const listener = contents.on.mock.calls.find(([name]) => name === event)?.[1];
    listener?.();
  }
  const navigate = contents.on.mock.calls.find(([name]) => name === "did-start-navigation")?.[1];
  navigate?.({}, "app://bundle/index.html", true, true);
  navigate?.({}, "other", false, false);
  expect(setup.cancelHostTrust).toHaveBeenCalledTimes(2);
  navigate?.({}, "other", false, true);
  expect(setup.cancelHostTrust).toHaveBeenCalledTimes(3);
  attached.dispose();
  expect(setup.cancelHostTrust).toHaveBeenCalledTimes(4);
});

test("local installer IPC accepts exactly one payload and delegates validation", () => {
  expect(invoke("setup:local-agent-install", [undefined])).toBe("installer");
  expect(invoke("setup:local-agent-install", ["claude"])).toBe("installer");
  for (const args of [[], ["claude", "extra"]])
    expect(() => invoke("setup:local-agent-install", args)).toThrow("Invalid installer request");
});

test("GitHub sign-in IPC accepts only an ID and closed action delegated to Setup", () => {
  expect(invoke("setup:github-sign-in", ["gh", "read"])).toBe("device-state");
  expect(setup.githubSignIn).toHaveBeenCalledExactlyOnceWith("gh", "read");
  for (const args of [[], ["gh"], ["gh", "read", "https://evil.test/"]])
    expect(() => invoke("setup:github-sign-in", args)).toThrow("Invalid sign-in request");
});

test.each([1.2, 1.234567])(
  "only user zoom requests adopt native factor %s; ordinary saves do not",
  async (factor) => {
    contents.getZoomFactor.mockReturnValue(factor);
    await invoke("setup:save", [{ agents: { claude: true } }]);
    expect(setup.save.mock.calls).toEqual([[{ agents: { claude: true } }]]);
    expect(contents.setZoomFactor).not.toHaveBeenCalled();
    setup.save.mockReturnValue({ settings: { interfaceScale: 130 } });
    const native = contents.on.mock.calls.find(([name]) => name === "zoom-changed")?.[1];
    native?.({}, "in");
    await vi.waitFor(() => {
      expect(setup.save).toHaveBeenLastCalledWith({ interfaceScale: 130 });
    });
    expect(contents.setZoomFactor).toHaveBeenLastCalledWith(1.3);
  },
);

test.each(["Settings", "shortcut"])(
  "explicit %s reset applies when the saved scale is already 100",
  async (control) => {
    contents.getZoomFactor.mockReturnValue(1.2);
    if (control === "Settings") await invoke("setup:save", [{ interfaceScale: 100 }]);
    else await attached.zoom("reset");
    expect(contents.setZoomFactor).toHaveBeenCalledExactlyOnceWith(1);
  },
);

test("native zoom failure is contained and the listener is disposed", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  setup.save.mockImplementationOnce(() => {
    throw new Error("fixture failure");
  });
  const native = contents.on.mock.calls.find(([name]) => name === "zoom-changed")?.[1];
  native?.({}, "in");
  await vi.waitFor(() => {
    expect(warn).toHaveBeenCalledExactlyOnceWith("Unable to change interface size");
  });
  attached.dispose();
  expect(contents.removeListener).toHaveBeenCalledWith("zoom-changed", native);
});
