// @vitest-environment jsdom
import type { ITerminalOptions } from "@xterm/xterm";
import { beforeEach, expect, test, vi } from "vitest";
const mock = vi.hoisted(() => {
  const options: ITerminalOptions = {};
  return {
    options,
    dark: true,
    osc: vi.fn<(code: number, callback: (data: string) => boolean) => void>(),
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
    detach: vi.fn(),
    key: vi.fn<(handler: (event: KeyboardEvent) => boolean) => void>(),
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
    attachCustomKeyEventHandler = mock.key;
    parser = {
      registerCsiHandler: vi.fn(),
      registerOscHandler: mock.osc,
      registerDcsHandler: vi.fn(),
    };
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
    '<main id="terminal"></main><span id="status"></span><button id="restart"></button><button id="toggle-terminal"></button>';
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
    get matches() {
      return mock.dark;
    },
    addEventListener: mock.change,
    removeEventListener: mock.removeChange,
  }));
  Object.defineProperty(document, "fonts", { configurable: true, value: { load: mock.fonts } });
  mock.dark = true;
  mock.fonts.mockResolvedValue([]);
  mock.attach.mockResolvedValue(undefined);
  mock.detach.mockResolvedValue(undefined);
  mock.write.mockImplementation((_data, done) => {
    done();
  });
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
  mock.write.mockClear();
  mock.write.mockImplementation(() => {});
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
  mock.onExit.mock.calls[0]?.[0]("one", -1);
  expect(document.querySelector("#status")?.textContent).toContain("Terminal host failed");
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
test.each(["terminal", "status", "restart", "toggle-terminal"])(
  "requires the %s element",
  async (id) => {
    document.getElementById(id)?.remove();
    await expect(import("../src/renderer/renderer")).rejects.toThrow("Missing terminal elements");
  },
);

test("ignores other sessions and preserves the ID in delayed draw acknowledgements", async () => {
  await import("../src/renderer/renderer");
  mock.onInput.mock.calls[0]?.[0]("early");
  mock.resizeCallback.mock.calls[0]?.[0]();
  await vi.waitFor(() => {
    expect(mock.focus).toHaveBeenCalled();
  });
  mock.onData.mock.calls[0]?.[0]("foreign", "old", "ignored");
  mock.onExit.mock.calls[0]?.[0]("foreign", 9);
  expect(mock.write).not.toHaveBeenCalledWith("ignored", expect.any(Function));
  expect(document.querySelector("#status")?.textContent).toBe("bash — /project");
});

