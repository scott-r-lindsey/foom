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
    dark: true,
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
  mock.setupState.mockResolvedValue(setupState());
  mock.onSetupChange.mockReturnValue(mock.offSetup);
  mock.dark = true;
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
  expect(mock.key).not.toHaveBeenCalled();
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
  mock.key.mock.calls[0]?.[0](new KeyboardEvent("keydown", { key: "Escape" }));
  expect(mock.key).not.toHaveBeenCalled();
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
  mock.setupState.mockResolvedValueOnce(setupState({ terminalFontSize: 20 }));
  const controller = createShell(document.createElement("div"), vi.fn(), false, undefined, false);
  await Promise.resolve();
  expect(mock.options.fontSize).toBe(20);
  await controller.open("font-session");
  mock.resize.mockClear();
  const change = mock.onSetupChange.mock.calls[0]?.[0];
  change?.(setupState({ terminalFontSize: 24 }));
  expect(mock.options.fontSize).toBe(24);
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

test("live terminal themes also color peek and fixed palettes ignore interface changes", async () => {
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
  controller.dispose();
  mock.onSetupChange.mock.calls[0]?.[0](setupState({ terminalTheme: "follow" }));
  expect(mock.options.theme?.background).toBe("#fdf6e3");
});

test("passive tile controllers neither steal focus nor detach another view after being hidden", async () => {
  const controller = createShell(
    document.createElement("div"),
    vi.fn(),
    false,
    undefined,
    false,
    false,
  );
  await controller.open("one");
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
