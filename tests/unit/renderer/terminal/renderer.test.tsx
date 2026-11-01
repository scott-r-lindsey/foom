import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { terminalSnapshot } from "../../../../src/terminal-host/terminal-snapshot";
import { terminalSelectionBuffer } from "../../../../src/renderer/terminal/middle-click";
import { terminalThemes } from "../../../../src/shared/terminal-themes";
// @vitest-environment jsdom
import { setupState } from "../../../fixtures/setup";
import type { SetupState } from "../../../../src/shared/setup";
import type { ITerminalOptions } from "@xterm/xterm";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createShell } from "../../../../src/renderer/terminal/shell-controller";
import type { ShellView } from "../../../../src/renderer/terminal/shell.d";
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
    webglFallback: vi.fn<(callback: () => void) => void>(),
    dark: true,
    cols: 80,
    rows: 24,
    fitCols: 80,
    fitRows: 24,
    osc: vi.fn<(code: number, callback: (data: string) => boolean) => void>(),
    change: vi.fn<(event: string, callback: () => void) => void>(),
    removeChange: vi.fn(),
    fonts: vi.fn<() => Promise<FontFace[]>>(),
    open: vi.fn(),
    loadAddon: vi.fn(),
    write: vi.fn<(data: string, done?: () => void) => void>(),
    reset: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn(),
    fit: vi.fn(),
    observe: vi.fn(),
    disconnect: vi.fn(),
    onRender: vi.fn<(callback: () => void) => { dispose: () => void }>(),
    offRender: vi.fn(),
    onSelectionChange: vi.fn<(callback: () => void) => { dispose: () => void }>(),
    getSelection: vi.fn<() => string>(),
    paste: vi.fn(),
    onInput: vi.fn<(callback: (data: string) => void) => void>(),
    onData: vi.fn<(callback: (id: string, token: string, data: string) => void) => () => void>(),
    onTerminalAvailability:
      vi.fn<(callback: (id: string, available: boolean, reset?: boolean) => void) => () => void>(),
    onExit: vi.fn<(callback: (id: string, code: number) => void) => () => void>(),
    create: vi.fn<(cols: number, rows: number) => Promise<{ id: string; title: string }>>(),
    attach: vi.fn(),
    detach: vi.fn(),
    wheel: vi.fn<(handler: (event: WheelEvent) => boolean) => void>(),
    key: vi.fn<(handler: (event: KeyboardEvent) => boolean) => void>(),
    kill: vi.fn(),
    input: vi.fn(),
    pasteTerminal: vi.fn(),
    resize: vi.fn(),
    acknowledge: vi.fn(),
    offData: vi.fn(),
    offExit: vi.fn(),
    setupState: vi.fn<() => Promise<SetupState>>(),
    onSetupChange: vi.fn<(callback: (state: SetupState) => void) => () => void>(),
    offSetup: vi.fn(),
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
    get cols() {
      return mock.cols;
    }
    get rows() {
      return mock.rows;
    }
    open = mock.open;
    loadAddon = mock.loadAddon;
    write = mock.write;
    reset = mock.reset;
    focus = mock.focus;
    dispose = mock.dispose;
    onData = mock.onInput;
    onRender = mock.onRender;
    onSelectionChange = mock.onSelectionChange;
    getSelection = mock.getSelection;
    paste = mock.paste;
    attachCustomKeyEventHandler = mock.key;
    attachCustomWheelEventHandler = mock.wheel;
    buffer = { active: { type: "alternate" } };
    modes = { mouseTrackingMode: "none", applicationCursorKeysMode: false };
    parser = {
      registerCsiHandler: vi.fn(),
      registerOscHandler: mock.osc,
      registerDcsHandler: vi.fn(),
    };
  },
}));
vi.mock("../../../../src/renderer/terminal/webgl-renderer", () => ({
  createWebglRenderer: (_terminal: unknown, fallback: () => void) => {
    mock.webglFallback(fallback);
    return { visible: vi.fn(), dispose: vi.fn() };
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = mock.fit;
    proposeDimensions = () => ({ cols: mock.fitCols, rows: mock.fitRows });
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
  mock.setupState.mockResolvedValue(setupState());
  mock.onSetupChange.mockReturnValue(mock.offSetup);
  mock.dark = true;
  mock.cols = 80;
  mock.rows = 24;
  mock.fitCols = 80;
  mock.fitRows = 24;
  mock.fit.mockImplementation(() => {
    mock.cols = mock.fitCols;
    mock.rows = mock.fitRows;
  });
  mock.fonts.mockResolvedValue([]);
  mock.attach.mockResolvedValue(undefined);
  mock.detach.mockResolvedValue(undefined);
  mock.write.mockImplementation((_data, done) => {
    done?.();
  });
  document.documentElement.style.setProperty("--bg", "#05040A");
  document.documentElement.style.setProperty("--ink", "#F4EFFF");
  mock.create.mockResolvedValue({ id: "one", title: "bash — /project" });
  mock.onData.mockReturnValue(mock.offData);
  mock.onRender.mockReturnValue({ dispose: mock.offRender });
  mock.onSelectionChange.mockReturnValue({ dispose: vi.fn() });
  mock.onTerminalAvailability.mockReturnValue(() => {});
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
  mock.write.mock.calls[0]?.[1]?.();
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
      expect(document.querySelector("#status")?.textContent).toBe("Unable to start shell");
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

test("follows the interface palette and system theme changes", async () => {
  await settle(() => {
    render(<Shell />);
  });
  expect(mock.options.fontFamily).toBe('"Hack Nerd Font Mono", "Geist Mono", monospace');
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
  expect(mock.fonts).toHaveBeenCalledWith('14px "Hack Nerd Font Mono"');
  expect(mock.fonts).toHaveBeenCalledWith('bold 14px "Hack Nerd Font Mono"');
  expect(mock.create).not.toHaveBeenCalled();
  loaded?.([]);
  await waitFor(() => {
    expect(mock.create).toHaveBeenCalledOnce();
  });
});

test.each(["select", "launch"])(
  "board %s waits for both bundled weights before fitting",
  async (action) => {
    let regularLoaded: ((faces: FontFace[]) => void) | undefined;
    let boldLoaded: ((faces: FontFace[]) => void) | undefined;
    mock.fonts.mockImplementation(
      (...args: unknown[]) =>
        new Promise((resolve) => {
          if (args[0] === '14px "Hack Nerd Font Mono"') regularLoaded = resolve;
          else boldLoaded = resolve;
        }),
    );
    const controller = createShell(document.createElement("div"), vi.fn(), false, undefined, false);
    const opening = action === "select" ? controller.open("existing") : controller.restart();
    await settle(() => regularLoaded?.([]));
    expect(mock.create).not.toHaveBeenCalled();
    expect(mock.attach).not.toHaveBeenCalled();
    expect(mock.open).not.toHaveBeenCalled();
    boldLoaded?.([]);
    await opening;
    expect(mock.open).toHaveBeenCalledOnce();
    expect(mock.attach).toHaveBeenCalledOnce();
    controller.dispose();
  },
);

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

test("Escape is not intercepted and input reaches the PTY", async () => {
  await settle(() => {
    render(<Shell />);
  });
  expect(mock.key).toHaveBeenCalledOnce();
  mock.onInput.mock.calls[0]?.[0]("\x1b");
  expect(mock.input).toHaveBeenCalledWith("one", "\x1b");
  expect(mock.detach).not.toHaveBeenCalled();
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
    expect(document.querySelector("#status")?.textContent).toBe("Unable to change terminal view");
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
    mock.write.mock.calls.at(-1)?.[1]?.();
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
    expect(document.querySelector("#status")?.textContent).toBe("Unable to start shell");
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
  expect(mock.open).not.toHaveBeenCalled();
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
    mock.write.mock.calls.at(-1)?.[1]?.();
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

test("hidden startup exposes a tail without attaching and preserves Escape", async () => {
  const tail = vi.fn().mockResolvedValue(["hidden output"]);
  Object.assign(window.desktop, { tail });
  const controller = createShell(document.createElement("div"), vi.fn(), false);
  await expect(controller.tail()).resolves.toEqual([]);
  await waitFor(() => {
    expect(mock.create).toHaveBeenCalledOnce();
  });
  expect(mock.attach).not.toHaveBeenCalled();
  expect(controller.owns("one")).toBe(true);
  expect(controller.owns("sample")).toBe(false);
  await expect(controller.tail()).resolves.toEqual(["hidden output"]);
  expect(tail).toHaveBeenCalledWith("one", 40);
  expect(mock.key.mock.calls[0]?.[0](new KeyboardEvent("keydown", { key: "Escape" }))).toBe(true);
  expect(mock.key).toHaveBeenCalledOnce();
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
  const controller = createShell(document.createElement("div"), update, false, created);
  await controller.open("agent-a");
  expect(created).toHaveBeenCalledWith("one", "bash — /project");
  expect(mock.detach).not.toHaveBeenCalled();
  expect(mock.attach).toHaveBeenLastCalledWith("agent-a");
  mock.write.mockClear();
  mock.onData.mock.calls[0]?.[0]("one", "old", "foreign");
  expect(mock.write).not.toHaveBeenCalled();
  mock.onData.mock.calls[0]?.[0]("agent-a", "view-a", "hello");
  expect(mock.acknowledge).toHaveBeenCalledWith("agent-a", "view-a", 5);
  mock.onInput.mock.calls[0]?.[0]("y");
  expect(mock.input).toHaveBeenCalledWith("agent-a", "y");
  const openingB = controller.open("agent-b");
  mock.onExit.mock.calls[0]?.[0]("agent-b", 0);
  await openingB;
  expect(mock.detach).toHaveBeenLastCalledWith("agent-a");
  expect(update).toHaveBeenLastCalledWith(
    expect.objectContaining({ state: "done", restartDisabled: true }),
  );
  expect(mock.kill).not.toHaveBeenCalled();
  const attachments = mock.attach.mock.calls.length;
  await controller.open("agent-b");
  expect(mock.attach).toHaveBeenCalledTimes(attachments);
  await controller.hide();
  const openingC = controller.open("agent-c");
  mock.onExit.mock.calls[0]?.[0]("agent-c", -1);
  await openingC;
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
    expect.objectContaining({ visible: false, status: "Unable to open terminal" }),
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
  expect(mock.options.disableStdin).toBe(true);
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
  expect(mock.options.disableStdin).toBe(false);
  mock.onInput.mock.calls[0]?.[0]("echo HOST_RESTART_OK\r");
  expect(mock.input).toHaveBeenCalledWith("replacement", "echo HOST_RESTART_OK\r");
  controller.dispose();
});

test("a passive controller launches no shell until requested and preserves other terminals", async () => {
  const controller = createShell(document.createElement("div"), vi.fn(), false, undefined, false);
  await Promise.resolve();
  expect(mock.create).not.toHaveBeenCalled();
  await controller.open("agent-id");
  await controller.restart();
  expect(mock.kill).not.toHaveBeenCalledWith("agent-id");
  expect(mock.detach).toHaveBeenCalledWith("agent-id");
  expect(mock.create).toHaveBeenCalledOnce();
  controller.dispose();
});

test("wheel input uses the selected attachment and stops while hidden", async () => {
  const controller = createShell(document.createElement("div"), vi.fn());
  await waitFor(() => {
    expect(mock.focus).toHaveBeenCalled();
  });
  const wheel = mock.wheel.mock.calls[0]?.[0];
  wheel?.(new WheelEvent("wheel", { deltaY: 14 }));
  expect(mock.input).toHaveBeenLastCalledWith("one", "\x1b[B", "wheel");
  await controller.hide();
  mock.input.mockClear();
  wheel?.(new WheelEvent("wheel", { deltaY: 14 }));
  expect(mock.input).not.toHaveBeenCalled();
  controller.dispose();
});

test("saved terminal size loads, follows live changes and unsubscribes on disposal", async () => {
  mock.setupState.mockResolvedValueOnce(
    setupState({ terminalFontSize: 20, terminalFont: "Initial Mono" }),
  );
  const controller = createShell(document.createElement("div"), vi.fn(), false, undefined, false);
  await Promise.resolve();
  expect(mock.options.fontSize).toBe(20);
  expect(mock.options.fontFamily).toBe(
    '"Initial Mono", "Hack Nerd Font Mono", "Geist Mono", monospace',
  );
  await controller.open("font-session");
  mock.resize.mockClear();
  const change = mock.onSetupChange.mock.calls[0]?.[0];
  change?.(setupState({ terminalFontSize: 24, terminalFont: "Live Mono" }));
  expect(mock.options.fontFamily).toBe(
    '"Live Mono", "Hack Nerd Font Mono", "Geist Mono", monospace',
  );
  expect(mock.options.fontSize).toBe(24);
  expect(mock.resize).toHaveBeenCalledWith("font-session", 80, 24);
  mock.resize.mockClear();
  change?.(setupState({ terminalFontSize: 24, terminalFont: "Another Mono" }));
  expect(mock.options.fontFamily).toBe(
    '"Another Mono", "Hack Nerd Font Mono", "Geist Mono", monospace',
  );
  expect(mock.resize).toHaveBeenCalledWith("font-session", 80, 24);
  mock.resize.mockClear();
  change?.(setupState({ terminalFontSize: 24, terminalFont: 'bad"' }));
  expect(mock.options.fontFamily).toBe('"Hack Nerd Font Mono", "Geist Mono", monospace');
  expect(mock.resize).toHaveBeenCalledWith("font-session", 80, 24);
  await controller.hide();
  mock.resize.mockClear();
  change?.(setupState({ terminalFontSize: 16 }));
  expect(mock.options.fontSize).toBe(16);
  expect(mock.resize).not.toHaveBeenCalled();
  controller.dispose();
  expect(mock.offSetup).toHaveBeenCalledOnce();
  change?.(setupState({ terminalFontSize: 30 }));
  expect(mock.options.fontSize).toBe(16);
});

test("late initial settings cannot replace a live font change or touch a disposed terminal", async () => {
  let finish: (state: SetupState) => void = () => {};
  mock.setupState.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const controller = createShell(document.createElement("div"), vi.fn(), false, undefined, false);
  mock.onSetupChange.mock.calls[0]?.[0](setupState({ terminalFontSize: 22 }));
  finish(setupState());
  await Promise.resolve();
  expect(mock.options.fontSize).toBe(22);
  controller.dispose();
  mock.setupState.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const disposed = createShell(document.createElement("div"), vi.fn(), false, undefined, false);
  disposed.dispose();
  finish(setupState({ terminalFontSize: 32 }));
  await Promise.resolve();
  expect(mock.options.fontSize).toBe(14);
  mock.setupState.mockRejectedValueOnce(new Error("Unavailable"));
  const fallback = createShell(document.createElement("div"), vi.fn(), false, undefined, false);
  await fallback.open("defaults");
  expect(mock.options.fontSize).toBe(14);
  fallback.dispose();
});

test("font changes during an attachment refit once it is safe to resize", async () => {
  let finish: () => void = () => {};
  mock.attach.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const controller = createShell(document.createElement("div"), vi.fn(), false, undefined, false);
  const opening = controller.open("font-pending");
  await waitFor(() => {
    expect(mock.attach).toHaveBeenCalled();
  });
  mock.resize.mockClear();
  mock.onSetupChange.mock.calls[0]?.[0](setupState({ terminalFontSize: 24 }));
  expect(mock.resize).not.toHaveBeenCalled();
  finish();
  await opening;
  expect(mock.resize).toHaveBeenCalledWith("font-pending", 80, 24);
  mock.resize.mockClear();
  mock.onSetupChange.mock.calls[0]?.[0](setupState({ terminalFontSize: 24 }));
  expect(mock.resize).not.toHaveBeenCalled();
  controller.dispose();
});

test("selection recovers from a removed terminal whose detach capability was revoked", async () => {
  const update = vi.fn();
  const controller = createShell(document.createElement("div"), update, false);
  await controller.open("removed");
  mock.detach.mockRejectedValueOnce(new Error("Unknown or foreign terminal ID"));
  await controller.open("remaining");
  expect(controller.owns("removed")).toBe(false);
  expect(mock.attach).toHaveBeenLastCalledWith("remaining");
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }));
  mock.onInput.mock.calls[0]?.[0]("hello");
  expect(mock.input).toHaveBeenCalledWith("remaining", "hello");
  controller.dispose();
});

test("live terminal themes update shared colors and fixed palettes ignore interface changes", async () => {
  mock.setupState.mockResolvedValueOnce(setupState({ terminalTheme: "dracula" }));
  const controller = createShell(document.createElement("div"), vi.fn());
  await vi.waitFor(() => {
    expect(mock.options.theme?.background).toBe("#282a36");
  });
  expect(document.documentElement.style.getPropertyValue("--terminal-background")).toBe("#282a36");
  mock.dark = !mock.dark;
  mock.change.mock.calls[0]?.[1]();
  expect(mock.options.theme?.background).toBe("#282a36");
  mock.onSetupChange.mock.calls[0]?.[0](setupState({ terminalTheme: "solarized-light" }));
  expect(mock.options.theme?.background).toBe("#fdf6e3");
  mock.onSetupChange.mock.calls[0]?.[0](
    setupState(
      { terminalTheme: "user:live.json" },
      {
        themes: {
          interface: [],
          terminal: [{ id: "user:live.json", name: "Live", theme: terminalThemes.dracula }],
          errors: [],
        },
      },
    ),
  );
  expect(mock.options.theme?.background).toBe("#282a36");
  mock.onSetupChange.mock.calls[0]?.[0](setupState({ terminalTheme: "user:missing.json" }));
  expect(mock.options.theme?.background).toBe(mock.dark ? "#05040a" : "#f3f0fa");
  mock.onSetupChange.mock.calls[0]?.[0](setupState({ terminalTheme: "solarized-light" }));
  controller.dispose();
  mock.onSetupChange.mock.calls[0]?.[0](setupState({ terminalTheme: "follow" }));
  expect(mock.options.theme?.background).toBe("#fdf6e3");
});

test("passive tile controllers neither steal focus nor detach another view after being hidden", async () => {
  const container = document.createElement("div");
  const controller = createShell(container, vi.fn(), false, undefined, false, false);
  await controller.hide();
  expect(container.hidden).toBe(true);
  await controller.open("one");
  expect(container.hidden).toBe(false);
  await controller.open("one");
  expect(mock.focus).not.toHaveBeenCalled();
  expect(mock.attach).toHaveBeenCalledOnce();
  await controller.hide();
  // Another controller may now own this terminal's new attachment.
  mock.detach.mockClear();
  controller.dispose();
  expect(mock.detach).not.toHaveBeenCalled();
  expect(mock.kill).not.toHaveBeenCalled();
});

test("removed terminals release locally; hiding and queued opening never touch revoked IDs", async () => {
  let live = true;
  const controller = createShell(
    document.createElement("div"),
    vi.fn(),
    false,
    undefined,
    false,
    false,
    () => live,
  );
  await controller.open("gone");
  live = false;
  controller.release("unrelated");
  controller.release("gone");
  await expect(controller.hide()).resolves.toBeUndefined();
  await controller.open("gone");
  expect(mock.attach).toHaveBeenCalledTimes(1);
  expect(mock.detach).not.toHaveBeenCalled();
  controller.dispose();
  expect(mock.detach).not.toHaveBeenCalled();
});
test("selecting after a hidden terminal never detaches the old view twice", async () => {
  const controller = createShell(document.createElement("div"), vi.fn(), false, undefined, false);
  await controller.open("one");
  await controller.hide();
  mock.detach.mockClear();
  await controller.open("two");
  expect(mock.detach).not.toHaveBeenCalled();
  controller.dispose();
});

test("main removal revokes active and queued views without detach, including shutdown", async () => {
  const controller = createShell(document.createElement("div"), vi.fn(), false, undefined, false);
  await controller.open("one");
  mock.onTerminalAvailability.mock.calls[0]?.[0]("one", false);
  await controller.hide();
  await controller.open("one");
  expect(mock.detach).not.toHaveBeenCalled();
  expect(mock.attach).toHaveBeenCalledOnce();
  controller.dispose();
});

test("failed shutdown restores the previous view unless the user changed selection", async () => {
  const controller = createShell(document.createElement("div"), vi.fn(), false, undefined, false);
  await controller.open("one");
  const availability = mock.onTerminalAvailability.mock.calls[0]?.[0];
  availability?.("one", false);
  availability?.("other", true);
  availability?.("one", true);
  await vi.waitFor(() => {
    expect(mock.attach).toHaveBeenCalledTimes(2);
  });
  availability?.("one", false);
  await controller.open("two");
  availability?.("one", true);
  await Promise.resolve();
  expect(mock.attach).toHaveBeenLastCalledWith("two");
  controller.dispose();
});

test("a fresh incarnation of an exited terminal discards its old exit state", async () => {
  const update = vi.fn();
  const controller = createShell(document.createElement("div"), update, false);
  await controller.open("agent-a");
  mock.onExit.mock.calls[0]?.[0]("agent-a", 7);
  await controller.hide();
  mock.onTerminalAvailability.mock.calls[0]?.[0]("agent-a", false);
  mock.onTerminalAvailability.mock.calls[0]?.[0]("agent-a", true, true);
  await controller.open("agent-a");
  expect(update).toHaveBeenLastCalledWith(
    expect.objectContaining({ state: "quiet_ok", status: "Terminal" }),
  );
  controller.dispose();
});

test("view controls preserve an application's steady cursor until the next snapshot", async () => {
  const controller = createShell(document.createElement("div"), vi.fn());
  await waitFor(() => {
    expect(mock.focus).toHaveBeenCalled();
  });
  // DEC mode 12 updates xterm's option, independently of DECSCUSR overrides.
  mock.options.cursorBlink = false;
  await controller.open("one");
  expect(mock.options.cursorBlink).toBe(false);
  await controller.hide();
  expect(mock.options.cursorBlink).toBe(false);
  controller.dispose();
});

test("exit disables input and hides the cursor across snapshots, reopening and restart", async () => {
  const controller = createShell(document.createElement("div"), vi.fn());
  await waitFor(() => {
    expect(mock.focus).toHaveBeenCalled();
  });
  const exit = mock.onExit.mock.calls[0]?.[0];
  const data = mock.onData.mock.calls[0]?.[0];
  const input = mock.onInput.mock.calls[0]?.[0];
  exit?.("one", 0);
  expect(mock.options.disableStdin).toBe(true);
  expect(mock.options.cursorBlink).toBe(false);
  expect(mock.write).toHaveBeenLastCalledWith("\x1b[?25l");
  input?.("ignored");
  mock.wheel.mock.calls[0]?.[0](new WheelEvent("wheel", { deltaY: 1, deltaMode: 1 }));
  expect(mock.input).not.toHaveBeenCalled();
  data?.("one", "final", "last output\x1b[?25h");
  expect(mock.write).toHaveBeenLastCalledWith(
    "last output\x1b[?25h\x1b[?25l",
    expect.any(Function),
  );
  expect(mock.acknowledge).toHaveBeenLastCalledWith("one", "final", 17);
  await controller.hide();
  await controller.open("one");
  expect(mock.options.disableStdin).toBe(true);
  expect(mock.options.cursorBlink).toBe(false);
  mock.create.mockResolvedValue({ id: "two", title: "bash" });
  await controller.restart();
  expect(mock.options.disableStdin).toBe(false);
  expect(mock.options.cursorBlink).toBe(true);
  input?.("working");
  expect(mock.input).toHaveBeenLastCalledWith("two", "working");
  controller.dispose();
});

test("a newly mounted view knows an already exited session and can switch to a live one", async () => {
  const controller = createShell(
    document.createElement("div"),
    vi.fn(),
    false,
    undefined,
    false,
    false,
    () => true,
    (id) => id === "old",
  );
  await controller.open("old");
  expect(mock.options.disableStdin).toBe(true);
  expect(mock.options.cursorBlink).toBe(false);
  expect(mock.write).toHaveBeenLastCalledWith("\x1b[?25l");
  await controller.open("live");
  expect(mock.options.disableStdin).toBe(false);
  expect(mock.options.cursorBlink).toBe(true);
  controller.dispose();
});

test("sidebar motion fits the final frame once and cancels pending fits on interruption or disposal", async () => {
  class SidebarTransition extends Event {
    propertyName: string;
    constructor(type: string, propertyName: string) {
      super(type, { bubbles: true });
      this.propertyName = propertyName;
    }
  }
  vi.stubGlobal("TransitionEvent", SidebarTransition);
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  const cancel = vi.fn(() => {
    frame = undefined;
  });
  vi.stubGlobal("cancelAnimationFrame", cancel);
  const board = document.createElement("div");
  board.className = "board-home";
  const sidebar = document.createElement("aside");
  sidebar.className = "sidebar-shell";
  let running = true;
  Object.defineProperty(sidebar, "getAnimations", {
    value: () => (running ? [{ playState: "running" }] : []),
  });
  const container = document.createElement("div");
  board.append(sidebar, container);
  document.body.append(board);
  const controller = createShell(container, vi.fn(), false, undefined, false);
  await controller.open("moving-sidebar");
  mock.fit.mockClear();
  const observer = mock.resizeCallback.mock.lastCall?.[0];
  observer?.();
  sidebar.dispatchEvent(new SidebarTransition("transitionrun", "flex-basis"));
  running = false;
  sidebar.dispatchEvent(new SidebarTransition("transitionend", "color"));
  observer?.();
  expect(mock.fit).not.toHaveBeenCalled();
  sidebar.dispatchEvent(new SidebarTransition("transitionend", "flex-basis"));
  observer?.();
  sidebar.dispatchEvent(new SidebarTransition("transitionrun", "flex-basis"));
  expect(cancel).toHaveBeenCalledWith(1);
  sidebar.dispatchEvent(new SidebarTransition("transitioncancel", "flex-basis"));
  mock.fitCols = 90;
  frame?.(0);
  observer?.();
  expect(mock.fit).toHaveBeenCalledOnce();
  sidebar.dispatchEvent(new SidebarTransition("transitionend", "flex-basis"));
  controller.dispose();
  expect(cancel).toHaveBeenCalledTimes(2);
  board.remove();
  vi.unstubAllGlobals();
});

test("subpixel geometry changes only resize the host when the fitted grid changes", async () => {
  const container = document.createElement("div");
  let width = 600;
  let height = 400;
  vi.spyOn(container, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 0, width, height),
  );
  const controller = createShell(container, vi.fn(), false, undefined, false);
  await controller.open("subpixel-grid");
  mock.resize.mockClear();
  const observe = mock.resizeCallback.mock.lastCall?.[0];
  observe?.();
  width += 0.01;
  observe?.();
  expect(mock.resize).not.toHaveBeenCalled();
  mock.fitCols = 90;
  width += 1;
  observe?.();
  expect(mock.resize).toHaveBeenCalledExactlyOnceWith("subpixel-grid", 90, 24);
  mock.fitRows = 30;
  height += 1;
  observe?.();
  expect(mock.resize).toHaveBeenLastCalledWith("subpixel-grid", 90, 30);
  controller.dispose();
});

test("sidebar dragging defers all terminal fits until release and ignores duplicate completion", async () => {
  const board = document.createElement("div");
  board.className = "board-home";
  const sidebar = document.createElement("aside");
  sidebar.className = "sidebar-shell";
  sidebar.getAnimations = () => [];
  const container = document.createElement("div");
  board.append(sidebar, container);
  document.body.append(board);
  const controller = createShell(container, vi.fn(), false, undefined, false);
  await controller.open("dragging-sidebar");
  mock.fit.mockClear();
  mock.resize.mockClear();
  const observer = mock.resizeCallback.mock.lastCall?.[0];
  sidebar.dataset["resizing"] = "true";
  mock.fitCols = 70;
  observer?.();
  mock.fitCols = 60;
  observer?.();
  expect(mock.fit).not.toHaveBeenCalled();
  delete sidebar.dataset["resizing"];
  sidebar.dispatchEvent(new Event("sidebar-resize-end", { bubbles: true }));
  observer?.();
  sidebar.dispatchEvent(new Event("sidebar-resize-end", { bubbles: true }));
  expect(mock.fit).toHaveBeenCalledOnce();
  expect(mock.resize).toHaveBeenCalledExactlyOnceWith("dragging-sidebar", 60, 24);
  controller.dispose();
  board.remove();
});

test("renderer fallback refits the attached grid without resetting or reattaching", async () => {
  const controller = createShell(document.createElement("div"), vi.fn());
  await waitFor(() => {
    expect(mock.focus).toHaveBeenCalled();
  });
  const fitCount = mock.fit.mock.calls.length;
  const attaches = mock.attach.mock.calls.length;
  const resets = mock.reset.mock.calls.length;
  mock.webglFallback.mock.calls[0]?.[0]();
  expect(mock.fit).toHaveBeenCalledTimes(fitCount + 1);
  expect(mock.resize).toHaveBeenLastCalledWith("one", 80, 24);
  expect(mock.attach).toHaveBeenCalledTimes(attaches);
  expect(mock.reset).toHaveBeenCalledTimes(resets);
  controller.dispose();
});

test("first frame follows parsed attachment data and a render without loading again on reshow", async () => {
  const update = vi.fn<(view: ShellView) => void>();
  const element = document.createElement("div");
  document.body.append(element);
  const shell = createShell(element, update, false, undefined, false);
  await shell.open("restored");
  const renderFrame = mock.onRender.mock.calls[0]?.[0];
  const data = mock.onData.mock.calls[0]?.[0];
  renderFrame?.();
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ firstFrame: false }));
  mock.write.mockImplementation(() => {});
  data?.("restored", "snapshot", "first screen");
  renderFrame?.();
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ firstFrame: false }));
  mock.write.mock.lastCall?.[1]?.();
  renderFrame?.();
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ firstFrame: true }));
  const staleParsed = mock.write.mock.lastCall?.[1];
  mock.write.mockImplementation((_data, done) => done?.());
  const count = update.mock.calls.length;
  renderFrame?.();
  expect(update).toHaveBeenCalledTimes(count);
  await shell.hide();
  expect(update).toHaveBeenLastCalledWith(
    expect.objectContaining({ firstFrame: true, attaching: false }),
  );
  update.mockClear();
  await shell.open("restored");
  expect(update.mock.calls.every(([view]) => !view.attaching)).toBe(true);
  // Switching sessions needs a new snapshot, and ignores delayed writes.
  await shell.open("another");
  staleParsed?.();
  renderFrame?.();
  expect(update).toHaveBeenLastCalledWith(
    expect.objectContaining({ firstFrame: false, attaching: true }),
  );
  shell.dispose();
  expect(mock.offRender).toHaveBeenCalledOnce();
});

