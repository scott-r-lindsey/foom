import { mock, start, quitting } from "./main-fixture";
import { expect, test, vi } from "vitest";

test("window close requests the same quit path without destroying the window", async () => {
  await start();
  const event = { preventDefault: vi.fn() };
  mock.windowEvents.get("close")?.(event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(mock.quit).not.toHaveBeenCalled();
  await vi.waitFor(() => {
    expect(mock.quit).toHaveBeenCalledOnce();
  });
});

test.each([1, 3])(
  "cancel preserves %s running terminals and permits another attempt",
  async (count) => {
    mock.terminals.runningCount = count;
    await start();
    expect(quitting().preventDefault).toHaveBeenCalledOnce();
    expect(mock.message).toHaveBeenCalledWith(
      expect.objectContaining({
        title: `Quit with ${String(count)} ${count === 1 ? "terminal" : "terminals"} running?`,
        accept: "Stop all and quit",
      }),
    );
    await vi.waitFor(() => {
      expect(mock.message).toHaveResolved();
    });
    expect(mock.terminals.shutdown).not.toHaveBeenCalled();
    expect(mock.quit).not.toHaveBeenCalled();
    quitting();
    expect(mock.message).toHaveBeenCalledTimes(2);
  },
);

test("confirmed quit waits for termination, suppresses duplicate requests, then allows closing", async () => {
  mock.terminals.runningCount = 2;
  let confirm: (value: { response: number }) => void = () => {};
  let stop: () => void = () => {};
  mock.message.mockReturnValue(
    new Promise((resolve) => {
      confirm = resolve;
    }),
  );
  mock.terminals.shutdown.mockReturnValue(
    new Promise((resolve) => {
      stop = resolve;
    }),
  );
  await start();
  quitting();
  quitting();
  expect(mock.message).toHaveBeenCalledOnce();
  confirm({ response: 1 });
  await vi.waitFor(() => {
    expect(mock.terminals.shutdown).toHaveBeenCalledOnce();
  });
  quitting();
  expect(mock.message).toHaveBeenCalledOnce();
  expect(mock.quit).not.toHaveBeenCalled();
  stop();
  await vi.waitFor(() => {
    expect(mock.quit).toHaveBeenCalledOnce();
  });
  expect(quitting().preventDefault).not.toHaveBeenCalled();
  const close = { preventDefault: vi.fn() };
  mock.windowEvents.get("close")?.(close);
  expect(close.preventDefault).not.toHaveBeenCalled();
});

test("quits without a confirmation when no PTYs are running", async () => {
  await start();
  quitting();
  await vi.waitFor(() => {
    expect(mock.quit).toHaveBeenCalledOnce();
  });
  expect(mock.message).not.toHaveBeenCalled();
  expect(mock.terminals.shutdown).toHaveBeenCalledOnce();
});

test.each(["dialog", "shutdown"])(
  "keeps the app open and allows retry after %s failure",
  async (failure) => {
    mock.terminals.runningCount = 1;
    const error = new Error("failed");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mock.message.mockResolvedValue({ response: 1 });
    if (failure === "dialog") mock.message.mockRejectedValueOnce(error);
    else mock.terminals.shutdown.mockRejectedValueOnce(error);
    await start();
    quitting();
    await vi.waitFor(() => {
      expect(mock.errorBox).toHaveBeenCalledOnce();
    });
    expect(log).toHaveBeenCalledWith("Unable to quit the application:", error);
    expect(mock.quit).not.toHaveBeenCalled();
    quitting();
    await vi.waitFor(() => {
      expect(mock.quit).toHaveBeenCalledOnce();
    });
  },
);

test.each([
  { platform: "darwin", key: "w", meta: true, control: false, alt: false },
  { platform: "darwin", key: "q", meta: true, control: false, alt: false },
  { platform: "linux", key: "q", meta: false, control: true, alt: false },
  { platform: "win32", key: "F4", meta: false, control: false, alt: true },
] as const)(
  "routes the quit shortcut through app.quit ($platform $key)",
  async ({ platform, ...input }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    await start();
    const event = { preventDefault: vi.fn() };
    mock.windowEvents.get("before-input-event")?.(event, {
      type: "keyDown",
      shift: platform === "linux",
      code: input.key === "F4" ? "F4" : `Key${input.key.toUpperCase()}`,
      ...input,
    });
    expect(event.preventDefault).toHaveBeenCalledOnce();
    if (input.key === "w" || input.key === "F4") expect(mock.window.close).toHaveBeenCalledOnce();
    else expect(mock.quit).toHaveBeenCalledOnce();
  },
);

test("defers an already-idle quit until the native close callback has unwound", async () => {
  await start();
  const event = { preventDefault: vi.fn() };
  mock.windowEvents.get("close")?.(event);
  expect(mock.quit).not.toHaveBeenCalled();
  await vi.waitFor(() => {
    expect(mock.quit).toHaveBeenCalledOnce();
  });
});

test("confirmed quit disposes the workspace only after terminals stop", async () => {
  const order: string[] = [];
  mock.terminals.shutdown.mockImplementation(() => {
    order.push("terminals");
    return Promise.resolve();
  });
  mock.workspace.dispose.mockImplementation(() => {
    order.push("workspace");
    return Promise.resolve();
  });
  await start();
  quitting();
  await vi.waitFor(() => {
    expect(mock.quit).toHaveBeenCalledOnce();
  });
  expect(order).toEqual(["terminals", "workspace"]);
});

test("quit without a board reopens a parent for the running-session confirmation", async () => {
  await start();
  mock.readyEvents.get("closed")?.();
  mock.terminals.runningCount = 1;
  quitting();
  await vi.waitFor(() => {
    expect(mock.message).toHaveBeenCalledOnce();
  });
  expect(mock.instances).toHaveLength(2);
  expect(mock.terminals.shutdown).not.toHaveBeenCalled();
});

test("concurrent windowless quit requests share one parent and recover from a failed load", async () => {
  await start();
  mock.readyEvents.get("closed")?.();
  const error = new Error("Board failed to load");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  mock.window.loadURL.mockRejectedValueOnce(error);
  quitting();
  quitting();
  await vi.waitFor(() => {
    expect(mock.errorBox).toHaveBeenCalledOnce();
  });
  expect(mock.instances).toHaveLength(2);
  expect(log).toHaveBeenCalledWith("Unable to quit the application:", error);
  expect(mock.terminals.shutdown).not.toHaveBeenCalled();
  quitting();
  await vi.waitFor(() => {
    expect(mock.quit).toHaveBeenCalledOnce();
  });
});
