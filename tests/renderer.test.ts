// @vitest-environment jsdom
import type { ITerminalOptions } from "@xterm/xterm";
import { beforeEach, expect, test, vi } from "vitest";
const mock = vi.hoisted(() => {
  const options: ITerminalOptions = {};
  return {
    options,
    change: vi.fn<(event: string, callback: () => void) => void>(),
    removeChange: vi.fn(),
    fonts: vi.fn<() => Promise<FontFace[]>>(),
    open: vi.fn(),
    loadAddon: vi.fn(),
    write: vi.fn<(data: string, done: () => void) => void>(),
    reset: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn(),
    fit: vi.fn(),
    observe: vi.fn(),
    disconnect: vi.fn(),
    onInput: vi.fn<(callback: (data: string) => void) => void>(),
    onData: vi.fn<(callback: (id: string, token: string, data: string) => void) => () => void>(),
    onExit: vi.fn<(callback: (id: string, code: number) => void) => () => void>(),
    create: vi.fn<(cols: number, rows: number) => Promise<{ id: string; title: string }>>(),
    attach: vi.fn(),
    kill: vi.fn(),
    input: vi.fn(),
    resize: vi.fn(),
    acknowledge: vi.fn(),
    offData: vi.fn(),
    offExit: vi.fn(),
    resizeCallback: vi.fn<(callback: () => void) => void>(),
  };
});
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructor(options: ITerminalOptions) {
      mock.options = options;
    }
    get options() {
      return mock.options;
    }
    cols = 80;
    rows = 24;
    open = mock.open;
    loadAddon = mock.loadAddon;
    write = mock.write;
    reset = mock.reset;
    focus = mock.focus;
    dispose = mock.dispose;
    onData = mock.onInput;
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = mock.fit;
  },
}));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.innerHTML =
    '<main id="terminal"></main><span id="status"></span><button id="restart"></button>';
  Object.defineProperty(window, "desktop", { configurable: true, value: mock });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        mock.resizeCallback(callback);
      }
      observe = mock.observe;
      disconnect = mock.disconnect;
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    addEventListener: mock.change,
    removeEventListener: mock.removeChange,
  }));
  Object.defineProperty(document, "fonts", { configurable: true, value: { load: mock.fonts } });
  mock.fonts.mockResolvedValue([]);
  document.documentElement.style.setProperty("--bg", "#05040A");
  document.documentElement.style.setProperty("--ink", "#F4EFFF");
  mock.create.mockResolvedValue({ id: "one", title: "bash — /project" });
  mock.onData.mockReturnValue(mock.offData);
  mock.onExit.mockReturnValue(mock.offExit);
});
test("starts at fitted dimensions, routes input/output, resizes and disposes", async () => {
  await import("../src/renderer/renderer");
  await vi.waitFor(() => {
    expect(mock.focus).toHaveBeenCalled();
  });
  expect(mock.create).toHaveBeenCalledWith(80, 24);
  expect(document.querySelector("#status")?.textContent).toBe("bash — /project");
  mock.onInput.mock.calls[0]?.[0]("\u0003");
  expect(mock.input).toHaveBeenCalledWith("one", "\u0003");
  mock.onData.mock.calls[0]?.[0]("one", "view", "hello");
  expect(mock.acknowledge).not.toHaveBeenCalled();
  mock.write.mock.calls[0]?.[1]();
  expect(mock.acknowledge).toHaveBeenCalledWith("one", "view", 5);
  mock.resizeCallback.mock.calls[0]?.[0]();
  expect(mock.resize).toHaveBeenCalledWith("one", 80, 24);
  window.dispatchEvent(new Event("beforeunload"));
  expect(mock.disconnect).toHaveBeenCalled();
  expect(mock.offData).toHaveBeenCalled();
  expect(mock.offExit).toHaveBeenCalled();
  expect(mock.dispose).toHaveBeenCalled();
  expect(mock.removeChange).toHaveBeenCalledWith("change", mock.change.mock.calls[0]?.[1]);
});
test("shows exit status and lets the user restart", async () => {
  await import("../src/renderer/renderer");
  await vi.waitFor(() => {
    expect(mock.focus).toHaveBeenCalled();
  });
  mock.onExit.mock.calls[0]?.[0]("one", 4);
  expect(document.querySelector("#status")?.textContent).toBe("Shell exited (4)");
  const button = document.querySelector<HTMLButtonElement>("#restart");
  expect(button?.disabled).toBe(false);
  button?.click();
  await vi.waitFor(() => {
    expect(mock.create).toHaveBeenCalledTimes(2);
  });
});
test.each([new Error("broken"), "broken"])(
  "shows startup errors and enables retry (%s)",
  async (error) => {
    mock.create.mockRejectedValue(error);
    await import("../src/renderer/renderer");
    await vi.waitFor(() => {
      expect(document.querySelector("#status")?.textContent).toBe("Unable to start shell: broken");
    });
    expect(document.querySelector<HTMLButtonElement>("#restart")?.disabled).toBe(false);
  },
);
test.each(["terminal", "status", "restart"])("requires the %s element", async (id) => {
  document.getElementById(id)?.remove();
  await expect(import("../src/renderer/renderer")).rejects.toThrow("Missing terminal elements");
});

test("ignores other sessions and preserves the ID in delayed draw acknowledgements", async () => {
  await import("../src/renderer/renderer");
  mock.onInput.mock.calls[0]?.[0]("early");
  mock.resizeCallback.mock.calls[0]?.[0]();
  await vi.waitFor(() => {
    expect(mock.focus).toHaveBeenCalled();
  });
  mock.onData.mock.calls[0]?.[0]("foreign", "old", "ignored");
  mock.onExit.mock.calls[0]?.[0]("foreign", 9);
  expect(mock.write).not.toHaveBeenCalled();
  expect(document.querySelector("#status")?.textContent).toBe("bash — /project");
});

test("derives terminal colors from CSS and follows system theme changes", async () => {
  await import("../src/renderer/renderer");
  expect(mock.options.fontFamily).toBe('"Geist Mono", monospace');
  expect(mock.options.theme).toMatchObject({ background: "#05040A", foreground: "#F4EFFF" });
  document.documentElement.style.setProperty("--bg", "#F3F0FA");
  document.documentElement.style.setProperty("--ink", "#14101F");
  mock.change.mock.calls[0]?.[1]();
  expect(mock.options.theme).toMatchObject({ background: "#F3F0FA", foreground: "#14101F" });
});

test("waits for the terminal font before starting and fitting the shell", async () => {
  let loaded: ((faces: FontFace[]) => void) | undefined;
  mock.fonts.mockReturnValue(
    new Promise((resolve) => {
      loaded = resolve;
    }),
  );
  await import("../src/renderer/renderer");
  expect(mock.fonts).toHaveBeenCalledWith('14px "Geist Mono"');
  expect(mock.create).not.toHaveBeenCalled();
  loaded?.([]);
  await vi.waitFor(() => {
    expect(mock.create).toHaveBeenCalledOnce();
  });
});

test("still starts with the fallback face if a bundled font cannot load", async () => {
  mock.fonts.mockRejectedValue(new Error("Font unavailable"));
  await import("../src/renderer/renderer");
  await vi.waitFor(() => {
    expect(mock.create).toHaveBeenCalledOnce();
  });
});