test.each([false, true])(
  "host failure ends attachment loading (already rendered: %s)",
  async (rendered) => {
    const update = vi.fn<(view: ShellView) => void>();
    const shell = createShell(document.createElement("div"), update, false, undefined, false);
    await shell.open("restored");
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ attaching: true }));
    if (rendered) {
      mock.onData.mock.calls[0]?.[0]("restored", "snapshot", "screen");
      mock.onRender.mock.calls[0]?.[0]();
    }
    mock.onExit.mock.calls[0]?.[0]("restored", -1);
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        attaching: false,
        status: "Terminal host failed. Restart the shell to continue.",
        state: "failed",
      }),
    );
    shell.dispose();
  },
);

test("attachment rejection ends loading and retains the failure status", async () => {
  mock.attach.mockRejectedValue(new Error("Attachment failed"));
  const update = vi.fn<(view: ShellView) => void>();
  const shell = createShell(document.createElement("div"), update, false, undefined, false);
  await shell.open("restored");
  expect(update).toHaveBeenLastCalledWith(
    expect.objectContaining({
      attaching: false,
      status: "Unable to open terminal",
    }),
  );
  shell.dispose();
});

test("macOS controllers paste only while ready and dispose selection listeners", async () => {
  const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  const offSelection = vi.fn();
  mock.onSelectionChange.mockReturnValue({ dispose: offSelection });
  mock.getSelection.mockReturnValue("LAST_SELECTION");
  const container = document.createElement("div");
  const controller = createShell(container, vi.fn(), false, undefined, false);
  await controller.open("a");
  terminalSelectionBuffer.setEnabled(true);
  mock.onSelectionChange.mock.calls[1]?.[0]();
  expect(terminalSelectionBuffer.read()).toBe("LAST_SELECTION");
  container.dispatchEvent(new MouseEvent("auxclick", { button: 1 }));
  expect(mock.paste).toHaveBeenCalledWith("LAST_SELECTION");
  await controller.hide();
  mock.paste.mockClear();
  container.dispatchEvent(new MouseEvent("auxclick", { button: 1 }));
  expect(mock.paste).not.toHaveBeenCalled();
  controller.dispose();
  expect(offSelection).toHaveBeenCalledTimes(2);
  terminalSelectionBuffer.setEnabled(false);
  platform.mockRestore();
});

