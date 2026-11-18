import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewMock, mock, start, invokeWindow, newWindow } from "./main-fixture";
import type { ShortcutInput } from "./main-fixture";
import { DEFAULT_SETTINGS } from "../../../src/main/setup/settings";

import { expect, test, vi } from "vitest";

test("preview hosts accept standalone roots, notify the board, reconcile and close", async ({
  onTestFinished,
}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foom-preview-root-")));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  previewMock.hosts.length = 0;
  const launchIdentity = vi.fn(async () => {});
  mock.openWorktrees.mockResolvedValue({
    worktreeRoot: "/trees",
    listRepositories: () => [
      { path: "/empty", name: "empty" },
      { path: "/repo", name: "repo" },
    ],
    listWorktrees: (repository: string) =>
      Promise.resolve(repository === "/repo" ? [{ path: "/repo" }, { path: "/tree" }] : []),
    launchIdentity,
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await start();
  const host = previewMock.hosts[0];
  if (!host) throw new Error("Missing preview host");
  const previews = mock.attachWorkspace.mock.calls[0]?.[5];
  if (!previews) throw new Error("Missing preview inventory");
  expect(previews()).toEqual([]);
  await expect(host.validate(root, "plan.md")).resolves.toBeUndefined();
  expect(launchIdentity).not.toHaveBeenCalled();
  await expect(host.validate(join(root, "missing"), "plan.md")).rejects.toThrow();
  host.changed();
  expect(mock.window.webContents.send).toHaveBeenCalledWith("workspace:changed");
  mock.window.webContents.isDestroyed.mockReturnValueOnce(true);
  mock.window.webContents.send.mockClear();
  host.changed();
  expect(mock.window.webContents.send).not.toHaveBeenCalled();
  mock.window.isDestroyed.mockReturnValueOnce(true);
  host.changed();
  expect(mock.window.webContents.send).not.toHaveBeenCalled();
  mock.message.mockResolvedValueOnce({ response: 1 });
  await expect(
    host.confirm({ title: "Open this link?", accept: "Open" }, new AbortController().signal),
  ).resolves.toBe(true);
  await expect(previewMock.pick?.("/tree")).resolves.toBe("a".repeat(32));
  expect(previewMock.pickFile).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.any(Function),
    "/tree",
  );
  const validatePicker = previewMock.pickFile.mock.lastCall?.[2];
  if (!validatePicker) throw new Error("Missing picker validation");
  await expect(validatePicker("/tree")).resolves.toBeUndefined();
  expect(launchIdentity).toHaveBeenCalledWith("/repo", "/tree");
  await expect(validatePicker("/elsewhere")).rejects.toThrow("Unknown preview worktree");
  vi.mocked(host.reconcile).mockRejectedValueOnce(new Error("gone"));
  mock.workspace.deps?.onChange?.();
  await vi.waitFor(() => {
    expect(warn).toHaveBeenCalledWith("Unable to reconcile previews");
  });
  vi.mocked(host.dispose).mockRejectedValueOnce(new Error("busy"));
  mock.readyEvents.get("closed")?.();
  expect(host.dispose).toHaveBeenCalledWith(false, expect.any(Function));
  await vi.waitFor(() => {
    expect(warn).toHaveBeenCalledWith("Unable to close previews");
  });
  warn.mockRestore();
});

test("main preview composition targets the opener's board and releases human-closed ownership", async () => {
  const path = await import("node:path");
  const os = await import("node:os");
  const { ControlRuntime } = await import("../../../src/main/control/runtime");
  const directory = await mkdtemp(path.join(os.tmpdir(), "foom-preview-composition-"));
  const realStart = ControlRuntime.start.bind(ControlRuntime);
  let runtime: Awaited<ReturnType<typeof ControlRuntime.start>> | undefined;
  const initialize = vi.spyOn(ControlRuntime, "start").mockImplementation((_profile, ...args) =>
    realStart(directory, ...args).then((created) => {
      runtime = created;
      return created;
    }),
  );
  try {
    await start();
    const control = mock.workspace.deps?.control;
    if (!control) throw new Error("Missing control startup");
    await control();
    previewMock.humanClose?.("unknown");
    const backend = initialize.mock.calls[0]?.[6];
    if (!backend) throw new Error("Missing preview backend");
    const { previewHosts } = await import("../../../src/main/wiring/application");
    const actor = {
      grantedAt: "2026-10-15T00:00:00.000Z",
      generation: "g",
      sessionId: "s",
      terminalId: "t1",
      parentId: null,
      role: "agent" as const,
      repository: directory,
      worktree: directory,
    };
    const preview = {
      owner: "g",
      previewId: "a".repeat(32),
      session: "s",
      worktree: directory,
      real: path.join(directory, "plan.md"),
      path: "plan.md",
      kind: "markdown" as const,
    };
    await newWindow();
    const second = mock.instances[1];
    if (!second) throw new Error("Missing board");
    mock.window.isFocused.mockReturnValue(false);
    second.isFocused = vi.fn(() => true);
    expect(await backend.open(actor, preview, true)).toBe("sidebar");
    const secondHost = previewHosts.get(second.id);
    if (!secondHost) throw new Error("Missing second host");
    expect(vi.spyOn(secondHost, "open").mock.calls).toHaveLength(1);
    await invokeWindow(0, "windows:sync", ["t1"]);
    expect(await backend.open(actor, preview, true)).toBe("sidebar");
    const firstHost = previewHosts.values().next().value;
    if (!firstHost) throw new Error("Missing first host");
    expect(vi.spyOn(firstHost, "open").mock.calls).toHaveLength(1);
    await invokeWindow(0, "windows:sync", []);
    second.isFocused.mockReturnValue(false);
    expect(await backend.open(actor, preview, true)).toBe("sidebar");
  } finally {
    initialize.mockRestore();
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("worktree removal blocks preview opens and closes every window's previews before Git", async ({
  onTestFinished,
}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foom-preview-removal-")));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  previewMock.hosts.length = 0;
  await start();
  await newWindow();
  const [first, second] = previewMock.hosts;
  const deps = mock.workspace.deps;
  if (!first || !second || !deps?.prepareWorktreeRemoval)
    throw new Error("Missing preview lifecycle");
  const prepare = () => {
    if (!deps.prepareWorktreeRemoval) throw new Error("Missing removal lifecycle");
    return deps.prepareWorktreeRemoval(root);
  };
  await first.validate(root, "page.html");
  const release = await prepare();
  expect(first.closeWorktree).toHaveBeenCalledWith(root);
  expect(second.closeWorktree).toHaveBeenCalledWith(root);
  await expect(first.validate(root, "page.html")).rejects.toThrow("being removed");
  release();
  await first.validate(root, "page.html");
  vi.mocked(second.closeWorktree).mockRejectedValueOnce(new Error("cleanup failed"));
  await expect(prepare()).rejects.toThrow("cleanup failed");
  await expect(first.validate(root, "page.html")).resolves.toBeUndefined();
});

test("preview popout creates a window, transfers the host record and requests placement there", async () => {
  previewMock.hosts.length = 0;
  await start();
  const source = previewMock.hosts[0];
  if (!source || !previewMock.popout) throw new Error("Missing previews");
  const moving = previewMock.popout("a".repeat(32));
  await vi.waitFor(() => {
    expect(previewMock.hosts).toHaveLength(2);
  });
  const target = mock.instances[1];
  if (!target) throw new Error("Missing window");
  await vi.waitFor(() => {
    expect(target.webContents.send).toHaveBeenCalledWith(
      "preview:place",
      expect.any(String),
      "a".repeat(32),
      expect.any(Number),
    );
  });
  const request: unknown = target.webContents.send.mock.calls.find(
    (call) => call[0] === "preview:place",
  )?.[1];
  await invokeWindow(1, "preview:placed", request, "a".repeat(32), "empty");
  await moving;
  const { previewHosts } = await import("../../../src/main/wiring/application");
  expect(source.moveTo).toHaveBeenCalledWith("a".repeat(32), previewHosts.get(target.id));
  source.placeMoved("a".repeat(32));
  const returned = mock.window.webContents.send.mock.calls.findLast(
    (call) => call[0] === "preview:place",
  );
  expect(returned?.[3]).toBe(Number.MAX_SAFE_INTEGER);
  await invokeWindow(0, "preview:placed", returned?.[1], "a".repeat(32), "landing");
});

test("closing a board retains its preview host until recovery can create a replacement", async () => {
  previewMock.hosts.length = 0;
  await start();
  const host = previewMock.hosts[0];
  const first = mock.instances[0];
  if (!host || !first) throw new Error("Missing preview host");
  const { previewHosts } = await import("../../../src/main/wiring/application");
  let finish: () => void = () => {
    throw new Error("Recovery did not start");
  };
  const recovering = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let replacementHost: unknown;
  vi.mocked(host.dispose).mockImplementationOnce(async (_persist, replacement) => {
    if (!replacement) throw new Error("Missing recovery factory");
    replacementHost = await replacement();
    await recovering;
  });
  mock.readyEvents.get("closed")?.();
  await vi.waitFor(() => {
    expect(mock.instances).toHaveLength(2);
    expect(replacementHost).toBeDefined();
  });
  const replacement = mock.instances[1];
  if (!replacement) throw new Error("Missing replacement board");
  expect(previewHosts.has(first.id)).toBe(true);
  expect(replacementHost).toBe(previewHosts.get(replacement.id));
  finish();
  await vi.waitFor(() => {
    expect(previewHosts.has(first.id)).toBe(false);
  });
});

test("concurrent manual commands across boards share a pending open and placement", async () => {
  await start();
  await newWindow();
  const { previewHosts } = await import("../../../src/main/wiring/application");
  const { PreviewPlacement } = await import("../../../src/main/previews/placement");
  const first = previewHosts.get(mock.instances[0]?.id ?? -1);
  const second = previewHosts.get(mock.instances[1]?.id ?? -1);
  if (!first || !second) throw new Error("Missing preview hosts");
  const place = vi.spyOn(PreviewPlacement.prototype, "place").mockResolvedValue("empty");
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = first.openManual.bind(first);
  const firstOpen = vi.spyOn(first, "openManual").mockImplementationOnce(async () => {
    await gate;
    return original();
  });
  const secondOpen = vi.spyOn(second, "openManual");
  const opening = invokeWindow(0, "app-menu:execute", "manual");
  await vi.waitFor(() => {
    expect(firstOpen).toHaveBeenCalledOnce();
  });
  const concurrent = invokeWindow(1, "app-menu:execute", "manual");
  await new Promise<void>((resolve) => setImmediate(resolve));
  release();
  await Promise.all([opening, concurrent]);
  expect(secondOpen).not.toHaveBeenCalled();
  expect(first.registry.records.size).toBe(1);
  expect(second.registry.records.size).toBe(0);
  expect(place).toHaveBeenCalledOnce();
});

test("a failed manual open releases the shared operation for another board", async () => {
  await start();
  await newWindow();
  const { previewHosts } = await import("../../../src/main/wiring/application");
  const { PreviewPlacement } = await import("../../../src/main/previews/placement");
  const first = previewHosts.get(mock.instances[0]?.id ?? -1);
  const second = previewHosts.get(mock.instances[1]?.id ?? -1);
  if (!first || !second) throw new Error("Missing preview hosts");
  vi.spyOn(PreviewPlacement.prototype, "place").mockResolvedValue("empty");
  vi.spyOn(first, "openManual").mockRejectedValueOnce(new Error("Manual unavailable"));
  await expect(invokeWindow(0, "app-menu:execute", "manual")).rejects.toThrow(
    "foom-error:operation-failed",
  );
  await invokeWindow(1, "app-menu:execute", "manual");
  expect(first.registry.records.size).toBe(0);
  expect(second.registry.records.size).toBe(1);
});

test.each([false, true])(
  "setup completion waits for the board and menus reveal the owning manual (minimized: %s)",
  async (minimized) => {
    await start();
    const { previewHosts } = await import("../../../src/main/wiring/application");
    const host = previewHosts.get(mock.instances[0]?.id ?? -1);
    if (!host || !mock.setup.deps) throw new Error("Missing manual dependencies");
    const opened = vi.spyOn(host, "openManual");
    const focused = vi.spyOn(host, "focusManual");
    expect(opened).not.toHaveBeenCalled();
    mock.setup.deps.apply({ ...DEFAULT_SETTINGS, setupComplete: true });
    expect(opened).not.toHaveBeenCalled();
    await invokeWindow(0, "app-menu:view", { available: true, maximized: false, tiles: 0 });
    const acknowledge = async (index: number) => {
      const window = mock.instances[index];
      if (!window) throw new Error("Missing board");
      await vi.waitFor(() => {
        expect(window.webContents.send).toHaveBeenCalledWith(
          "preview:place",
          expect.any(String),
          "f".repeat(32),
          expect.any(Number),
        );
      });
      const request: unknown = window.webContents.send.mock.calls
        .filter((call) => call[0] === "preview:place")
        .at(-1)?.[1];
      await invokeWindow(index, "preview:placed", request, "f".repeat(32), "empty");
    };
    await acknowledge(0);
    await vi.waitFor(() => {
      expect(focused).toHaveBeenCalledWith("f".repeat(32));
    });
    mock.window.webContents.send.mockClear();
    await invokeWindow(0, "app-menu:view", { available: true, maximized: false, tiles: 1 });
    expect(
      mock.window.webContents.send.mock.calls.some((call) => call[0] === "preview:place"),
    ).toBe(false);
    await newWindow();
    const other = previewHosts.get(mock.instances[1]?.id ?? -1);
    if (!other) throw new Error("Missing second host");
    const otherOpened = vi.spyOn(other, "openManual");
    mock.window.isMinimized.mockReturnValue(minimized);
    mock.window.restore.mockClear();
    mock.window.show.mockClear();
    mock.window.focus.mockClear();
    const reopened = invokeWindow(1, "app-menu:execute", "manual");
    await acknowledge(0);
    await reopened;
    expect(mock.window.restore).toHaveBeenCalledTimes(minimized ? 1 : 0);
    expect(mock.window.show).toHaveBeenCalledOnce();
    expect(mock.window.focus).toHaveBeenCalledOnce();
    if (minimized)
      expect(mock.window.restore.mock.invocationCallOrder[0]).toBeLessThan(
        mock.window.show.mock.invocationCallOrder[0] ?? 0,
      );
    expect(otherOpened).not.toHaveBeenCalled();
  },
);

test.each([false, true])(
  "automatic manual opening belongs to the profile across setup windows (already complete: %s)",
  async (alreadyComplete) => {
    let settings = { ...DEFAULT_SETTINGS, setupComplete: alreadyComplete };
    const get = vi.spyOn(mock.settingsStore, "get").mockImplementation(() => settings);
    try {
      await start();
      const firstSetup = mock.setup.deps;
      if (!firstSetup) throw new Error("Missing first setup");
      await newWindow();
      const secondSetup = mock.setup.deps;
      if (!secondSetup) throw new Error("Missing second setup");
      const { previewHosts } = await import("../../../src/main/wiring/application");
      const first = previewHosts.get(mock.instances[0]?.id ?? -1);
      const second = previewHosts.get(mock.instances[1]?.id ?? -1);
      if (!first || !second) throw new Error("Missing preview hosts");
      const opened = vi.spyOn(first, "openManual");
      const secondOpened = vi.spyOn(second, "openManual");
      // Setup persists the shared settings before applying them to every window.
      settings = { ...settings, setupComplete: true };
      firstSetup.apply(settings);
      await invokeWindow(0, "app-menu:view", { available: true, maximized: false, tiles: 0 });
      expect(opened).toHaveBeenCalledTimes(alreadyComplete ? 0 : 1);
      if (!alreadyComplete) {
        const request: unknown = mock.instances[0]?.webContents.send.mock.calls
          .filter((call) => call[0] === "preview:place")
          .at(-1)?.[1];
        await invokeWindow(0, "preview:placed", request, "f".repeat(32), "empty");
      }
      // A human closes the manual before the other pre-existing window saves anything.
      first.registry.records.clear();
      secondSetup.apply(settings);
      await invokeWindow(1, "app-menu:view", { available: true, maximized: false, tiles: 0 });
      settings = { ...settings, interfaceTheme: "eclipse-light" };
      secondSetup.apply(settings);
      await invokeWindow(1, "app-menu:view", { available: true, maximized: false, tiles: 0 });
      expect(secondOpened).not.toHaveBeenCalled();
      expect(opened).toHaveBeenCalledTimes(alreadyComplete ? 0 : 1);
    } finally {
      get.mockRestore();
    }
  },
);

test("windowless Manual opens a board with the fixed preview instead of a native dialog", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  await start();
  mock.readyEvents.get("closed")?.();
  const { Menu } = await import("electron");
  const template = vi.mocked(Menu).buildFromTemplate.mock.lastCall?.[0];
  const manual = template
    ?.flatMap((section) => (Array.isArray(section.submenu) ? section.submenu : []))
    .find((item) => item.id === "manual");
  if (!manual?.click) throw new Error("Missing windowless Manual");
  manual.click({} as Electron.MenuItem, undefined, {});
  await vi.waitFor(() => {
    expect(mock.window.webContents.send).toHaveBeenCalledWith(
      "preview:place",
      expect.any(String),
      "f".repeat(32),
      expect.any(Number),
    );
  });
  const request: unknown = mock.window.webContents.send.mock.calls
    .filter((call) => call[0] === "preview:place")
    .at(-1)?.[1];
  const { previewHosts } = await import("../../../src/main/wiring/application");
  const host = previewHosts.get(mock.instances[1]?.id ?? -1);
  if (!host) throw new Error("Missing manual host");
  const focus = vi.spyOn(host, "focusManual");
  await invokeWindow(1, "preview:placed", request, "f".repeat(32), "empty");
  await vi.waitFor(() => {
    expect(focus).toHaveBeenCalledWith("f".repeat(32));
  });
});

test.each(["linux", "win32", "darwin"] as const)(
  "%s reload shortcut targets only its owning board preview host",
  async (platform) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    await start();
    const { previewHosts } = await import("../../../src/main/wiring/application");
    const firstWindow = mock.instances[0];
    if (!firstWindow) throw new Error("Missing first board");
    const firstHost = previewHosts.get(firstWindow.id);
    if (!firstHost) throw new Error("Missing first preview host");
    const firstReload = vi.spyOn(firstHost, "reloadFocused");
    const firstInput = mock.windowEvents.get("before-input-event");
    await newWindow();
    const secondWindow = mock.instances[1];
    if (!secondWindow) throw new Error("Missing second board");
    await vi.waitFor(() => {
      expect(previewHosts.has(secondWindow.id)).toBe(true);
    });
    const secondHost = previewHosts.get(secondWindow.id);
    if (!secondHost) throw new Error("Missing second preview host");
    const secondReload = vi.spyOn(secondHost, "reloadFocused");
    const input: ShortcutInput = {
      type: "keyDown",
      key: "r",
      code: "KeyR",
      control: platform !== "darwin",
      meta: platform === "darwin",
      alt: false,
      shift: false,
    };
    const event = { preventDefault: vi.fn() };
    firstInput?.(event, input);
    expect(firstReload).toHaveBeenCalledOnce();
    expect(secondReload).not.toHaveBeenCalled();
    mock.windowEvents.get("before-input-event")?.(event, input);
    expect(secondReload).toHaveBeenCalledOnce();
    expect(firstReload).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    // A shortcut arriving after host teardown remains consumed without a target.
    previewHosts.delete(firstWindow.id);
    firstInput?.(event, input);
    expect(firstReload).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledTimes(3);
  },
);
