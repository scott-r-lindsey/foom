// @vitest-environment jsdom
import type { ITerminalOptions } from "@xterm/xterm";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { Shell } from "../src/renderer/shell";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
async function settle(action: () => void) {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}
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
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  document.body.replaceChildren();
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
  await settle(() => {
    render(<Shell />);
  });
  await waitFor(() => {
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
  cleanup();
  expect(mock.disconnect).toHaveBeenCalled();
  expect(mock.offData).toHaveBeenCalled();
  expect(mock.offExit).toHaveBeenCalled();
  expect(mock.dispose).toHaveBeenCalled();
  expect(mock.removeChange).toHaveBeenCalledWith("change", mock.change.mock.calls[0]?.[1]);
});
test("shows exit status and lets the user restart", async () => {
  await settle(() => {
    render(<Shell />);
  });
  await waitFor(() => {
    expect(mock.focus).toHaveBeenCalled();
  });
  act(() => {
    mock.onExit.mock.calls[0]?.[0]("one", 4);
  });
  expect(document.querySelector("#status")?.textContent).toBe("Shell exited (4)");
  act(() => {
    mock.onExit.mock.calls[0]?.[0]("one", -1);
  });
  expect(document.querySelector("#status")?.textContent).toContain("Terminal host failed");
  const button = document.querySelector<HTMLButtonElement>("#restart");
  expect(button?.disabled).toBe(false);
  await settle(() => {
    button?.click();
  });
  await waitFor(() => {
    expect(mock.create).toHaveBeenCalledTimes(2);
  });
});
test.each([new Error("broken"), "broken"])(
  "shows startup errors and enables retry (%s)",
  async (error) => {
    mock.create.mockRejectedValue(error);
    await settle(() => {
      render(<Shell />);
    });
    await waitFor(() => {
      expect(document.querySelector("#status")?.textContent).toBe("Unable to start shell: broken");
    });
    expect(document.querySelector<HTMLButtonElement>("#restart")?.disabled).toBe(false);
  },
);
test("ignores other sessions and preserves the ID in delayed draw acknowledgements", async () => {
  await settle(() => {
    render(<Shell />);
  });
  mock.onInput.mock.calls[0]?.[0]("early");
  mock.resizeCallback.mock.calls[0]?.[0]();
  await waitFor(() => {
    expect(mock.focus).toHaveBeenCalled();
  });
  mock.onData.mock.calls[0]?.[0]("foreign", "old", "ignored");
  mock.onExit.mock.calls[0]?.[0]("foreign", 9);
  expect(mock.write).not.toHaveBeenCalledWith("ignored", expect.any(Function));
  expect(document.querySelector("#status")?.textContent).toBe("bash — /project");
});