test("copy preference updates reach attached terminal selections and stop while hidden", async () => {
  const copy = vi.fn(() => Promise.resolve());
  Object.assign(mock, { copyTerminalSelection: copy });
  mock.getSelection.mockReturnValue("SELECTED");
  const controller = createShell(document.createElement("div"), vi.fn(), false, undefined, false);
  await controller.open("a");
  const change = mock.onSelectionChange.mock.calls[0]?.[0];
  change?.();
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(copy).not.toHaveBeenCalled();
  mock.onSetupChange.mock.calls[0]?.[0](setupState({ copyOnSelect: true }));
  change?.();
  await waitFor(() => {
    expect(copy).toHaveBeenCalledWith("a", "SELECTED");
  });
  await controller.hide();
  copy.mockClear();
  change?.();
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(copy).not.toHaveBeenCalled();
  controller.dispose();
});

test("persistent controllers bound exit and removal caches across 200 closed sessions", async () => {
  const mapSpy = vi.spyOn(Map.prototype, "set");
  const setSpy = vi.spyOn(Set.prototype, "add");
  const controllers = Array.from({ length: 8 }, () =>
    createShell(document.createElement("div"), vi.fn(), false, undefined, false),
  );
  try {
    for (let i = 0; i < 200; i++) {
      const id = `cache-session-${String(i)}`;
      const controller = controllers[i % controllers.length];
      await controller?.open(id);
      for (const [receive] of mock.onExit.mock.calls) receive(id, 0);
      for (const [receive] of mock.onTerminalAvailability.mock.calls) receive(id, false);
      controller?.release(id);
    }
    const caches = new Set([
      ...mapSpy.mock.contexts.filter((cache, index): cache is Map<unknown, unknown> => {
        const key: unknown = mapSpy.mock.calls[index]?.[0];
        return cache instanceof Map && typeof key === "string" && key.startsWith("cache-session-");
      }),
      ...setSpy.mock.contexts.filter((cache, index): cache is Set<unknown> => {
        const key: unknown = setSpy.mock.calls[index]?.[0];
        return cache instanceof Set && typeof key === "string" && key.startsWith("cache-session-");
      }),
    ]);
    expect(Math.max(...[...caches].map((cache) => cache.size))).toBe(0);
  } finally {
    mapSpy.mockRestore();
    setSpy.mockRestore();
    for (const controller of controllers) controller.dispose();
  }
});

