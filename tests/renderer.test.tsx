// @vitest-environment jsdom
import type { ITerminalOptions } from "@xterm/xterm";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createShell } from "../src/renderer/shell-controller";
import type { ShellView } from "../src/renderer/shell.d";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
function Shell() {
  const controllerRef = useRef<ReturnType<typeof createShell>>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [view, setView] = useState<ShellView>({
    status: "Starting shell…",
    state: "quiet_ok",
    toggleLabel: "Open terminal",
    visible: false,
    toggleDisabled: true,
    restartDisabled: true,
  });
  const mount = useCallback((element: HTMLElement | null) => {
    if (element) controllerRef.current = createShell(element, setView);
    else controllerRef.current?.dispose();
  }, []);
  useLayoutEffect(() => {
    if (!view.visible && !view.toggleDisabled) toggleRef.current?.focus();
  }, [view.visible, view.toggleDisabled]);
  return (
    <>
      <span id="status">{view.status}</span>
      <button
        id="toggle-terminal"
        ref={toggleRef}
        disabled={view.toggleDisabled}
        aria-expanded={view.visible}
        onClick={() => {
          void controllerRef.current?.toggle();
        }}
      >
        {view.toggleLabel}
      </button>
      <button
        id="restart"
        disabled={view.restartDisabled}
        onClick={() => {
          void controllerRef.current?.restart();
        }}
      >
        Restart shell
      </button>
      <div id="terminal" ref={mount} />
    </>
  );
}
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

test("hidden startup exposes a tail without attaching and delegates Escape to the board", async () => {
  const tail = vi.fn().mockResolvedValue(["hidden output"]);
  Object.assign(window.desktop, { tail });
  const hide = vi.fn();
  const controller = createShell(document.createElement("div"), vi.fn(), false, hide);
  await expect(controller.tail()).resolves.toEqual([]);
  await waitFor(() => {
    expect(mock.create).toHaveBeenCalledOnce();
  });
  expect(mock.attach).not.toHaveBeenCalled();
  expect(controller.owns("one")).toBe(true);
  expect(controller.owns("sample")).toBe(false);
  await expect(controller.tail()).resolves.toEqual(["hidden output"]);
  expect(tail).toHaveBeenCalledWith("one", 40);
  mock.key.mock.calls[0]?.[0](new KeyboardEvent("keydown", { key: "Escape" }));
  expect(hide).toHaveBeenCalledOnce();
  await controller.hide();
  await controller.open();
  await controller.open();
  await controller.hide();
  expect(mock.detach).toHaveBeenCalledOnce();
  controller.dispose();
});

test.each(["drain", "attach"])(
  "hiding during %s cancels focus and attachment safely",
  async (stage) => {
    const controller = createShell(document.createElement("div"), vi.fn(), false);
    await waitFor(() => {
      expect(mock.create).toHaveBeenCalledOnce();
    });
    let complete: (() => void) | undefined;
    if (stage === "drain")
      mock.write.mockImplementationOnce((_data, done) => {
        complete = done;
      });
    else
      mock.attach.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            complete = resolve;
          }),
      );
    const opening = controller.toggle();
    await Promise.resolve();
    await controller.hide();
    complete?.();
    await opening;
    expect(mock.focus).not.toHaveBeenCalled();
    expect(mock.attach).toHaveBeenCalledTimes(stage === "drain" ? 0 : 1);
    expect(mock.detach).toHaveBeenCalledTimes(stage === "drain" ? 0 : 1);
    controller.dispose();
  },
);

test("opening the board row before creation finishes attaches as soon as the shell is ready", async () => {
  let created: ((value: { id: string; title: string }) => void) | undefined;
  mock.create.mockReturnValueOnce(
    new Promise((resolve) => {
      created = resolve;
    }),
  );
  const controller = createShell(document.createElement("div"), vi.fn(), false);
  await Promise.resolve();
  await controller.open();
  created?.({ id: "one", title: "bash" });
  await waitFor(() => {
    expect(mock.attach).toHaveBeenCalledWith("one");
  });
  controller.dispose();
});