test("derives terminal colors from CSS and follows system theme changes", async () => {
  await settle(() => {
    render(<Shell />);
  });
  expect(mock.options.fontFamily).toBe('"Geist Mono", monospace');
  await waitFor(() => {
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
  await settle(() => {
    render(<Shell />);
  });
  expect(mock.fonts).toHaveBeenCalledWith('14px "Geist Mono"');
  expect(mock.create).not.toHaveBeenCalled();
  loaded?.([]);
  await waitFor(() => {
    expect(mock.create).toHaveBeenCalledOnce();
  });
});

test("still starts with the fallback face if a bundled font cannot load", async () => {
  mock.fonts.mockRejectedValue(new Error("Font unavailable"));
  await settle(() => {
    render(<Shell />);
  });
  await waitFor(() => {
    expect(mock.create).toHaveBeenCalledOnce();
  });
});

test("applies mixed color sets and suppresses protocol replies at the parser without filtering input", async () => {
  await settle(() => {
    render(<Shell />);
  });
  await waitFor(() => {
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
  await settle(() => {
    render(<Shell />);
  });
  await waitFor(() => {
    expect(mock.focus).toHaveBeenCalled();
  });
  const button = document.querySelector<HTMLButtonElement>("#toggle-terminal");
  for (let cycle = 0; cycle < 5; cycle++) {
    await settle(() => {
      button?.click();
    });
    await waitFor(() => {
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
    await settle(() => {
      button?.click();
    });
    await waitFor(() => {
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
  await settle(() => {
    render(<Shell />);
  });
  await waitFor(() => {
    expect(mock.focus).toHaveBeenCalled();
  });
  const key = mock.key.mock.calls[0]?.[0];
  expect(key?.(new KeyboardEvent("keydown", { key: "a" }))).toBe(true);
  expect(key?.(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(false);
  key?.(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(key?.(new KeyboardEvent("keyup", { key: "Escape" }))).toBe(false);
  expect(mock.detach).toHaveBeenCalledOnce();
  expect(mock.input).not.toHaveBeenCalled();
  await waitFor(() => {
    expect(document.querySelector<HTMLButtonElement>("#toggle-terminal")?.disabled).toBe(false);
  });
});

test.each([new Error("unavailable"), "unavailable"])(
  "failed view transitions allow retry: %s",
  async (error) => {
    await settle(() => {
      render(<Shell />);
    });
    await waitFor(() => {
      expect(mock.focus).toHaveBeenCalled();
    });
    mock.detach.mockRejectedValueOnce(error);
    const button = document.querySelector<HTMLButtonElement>("#toggle-terminal");
    await settle(() => {
      button?.click();
    });
    await waitFor(() => {
      expect(button?.disabled).toBe(false);
    });
    expect(document.querySelector("#status")?.textContent).toBe(
      "Unable to change terminal view: unavailable",
    );
    mock.attach.mockRejectedValueOnce(error);
    await settle(() => {
      button?.click();
    });
    await waitFor(() => {
      expect(button?.disabled).toBe(false);
    });
    expect(button?.textContent).toBe("Open terminal");
    await settle(() => {
      button?.click();
    });
    await waitFor(() => {
      expect(button?.disabled).toBe(false);
    });
    expect(button?.textContent).toBe("Hide terminal");
  },
);

test("drains pending writes before resetting and attaching a fresh snapshot", async () => {
  await settle(() => {
    render(<Shell />);
  });
  await waitFor(() => {
    expect(mock.focus).toHaveBeenCalled();
  });
  const button = document.querySelector<HTMLButtonElement>("#toggle-terminal");
  await settle(() => {
    button?.click();
  });
  await waitFor(() => {
    expect(button?.disabled).toBe(false);
  });
  mock.write.mockImplementation(() => {});
  mock.reset.mockClear();
  await settle(() => {
    button?.click();
  });
  await waitFor(() => {
    expect(button?.disabled).toBe(true);
  });
  expect(mock.reset).not.toHaveBeenCalled();
  expect(mock.attach).toHaveBeenCalledOnce();
  await settle(() => {
    mock.write.mock.calls.at(-1)?.[1]();
  });
  await waitFor(() => {
    expect(button?.disabled).toBe(false);
  });
  expect(mock.reset).toHaveBeenCalledOnce();
  expect(mock.attach).toHaveBeenLastCalledWith("one");
});

test.each(["startup", "reopen", "hide"])(
  "host failure survives a pending %s operation and permits a clean restart",
  async (operation) => {
    const crash = () => {
      act(() => {
        mock.onExit.mock.calls[0]?.[0]("one", -1);
      });
      return Promise.reject(new Error("Terminal host stopped"));
    };
    if (operation === "startup") mock.attach.mockImplementationOnce(crash);
    await settle(() => {
      render(<Shell />);
    });
    const toggle = document.querySelector<HTMLButtonElement>("#toggle-terminal");
    const restart = document.querySelector<HTMLButtonElement>("#restart");
    if (operation !== "startup") {
      await waitFor(() => {
        expect(toggle?.disabled).toBe(false);
      });
      if (operation === "reopen") {
        await settle(() => {
          toggle?.click();
        });
        await waitFor(() => {
          expect(toggle?.disabled).toBe(false);
        });
        mock.attach.mockImplementationOnce(crash);
      } else mock.detach.mockImplementationOnce(crash);
      await settle(() => {
        toggle?.click();
      });
    }
    await waitFor(() => {
      expect(restart?.disabled).toBe(false);
    });
    expect(document.querySelector("#status")?.textContent).toBe(
      "Terminal host failed. Restart the shell to continue.",
    );
    mock.create.mockResolvedValueOnce({ id: "replacement", title: "replacement shell" });
    await settle(() => {
      restart?.click();
    });
    await waitFor(() => {
      expect(toggle?.disabled).toBe(false);
    });
    expect(document.querySelector("#status")?.textContent).toBe("replacement shell");
    expect(restart?.disabled).toBe(true);
    // A later unrelated startup error must not reuse the old host failure.
    act(() => {
      mock.onExit.mock.calls[0]?.[0]("replacement", 0);
    });
    mock.create.mockRejectedValueOnce(new Error("spawn failed"));
    await settle(() => {
      restart?.click();
    });
    await waitFor(() => {
      expect(restart?.disabled).toBe(false);
    });
    expect(document.querySelector("#status")?.textContent).toBe(
      "Unable to start shell: spawn failed",
    );
  },
);

test("opens the sample board without creating another terminal or sending sample IDs to IPC", async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  await settle(() => {
    render(<Shell />);
  });
  await waitFor(() => {
    expect(mock.focus).toHaveBeenCalledOnce();
  });
  await settle(() => {
    document.querySelectorAll<HTMLButtonElement>("header button")[1]?.click();
  });
  expect(document.querySelector("dialog")?.open).toBe(true);
  expect(document.activeElement).toBe(document.querySelector(".board-row"));
  expect(mock.create).toHaveBeenCalledOnce();
  expect(mock.input).not.toHaveBeenCalled();
});

test("unmount before fonts load does not create a terminal session", async () => {
  let loaded: ((faces: FontFace[]) => void) | undefined;
  mock.fonts.mockReturnValue(
    new Promise((resolve) => {
      loaded = resolve;
    }),
  );
  await settle(() => {
    render(<Shell />);
  });
  cleanup();
  await settle(() => {
    loaded?.([]);
  });
  expect(mock.create).not.toHaveBeenCalled();
  expect(mock.dispose).toHaveBeenCalledOnce();
});

test("unmount during creation cleans up the late session without attaching", async () => {
  let created: ((value: { id: string; title: string }) => void) | undefined;
  mock.create.mockReturnValue(
    new Promise((resolve) => {
      created = resolve;
    }),
  );
  await settle(() => {
    render(<Shell />);
  });
  expect(mock.create).toHaveBeenCalledOnce();
  cleanup();
  await settle(() => {
    created?.({ id: "late", title: "late shell" });
  });
  expect(mock.kill).toHaveBeenCalledWith("late");
  expect(mock.attach).not.toHaveBeenCalled();
});

test("unmount while draining never resets or attaches a disposed terminal", async () => {
  mock.write.mockImplementation(() => {});
  await settle(() => {
    render(<Shell />);
  });
  expect(mock.write).toHaveBeenCalledWith("", expect.any(Function));
  cleanup();
  await settle(() => {
    mock.write.mock.calls.at(-1)?.[1]();
  });
  expect(mock.reset).not.toHaveBeenCalled();
  expect(mock.attach).not.toHaveBeenCalled();
});

test("unmount while attaching does not focus a disposed terminal", async () => {
  let attached: (() => void) | undefined;
  mock.attach.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      attached = resolve;
    }),
  );
  await settle(() => {
    render(<Shell />);
  });
  expect(mock.attach).toHaveBeenCalledOnce();
  cleanup();
  await settle(() => {
    attached?.();
  });
  expect(mock.focus).not.toHaveBeenCalled();
});

test("unmount during restart does not launch a replacement after kill completes", async () => {
  await settle(() => {
    render(<Shell />);
  });
  await waitFor(() => {
    expect(mock.focus).toHaveBeenCalledOnce();
  });
  act(() => {
    mock.onExit.mock.calls[0]?.[0]("one", 0);
  });
  let killed: (() => void) | undefined;
  mock.kill.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      killed = resolve;
    }),
  );
  await settle(() => {
    document.querySelector<HTMLButtonElement>("#restart")?.click();
  });
  expect(document.querySelector("#status")?.textContent).toBe("Starting shell…");
  cleanup();
  await settle(() => {
    killed?.();
  });
  expect(mock.create).toHaveBeenCalledOnce();
});