test("an initial shell launch preserves exit evidence for a queued selection", async () => {
  const created = Promise.withResolvers<{ id: string; title: string }>();
  mock.create.mockReturnValueOnce(created.promise);
  const update = vi.fn();
  const controller = createShell(document.createElement("div"), update, false);
  const opening = controller.open("queued");
  await vi.waitFor(() => {
    expect(mock.create).toHaveBeenCalled();
  });
  mock.onExit.mock.calls[0]?.[0]("queued", 4);
  created.resolve({ id: "one", title: "Shell" });
  await opening;
  expect(update).toHaveBeenLastCalledWith(
    expect.objectContaining({ state: "failed", status: "Terminal exited (4)" }),
  );
  controller.dispose();
});

test("releasing an exited session discards evidence before an unselected host reset", async () => {
  const update = vi.fn();
  const controller = createShell(document.createElement("div"), update, false, undefined, false);
  await controller.open("resumed");
  mock.onExit.mock.calls[0]?.[0]("resumed", 4);
  controller.release("resumed");
  mock.onTerminalAvailability.mock.calls[0]?.[0]("resumed", true, true);
  await controller.open("resumed");
  expect(update).toHaveBeenLastCalledWith(
    expect.objectContaining({ state: "quiet_ok", status: "Terminal" }),
  );
  mock.onInput.mock.calls[0]?.[0]("q");
  expect(mock.input).toHaveBeenCalledWith("resumed", "q");
  const pending = controller.open("queued");
  controller.release("queued");
  await pending;
  expect(mock.attach).not.toHaveBeenCalledWith("queued");
  mock.onTerminalAvailability.mock.calls[0]?.[0]("resumed", false);
  controller.release("resumed");
  mock.onTerminalAvailability.mock.calls[0]?.[0]("resumed", true);
  await controller.open("resumed");
  controller.dispose();
});