test("selecting live IDs detaches before resetting, routes only the selected stream and retains exits", async () => {
  const update = vi.fn();
  const created = vi.fn();
  const controller = createShell(document.createElement("div"), update, false, undefined, created);
  await controller.open("agent-a");
  expect(created).toHaveBeenCalledWith("one", "bash — /project");
  expect(mock.detach).toHaveBeenCalledWith("one");
  expect(mock.attach).toHaveBeenLastCalledWith("agent-a");
  mock.write.mockClear();
  mock.onData.mock.calls[0]?.[0]("one", "old", "foreign");
  expect(mock.write).not.toHaveBeenCalled();
  mock.onData.mock.calls[0]?.[0]("agent-a", "view-a", "hello");
  expect(mock.acknowledge).toHaveBeenCalledWith("agent-a", "view-a", 5);
  mock.onInput.mock.calls[0]?.[0]("y");
  expect(mock.input).toHaveBeenCalledWith("agent-a", "y");
  mock.onExit.mock.calls[0]?.[0]("agent-b", 0);
  await controller.open("agent-b");
  expect(mock.detach).toHaveBeenLastCalledWith("agent-a");
  expect(update).toHaveBeenLastCalledWith(
    expect.objectContaining({ state: "done", restartDisabled: true }),
  );
  expect(mock.kill).not.toHaveBeenCalled();
  const attachments = mock.attach.mock.calls.length;
  await controller.open("agent-b");
  expect(mock.attach).toHaveBeenCalledTimes(attachments);
  await controller.hide();
  mock.onExit.mock.calls[0]?.[0]("agent-c", -1);
  await controller.open("agent-c");
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ state: "failed" }));
  controller.dispose();
});

test("rapid selection, hide and disposal supersede pending opens", async () => {
  const controller = createShell(document.createElement("div"), vi.fn(), false);
  const old = controller.open("old");
  const next = controller.open("next");
  await Promise.all([old, next]);
  expect(mock.attach.mock.calls.map(([id]: unknown[]) => id)).not.toContain("old");
  let detached: (() => void) | undefined;
  mock.detach.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        detached = resolve;
      }),
  );
  const opening = controller.open("cancelled");
  await vi.waitFor(() => {
    expect(detached).toBeDefined();
  });
  const hiding = controller.hide();
  detached?.();
  await Promise.all([opening, hiding]);
  expect(mock.attach.mock.calls.map(([id]: unknown[]) => id)).not.toContain("cancelled");
  controller.dispose();
  await controller.open("disposed");
  expect(mock.attach.mock.calls.map(([id]: unknown[]) => id)).not.toContain("disposed");
});

test("failed live attachment detaches and reports the error; later selection can recover", async () => {
  const update = vi.fn();
  const controller = createShell(document.createElement("div"), update, false);
  mock.attach.mockRejectedValueOnce(new Error("attach failed"));
  await controller.open("broken");
  expect(mock.detach).toHaveBeenLastCalledWith("broken");
  expect(update).toHaveBeenLastCalledWith(
    expect.objectContaining({ visible: false, status: "Unable to open terminal: attach failed" }),
  );
  await controller.open("healthy");
  expect(mock.attach).toHaveBeenLastCalledWith("healthy");
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }));
  controller.dispose();
});

test("board selection waits for a replacement shell's pending attachment", async () => {
  const update = vi.fn();
  const controller = createShell(document.createElement("div"), update, false);
  await controller.open("one");
  mock.onExit.mock.calls[0]?.[0]("one", -1);
  mock.create.mockResolvedValueOnce({ id: "replacement", title: "replacement shell" });
  let attached: (() => void) | undefined;
  mock.attach.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        attached = resolve;
      }),
  );
  const restarting = controller.restart();
  await vi.waitFor(() => {
    expect(attached).toBeDefined();
  });
  // React follows the new terminal ID while its first attach is still in flight.
  const opening = controller.open("replacement");
  await Promise.resolve();
  await Promise.resolve();
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ toggleDisabled: true }));
  mock.onInput.mock.calls[0]?.[0]("early");
  expect(mock.input).not.toHaveBeenCalled();
  expect(mock.attach).toHaveBeenCalledTimes(2);
  attached?.();
  await Promise.all([restarting, opening]);
  expect(mock.detach).toHaveBeenCalledWith("replacement");
  expect(mock.attach).toHaveBeenLastCalledWith("replacement");
  expect(update).toHaveBeenLastCalledWith(
    expect.objectContaining({ visible: true, toggleDisabled: false }),
  );
  mock.onInput.mock.calls[0]?.[0]("echo HOST_RESTART_OK\r");
  expect(mock.input).toHaveBeenCalledWith("replacement", "echo HOST_RESTART_OK\r");
  controller.dispose();
});

test("a passive controller launches no shell until requested and preserves other terminals", async () => {
  const controller = createShell(
    document.createElement("div"),
    vi.fn(),
    false,
    undefined,
    undefined,
    false,
  );
  await Promise.resolve();
  expect(mock.create).not.toHaveBeenCalled();
  await controller.open("agent-id");
  await controller.restart();
  expect(mock.kill).not.toHaveBeenCalledWith("agent-id");
  expect(mock.detach).toHaveBeenCalledWith("agent-id");
  expect(mock.create).toHaveBeenCalledOnce();
  controller.dispose();
});