test("derives terminal colors from CSS and follows system theme changes", async () => {
  await import("../src/renderer/renderer");
  expect(mock.options.fontFamily).toBe('"Geist Mono", monospace');
  await vi.waitFor(() => {
    expect(mock.focus).toHaveBeenCalled();
  });
  expect(mock.options.theme).toMatchObject({ background: "#05040a", foreground: "#f4efff" });
  document.documentElement.style.setProperty("--bg", "#F3F0FA");
  document.documentElement.style.setProperty("--ink", "#14101F");
  mock.dark = false;
  mock.change.mock.calls[0]?.[1]();
  expect(mock.options.theme).toMatchObject({ background: "#f3f0fa", foreground: "#14101f" });
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

test("applies mixed color sets and suppresses protocol replies at the parser without filtering input", async () => {
  await import("../src/renderer/renderer");
  await vi.waitFor(() => {
    expect(mock.focus).toHaveBeenCalled();
  });
  const handler = mock.osc.mock.calls.find(([code]) => code === 11)?.[1];
  expect(handler?.("#123456")).toBe(true);
  expect(mock.options.theme?.background).toBe("#123456");
  expect(handler?.("?")).toBe(true);
  expect(mock.input).not.toHaveBeenCalled();
  mock.onInput.mock.calls[0]?.[0]("pasted text");
  expect(mock.input).toHaveBeenCalledWith("one", "pasted text");
});

test("repeated hide/open cycles retain one subscription and gate hidden input and resizing", async () => {
  await import("../src/renderer/renderer");
  await vi.waitFor(() => {
    expect(mock.focus).toHaveBeenCalled();
  });
  const button = document.querySelector<HTMLButtonElement>("#toggle-terminal");
  for (let cycle = 0; cycle < 5; cycle++) {
    button?.click();
    await vi.waitFor(() => {
      expect(button?.disabled).toBe(false);
    });
    expect(document.querySelector<HTMLElement>("#terminal")?.hidden).toBe(true);
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
    mock.write.mockClear();
    mock.input.mockClear();
    mock.resize.mockClear();
    mock.onData.mock.calls[0]?.[0]("one", "old", "hidden output");
    mock.onInput.mock.calls[0]?.[0]("hidden input");
    mock.resizeCallback.mock.calls[0]?.[0]();
    expect(mock.write).not.toHaveBeenCalled();
    expect(mock.input).not.toHaveBeenCalled();
    expect(mock.resize).not.toHaveBeenCalled();
    button?.click();
    await vi.waitFor(() => {
      expect(button?.disabled).toBe(false);
    });
    expect(document.querySelector<HTMLElement>("#terminal")?.hidden).toBe(false);
    expect(button?.getAttribute("aria-expanded")).toBe("true");
    expect(mock.resize).toHaveBeenCalledWith("one", 80, 24);
  }
  expect(mock.create).toHaveBeenCalledOnce();
  expect(mock.attach).toHaveBeenCalledTimes(6);
  expect(mock.detach).toHaveBeenCalledTimes(5);
  expect(mock.onData).toHaveBeenCalledOnce();
  expect(mock.onExit).toHaveBeenCalledOnce();
  expect(mock.onInput).toHaveBeenCalledOnce();
});

test("Escape hides without reaching the PTY; repeated keys cannot overlap transitions", async () => {
  await import("../src/renderer/renderer");
  await vi.waitFor(() => {
    expect(mock.focus).toHaveBeenCalled();
  });
  const key = mock.key.mock.calls[0]?.[0];
  expect(key?.(new KeyboardEvent("keydown", { key: "a" }))).toBe(true);
  expect(key?.(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(false);
  key?.(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(key?.(new KeyboardEvent("keyup", { key: "Escape" }))).toBe(false);
  expect(mock.detach).toHaveBeenCalledOnce();
  expect(mock.input).not.toHaveBeenCalled();
  await vi.waitFor(() => {
    expect(document.querySelector<HTMLButtonElement>("#toggle-terminal")?.disabled).toBe(false);
  });
});

test.each([new Error("unavailable"), "unavailable"])(
  "failed view transitions allow retry: %s",
  async (error) => {
    await import("../src/renderer/renderer");
    await vi.waitFor(() => {
      expect(mock.focus).toHaveBeenCalled();
    });
    mock.detach.mockRejectedValueOnce(error);
    const button = document.querySelector<HTMLButtonElement>("#toggle-terminal");
    button?.click();
    await vi.waitFor(() => {
      expect(button?.disabled).toBe(false);
    });
    expect(document.querySelector("#status")?.textContent).toBe(
      "Unable to change terminal view: unavailable",
    );
    mock.attach.mockRejectedValueOnce(error);
    button?.click();
    await vi.waitFor(() => {
      expect(button?.disabled).toBe(false);
    });
    expect(button?.textContent).toBe("Open terminal");
    button?.click();
    await vi.waitFor(() => {
      expect(button?.disabled).toBe(false);
    });
    expect(button?.textContent).toBe("Hide terminal");
  },
);

test("drains pending writes before resetting and attaching a fresh snapshot", async () => {
  await import("../src/renderer/renderer");
  await vi.waitFor(() => {
    expect(mock.focus).toHaveBeenCalled();
  });
  const button = document.querySelector<HTMLButtonElement>("#toggle-terminal");
  button?.click();
  await vi.waitFor(() => {
    expect(button?.disabled).toBe(false);
  });
  mock.write.mockImplementation(() => {});
  mock.reset.mockClear();
  button?.click();
  expect(button?.disabled).toBe(true);
  expect(mock.reset).not.toHaveBeenCalled();
  expect(mock.attach).toHaveBeenCalledOnce();
  mock.write.mock.calls.at(-1)?.[1]();
  await vi.waitFor(() => {
    expect(button?.disabled).toBe(false);
  });
  expect(mock.reset).toHaveBeenCalledOnce();
  expect(mock.attach).toHaveBeenLastCalledWith("one");
});

test.each(["startup", "reopen", "hide"])(
  "host failure survives a pending %s operation and permits a clean restart",
  async (operation) => {
    const crash = () => {
      mock.onExit.mock.calls[0]?.[0]("one", -1);
      return Promise.reject(new Error("Terminal host stopped"));
    };
    if (operation === "startup") mock.attach.mockImplementationOnce(crash);
    await import("../src/renderer/renderer");
    const toggle = document.querySelector<HTMLButtonElement>("#toggle-terminal");
    const restart = document.querySelector<HTMLButtonElement>("#restart");
    if (operation !== "startup") {
      await vi.waitFor(() => {
        expect(toggle?.disabled).toBe(false);
      });
      if (operation === "reopen") {
        toggle?.click();
        await vi.waitFor(() => {
          expect(toggle?.disabled).toBe(false);
        });
        mock.attach.mockImplementationOnce(crash);
      } else mock.detach.mockImplementationOnce(crash);
      toggle?.click();
    }
    await vi.waitFor(() => {
      expect(restart?.disabled).toBe(false);
    });
    expect(document.querySelector("#status")?.textContent).toBe(
      "Terminal host failed. Restart the shell to continue.",
    );
    mock.create.mockResolvedValueOnce({ id: "replacement", title: "replacement shell" });
    restart?.click();
    await vi.waitFor(() => {
      expect(toggle?.disabled).toBe(false);
    });
    expect(document.querySelector("#status")?.textContent).toBe("replacement shell");
    expect(restart?.disabled).toBe(true);
    // A later unrelated startup error must not reuse the old host failure.
    mock.onExit.mock.calls[0]?.[0]("replacement", 0);
    mock.create.mockRejectedValueOnce(new Error("spawn failed"));
    restart?.click();
    await vi.waitFor(() => {
      expect(restart?.disabled).toBe(false);
    });
    expect(document.querySelector("#status")?.textContent).toBe(
      "Unable to start shell: spawn failed",
    );
  },
);