test("shared paste capability inserts once and ignores responses after the view switches", async () => {
  const container = document.createElement("div");
  const update = vi.fn();
  const controller = createShell(container, update, false, undefined, false);
  await controller.open("one");
  mock.pasteTerminal.mockResolvedValue({ kind: "text", text: "[pasted image '/tmp/image.png'] " });
  await controller.paste();
  expect(mock.paste).toHaveBeenCalledExactlyOnceWith("[pasted image '/tmp/image.png'] ");
  mock.paste.mockClear();
  for (const kind of ["unsupported", "failed", "empty", "cancelled"]) {
    mock.pasteTerminal.mockResolvedValue({ kind });
    await controller.paste();
  }
  expect(mock.paste).not.toHaveBeenCalled();
  mock.pasteTerminal.mockRejectedValueOnce(new Error("private"));
  await controller.paste();
  expect(update).toHaveBeenLastCalledWith(
    expect.objectContaining({ pasteResult: "Unable to paste clipboard contents." }),
  );
  const delayed = Promise.withResolvers<unknown>();
  mock.pasteTerminal.mockReturnValueOnce(delayed.promise);
  const pending = controller.paste();
  await controller.open("two");
  delayed.resolve({ kind: "text", text: "late" });
  await pending;
  expect(mock.paste).not.toHaveBeenCalled();
  mock.pasteTerminal.mockResolvedValue({ kind: "text", text: "native" });
  container.dispatchEvent(new Event("paste", { cancelable: true }));
  await vi.waitFor(() => {
    expect(mock.paste).toHaveBeenCalledWith("native");
  });
  const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux");
  mock.pasteTerminal.mockClear();
  container.dispatchEvent(new MouseEvent("mousedown", { button: 1 }));
  container.dispatchEvent(new Event("paste"));
  expect(mock.pasteTerminal).not.toHaveBeenCalled();
  container.dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true }));
  container.dispatchEvent(new Event("paste"));
  await Promise.resolve();
  expect(mock.pasteTerminal).toHaveBeenCalledWith("two");
  platform.mockRestore();
  await controller.hide();
  mock.pasteTerminal.mockClear();
  await controller.paste();
  expect(mock.pasteTerminal).not.toHaveBeenCalled();
  controller.dispose();
});

test("image-only platform paste shortcut never reaches the raw terminal control byte", async () => {
  const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux");
  const controller = createShell(document.createElement("div"), vi.fn(), false, undefined, false);
  await controller.open("one");
  mock.pasteTerminal.mockResolvedValue({ kind: "empty" });
  const key = mock.key.mock.calls.at(-1)?.[0];
  expect(key?.(new KeyboardEvent("keydown", { key: "v", ctrlKey: true }))).toBe(false);
  await Promise.resolve();
  expect(mock.pasteTerminal).toHaveBeenCalledWith("one");
  mock.pasteTerminal.mockClear();
  expect(key?.(new KeyboardEvent("keyup", { key: "v", ctrlKey: true }))).toBe(false);
  expect(mock.pasteTerminal).not.toHaveBeenCalled();
  expect(key?.(new KeyboardEvent("keydown", { key: "x", ctrlKey: true }))).toBe(true);
  platform.mockReturnValue("MacIntel");
  expect(key?.(new KeyboardEvent("keydown", { key: "v", metaKey: true }))).toBe(false);
  await Promise.resolve();
  expect(mock.pasteTerminal).toHaveBeenCalledWith("one");
  controller.dispose();
  platform.mockRestore();
});

// Exercise the real parser behind the browser/layout adapter. Compatible older
// daemons can keep sessions alive across a UI upgrade and omit DECTCEM in replay.
test.each([
  { name: "older compatible host", legacy: true, hidden: false },
  { name: "current visible host", legacy: false, hidden: false },
  { name: "current hidden alternate-buffer TUI", legacy: false, hidden: true },
])("reused cursor visibility follows $name snapshots", async ({ legacy, hidden }) => {
  const host = new HeadlessTerminal({ cursorBlink: true, allowProposedApi: true });
  const view = new HeadlessTerminal({ cursorBlink: true, allowProposedApi: true });
  const serialize = new SerializeAddon();
  host.loadAddon(serialize);
  const write = (terminal: HeadlessTerminal, data: string) =>
    new Promise<void>((resolve) => {
      terminal.write(data, resolve);
    });
  const expectHidden = async (hidden: boolean) => {
    let reply = "";
    const subscription = view.onData((data) => {
      reply += data;
    });
    try {
      await write(view, "\x1b[?25$p");
      expect(reply).toBe(`\x1b[?25;${hidden ? "2" : "1"}$y`);
    } finally {
      subscription.dispose();
    }
  };
  mock.write.mockImplementation((data, done) => {
    view.write(data, done);
  });
  mock.reset.mockImplementation(() => {
    view.reset();
  });
  const controller = createShell(
    document.createElement("div"),
    vi.fn(),
    false,
    undefined,
    false,
    false,
    () => true,
    (id) => id === "exited",
  );
  try {
    await controller.open("exited");
    await expectHidden(true);
    await write(host, `${hidden ? "\x1b[?1049h\x1b[?25l" : ""}prompt$ `);
    // Wire fixture from the 0e051540 helper for this default-margin normal
    // screen. Freeze the old bytes so future addon changes cannot mask compatibility.
    const snapshot = legacy ? "prompt$ \x1b[?12h\x1b[0 q" : terminalSnapshot(host, serialize);
    const receive = mock.onData.mock.calls[0]?.[0];
    if (!receive) throw new Error("Missing terminal data subscription");
    mock.attach.mockImplementation((id: string) => {
      receive(id, "snapshot", `\x1bc${snapshot}`);
      return Promise.resolve();
    });
    await controller.open("live-remote");
    await expectHidden(hidden);
    expect(mock.options.disableStdin).toBe(false);
    expect(mock.options.cursorBlink).toBe(true);
    // Reattachment resets the same view too; explicit application hiding wins.
    await controller.hide();
    await controller.open("live-remote");
    await expectHidden(hidden);
  } finally {
    controller.dispose();
    mock.reset.mockReset();
    host.dispose();
    view.dispose();
  }
});

// Frozen snapshots captured with the 0e051540 helper. That host never emits
// DECTCEM, so same-session replay must retain application visibility locally.
test.each([
  { alternate: false, snapshot: "app screen\x1b[?12h\x1b[0 q" },
  { alternate: true, snapshot: "\x1b[?1049h\x1b[Happ screen\x1b[?12h\x1b[0 q" },
])(
  "compatible old host keeps application cursor hidden on reattach (alternate=$alternate)",
  async ({ alternate, snapshot }) => {
    const view = new HeadlessTerminal({ cursorBlink: true, allowProposedApi: true });
    const write = (data: string) =>
      new Promise<void>((resolve) => {
        view.write(data, resolve);
      });
    const expectHidden = async (hidden: boolean) => {
      let reply = "";
      const subscription = view.onData((data) => {
        reply += data;
      });
      try {
        await write("\x1b[?25$p");
        expect(reply).toBe(`\x1b[?25;${hidden ? "2" : "1"}$y`);
      } finally {
        subscription.dispose();
      }
    };
    mock.write.mockImplementation((data, done) => {
      view.write(data, done);
    });
    mock.reset.mockImplementation(() => {
      view.reset();
    });
    const controller = createShell(
      document.createElement("div"),
      vi.fn(),
      false,
      undefined,
      false,
      false,
    );
    try {
      const receive = mock.onData.mock.calls[0]?.[0];
      if (!receive) throw new Error("Missing terminal data subscription");
      let replay = "";
      mock.attach.mockImplementation((id: string) => {
        receive(id, "snapshot", `\x1bc${replay}`);
        return Promise.resolve();
      });
      await controller.open("live");
      receive("live", "output", `${alternate ? "\x1b[?1049h" : ""}app screen\x1b[?25l`);
      await expectHidden(true);
      expect(snapshot).not.toContain("\x1b[?25");
      replay = snapshot;
      await controller.hide();
      await controller.open("live");
      await expectHidden(true);
      // A different live session must not inherit the previous application's hide.
      await controller.open("another-live");
      await expectHidden(false);
      // An exited view must not transfer its forced hide to a relaunched live PTY.
      mock.onExit.mock.calls[0]?.[0]("another-live", 0);
      await expectHidden(true);
      mock.onTerminalAvailability.mock.calls[0]?.[0]("another-live", true, true);
      await controller.hide();
      await controller.open("another-live");
      await expectHidden(false);
    } finally {
      controller.dispose();
      mock.reset.mockReset();
      view.dispose();
    }
  },
);
