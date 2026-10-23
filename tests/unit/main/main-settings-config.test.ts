import {
  forgeHostStatus,
  readinessCheck,
  mock,
  start,
  invokeWindow,
  newWindow,
} from "./main-fixture";
import { DEFAULT_SETTINGS } from "../../../src/main/setup/settings";
import pluginFixture from "../../fixtures/agent-plugin.json";
import { parseAgentManifest } from "../../../src/shared/agent-plugin-parser";
import { v2Provider } from "../../../src/main/agents/providers/v2";
import { replaceConfigProviders } from "../../../src/main/agents/providers/registry";

import { interfaceThemes } from "../../../src/shared/interface-themes";
import { terminalThemes } from "../../../src/shared/terminal-themes";

import { join } from "node:path";
import type { Settings } from "../../../src/shared/setup";

import { expect, test, vi } from "vitest";

test("setup owns the settings, applies them to the workspace, and uses the local verdict classifier", async () => {
  await start();
  expect(mock.openSettings).toHaveBeenCalledWith("/test/user-data");
  const deps = mock.setup.deps as {
    store: unknown;
    worktreeRoot: string;
    apply(settings: unknown): void;
  };
  expect(deps.store).toBe(mock.settingsStore);
  expect(deps.worktreeRoot).toBe("/home/.foom/worktrees");
  // The saved mode and scale apply before the window exists.
  expect(mock.construct.mock.calls[0]?.[0].webPreferences?.zoomFactor).toBe(1.2);
  expect(mock.theme.themeSource).toBe("dark");
  const next = { hooks: false, colorMode: "light", interfaceScale: 90, interfaceTheme: "follow" };
  deps.apply(next);
  expect(mock.workspace.configure).toHaveBeenCalledWith(next);
  expect(mock.theme.themeSource).toBe("light");
  expect(mock.window.webContents.setZoomFactor).toHaveBeenCalledWith(0.9);
  // The window opened at 120% and shrinks with the interface.
  expect(mock.construct.mock.calls[0]?.[0]).toMatchObject({
    width: 1152,
    height: 768,
    minWidth: 1080,
    minHeight: 768,
  });
  expect(mock.window.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 810, height: 576 });
  // The code folder picker is main's own dialog.
  const { code } = mock.setup.deps as { code: { pickFolder(): Promise<string | null> } };
  mock.openDialog.mockResolvedValueOnce({ canceled: false, filePaths: ["/home/me/code"] });
  await expect(code.pickFolder()).resolves.toBe("/home/me/code");
  mock.openDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
  await expect(code.pickFolder()).resolves.toBeNull();
  mock.openDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] });
  await expect(code.pickFolder()).resolves.toBeNull();
  expect(mock.attachSetup.mock.calls[0]?.[1]).toBeInstanceOf(Object);
  // A click on + grows the window from the pointer instead of the top-left corner.
  const pointerZoom = mock.attachSetup.mock.calls[0]?.[2] as (active: boolean) => void;
  pointerZoom(true);
  deps.apply({ ...next, interfaceScale: 80 });
  pointerZoom(false);
  // Shrinking toward the pointer at (1000, 700) moves the corner toward it.
  expect(mock.window.setBounds).toHaveBeenLastCalledWith({
    x: 111,
    y: 78,
    width: 720,
    height: 512,
  });
  expect(mock.VerdictLog).toHaveBeenCalledWith("/test/user-data");
});

test("Settings repository selection uses workspace lifecycle guards", async () => {
  const repository = { path: "/repo", name: "repo" };
  mock.openWorktrees.mockResolvedValue({
    worktreeRoot: "/trees",
    listRepositories: () => [repository],
  });
  mock.workspace.addRepository.mockResolvedValue(repository);
  mock.workspace.removeRepository.mockRejectedValueOnce(
    new Error("Close this repository's sessions first"),
  );
  await start();
  const code = mock.setup.deps?.code;
  if (!code) throw new Error("Missing setup code dependency");
  expect(code.worktrees.listRepositories()).toEqual([repository]);
  await mock.setup.deps?.readiness?.();
  await mock.setup.deps?.gitReadiness?.();
  expect(readinessCheck).toHaveBeenCalledWith([repository.path], expect.any(Function));
  expect(readinessCheck).toHaveBeenCalledWith([], expect.any(Function));
  expect(forgeHostStatus).toHaveBeenCalledOnce();
  await expect(code.worktrees.addRepository(repository.path)).resolves.toEqual(repository);
  expect(mock.workspace.addRepository).toHaveBeenCalledWith(repository.path);
  await expect(code.worktrees.removeRepository(repository.path)).rejects.toThrow("Close");
  expect(mock.workspace.removeRepository).toHaveBeenCalledWith(repository.path);
});

test("live theme catalog changes update native colors, terminal palettes and all settings subscribers", async () => {
  await start();
  const settings = {
    ...mock.settingsStore.get(),
    interfaceTheme: "user:custom.json" as const,
    terminalTheme: "user:term.json" as const,
  };
  vi.spyOn(mock.settingsStore, "get").mockReturnValue(settings);
  mock.catalog = {
    interface: [{ id: "user:custom.json", theme: interfaceThemes.moonlight }],
    terminal: [{ id: "user:term.json", name: "Custom", theme: terminalThemes.dracula }],
    errors: [],
  };
  expect(mock.setup.deps?.themes?.()).toEqual(mock.catalog);
  mock.themeChanged();
  await vi.waitFor(() => {
    expect(mock.window.webContents.send).toHaveBeenCalledWith("setup:changed", expect.anything());
  });
  expect(mock.theme.themeSource).toBe("light");
  expect(mock.terminals.setTheme).toHaveBeenLastCalledWith(terminalThemes.dracula);
  mock.catalog = { interface: [], terminal: [], errors: [] };
  mock.themeChanged();
  expect(mock.terminals.setTheme).toHaveBeenLastCalledWith("follow");
  mock.window.webContents.send.mockClear();
  mock.window.webContents.isDestroyed.mockReturnValue(true);
  mock.themeChanged();
  await Promise.resolve();
  expect(mock.window.webContents.send).not.toHaveBeenCalled();
});

test("Foom config migrates profile values, applies file changes live and broadcasts status", async () => {
  mock.window.webContents.isDestroyed.mockReturnValue(false);
  await start();
  expect(mock.config.initialize).toHaveBeenCalledWith({ terminalFontSize: 16 });
  expect(mock.settingsStore.attachConfig).toHaveBeenCalledWith(expect.any(Function), {}, null);
  const [writer] = mock.settingsStore.attachConfig.mock.calls[0] as unknown as [
    (patch: object) => Promise<void>,
  ];
  await writer({ hooks: false });
  expect(mock.config.write).toHaveBeenCalledWith({ hooks: false });
  const deps = mock.config.deps;
  if (!deps) throw new Error("Expected config dependencies");
  expect(deps.root).toBe(join("/test/user-data", ".foom", "config"));
  mock.setupRefresh.mockClear();
  deps.apply({ terminalFontSize: 20 });
  expect(mock.settingsStore.setConfig).toHaveBeenCalledWith({ terminalFontSize: 20 });
  expect(mock.window.webContents.setZoomFactor).toHaveBeenCalled();
  // An interface size change from the file resizes the window like a Settings change.
  const settings = vi.spyOn(mock.settingsStore, "get");
  settings.mockReturnValueOnce({
    ...DEFAULT_SETTINGS,
    colorMode: "dark",
    interfaceScale: 120,
    interfaceTheme: "follow",
  });
  settings.mockReturnValue({
    ...DEFAULT_SETTINGS,
    colorMode: "dark",
    interfaceScale: 140,
    interfaceTheme: "follow",
  });
  deps.apply({ interfaceScale: 140 });
  settings.mockRestore();
  deps.onStatus?.(mock.config.status as never);
  expect(mock.window.webContents.send).toHaveBeenCalledWith("config:changed", mock.config.status);
  expect(deps.baseline.get()).toBeNull();
  await deps.baseline.set("d".repeat(64));
  expect(mock.settingsStore.setConfigDigest).toHaveBeenCalledWith("d".repeat(64));
  expect(deps.appliedText?.get()).toBeNull();
  await deps.appliedText?.set("{}");
  expect(mock.settingsStore.setConfigText).toHaveBeenCalledWith("{}");
  expect(mock.attachConfig).toHaveBeenCalled();
  const config = mock.workspace.deps?.config;
  if (!config) throw new Error("Expected config launch dependencies");
  expect(config.root).toBe(deps.root);
  await expect(config.check()).resolves.toBeUndefined();
  mock.managesPath.mockResolvedValueOnce(true);
  await expect(config.check()).rejects.toThrow("inside a repository");
});

test("an unusable Foom config folder keeps settings in the profile", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  mock.config.initialize.mockRejectedValueOnce(new Error("not a folder"));
  await start();
  expect(error).toHaveBeenCalledWith("Foom config is unavailable:", expect.any(Error));
  expect(mock.settingsStore.attachConfig).not.toHaveBeenCalled();
  expect(mock.window.loadURL).toHaveBeenCalled();
});

test("app menu settings stay available without discovering config agents", async () => {
  await start();
  mock.workspace.scanAgents.mockClear();
  await invokeWindow(0, "app-menu:view", {
    available: false,
    configAvailable: true,
    maximized: false,
    tiles: 0,
  });
  const menu = JSON.stringify(await invokeWindow(0, "app-menu:list"));
  expect(menu).not.toContain("via-");
  expect(menu).toContain('"id":"settings","label":"Settings…"');
  await invokeWindow(0, "app-menu:execute", "settings");
  for (const route of ["via-claude", "via-codex", "via-agy"])
    await expect(invokeWindow(0, "app-menu:execute", route)).rejects.toThrow(
      "foom-error:operation-failed",
    );
  expect(mock.workspace.scanAgents).not.toHaveBeenCalled();
});

test("config Allow uses the trusted dialog and persists bypass consent without clearing other agents", async () => {
  await start();
  const deps = mock.config.deps;
  if (!deps?.confirmArguments || !deps.acknowledgeBypass)
    throw new Error("Missing config consent capabilities");
  const content = { title: "Allow agent launch arguments?", accept: "Allow" };
  mock.message.mockResolvedValueOnce({ response: 1 });
  expect(await deps.confirmArguments(content)).toBe(true);
  expect(mock.message).toHaveBeenLastCalledWith(content);
  mock.message.mockResolvedValueOnce({ response: 0 });
  expect(await deps.confirmArguments(content)).toBe(false);
  await deps.acknowledgeBypass(["codex", "claude"]);
  expect(mock.settingsStore.update).toHaveBeenLastCalledWith({
    agentBypassAcknowledged: { claude: true, codex: true, agy: true },
  });
});

test("config plugins refresh changed registries and report discovery failure", async () => {
  await start();
  const deps = mock.config.deps;
  if (!deps?.applyPlugins) throw Error("Missing plugin capabilities");
  const provider = v2Provider(parseAgentManifest(JSON.stringify(pluginFixture)).model, () =>
    Promise.resolve(),
  );
  mock.window.webContents.send.mockClear();
  deps.applyPlugins([provider]);
  await vi.waitFor(() => {
    expect(mock.workspace.scanAgents).toHaveBeenCalledWith(true);
  });
  await vi.waitFor(() => {
    expect(mock.workspace.refresh).toHaveBeenCalled();
    expect(mock.window.webContents.send).toHaveBeenCalledWith("setup:changed", expect.anything());
  });
  mock.workspace.scanAgents.mockClear();
  deps.applyPlugins([provider]);
  expect(mock.workspace.scanAgents).not.toHaveBeenCalled();
  const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
  mock.workspace.scanAgents.mockRejectedValueOnce(Error("unavailable"));
  deps.applyPlugins([]);
  await vi.waitFor(() => {
    expect(warn).toHaveBeenCalledWith("Unable to refresh agent plugins");
  });
  warn.mockRestore();
  replaceConfigProviders([]);
});

test("config plugins load before the first workspace exists without starting discovery from the config callback", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
  mock.config.initialize.mockImplementationOnce(() => {
    const provider = v2Provider(parseAgentManifest(JSON.stringify(pluginFixture)).model, () =>
      Promise.resolve(),
    );
    mock.config.deps?.applyPlugins?.([provider]);
    return Promise.resolve({});
  });
  await start();
  expect(warn).not.toHaveBeenCalledWith("Foom config is unavailable:", expect.anything());
  expect(mock.settingsStore.attachConfig).toHaveBeenCalled();
  warn.mockRestore();
});

test.each([false, true])(
  "migrates an answered Antigravity offer without changing setup consent (already tracked=%s)",
  async (tracked) => {
    const previous = mock.settingsStore.get();
    const settings = { ...previous, agyPluginOfferAnswered: true };
    const get = vi.spyOn(mock.settingsStore, "get").mockReturnValue(settings);
    const { setupOffers } = await import("../../../src/main/agents/setup-offers");
    const answered = vi.spyOn(setupOffers, "answered").mockReturnValue(tracked);
    const answer = vi.spyOn(setupOffers, "answer");
    try {
      await start();
      if (tracked) expect(answer).not.toHaveBeenCalled();
      else expect(answer).toHaveBeenCalledExactlyOnceWith("agy");
      expect(mock.settingsStore.update).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
      answered.mockRestore();
      answer.mockRestore();
    }
  },
);

test("migrates only the first saved window scale when shared config has no scale", async () => {
  mock.loadPlacements.mockResolvedValue([
    {
      id: "first",
      display: 1,
      bounds: { x: 0, y: 0, width: 1200, height: 900 },
      maximized: false,
      scale: 150,
    },
    {
      id: "second",
      display: 1,
      bounds: { x: 0, y: 0, width: 1200, height: 900 },
      maximized: false,
      scale: 90,
    },
  ]);
  await start();
  expect(mock.settingsStore.update).toHaveBeenCalledWith({ interfaceScale: 150 });
});

test("existing shared scale wins over legacy window scales", async () => {
  mock.config.initialize.mockResolvedValue({ interfaceScale: 100 });
  mock.loadPlacements.mockResolvedValue([
    {
      id: "first",
      display: 1,
      bounds: { x: 0, y: 0, width: 1200, height: 900 },
      maximized: false,
      scale: 150,
    },
  ]);
  await start();
  expect(mock.settingsStore.update).not.toHaveBeenCalled();
});

test("legacy shared profile scale wins over window scales", async () => {
  mock.settingsStore.legacyConfig.mockReturnValueOnce({
    terminalFontSize: 16,
    interfaceScale: 110,
  });
  mock.loadPlacements.mockResolvedValue([
    {
      id: "first",
      display: 1,
      bounds: { x: 0, y: 0, width: 1200, height: 900 },
      maximized: false,
      scale: 150,
    },
  ]);
  await start();
  expect(mock.settingsStore.update).toHaveBeenCalledWith({ interfaceScale: 110 });
});

test("a failed settings notification does not prevent broadcasting to another window", async () => {
  await start();
  await newWindow();
  await Promise.resolve();
  const error = new Error("window state unavailable");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  mock.window.webContents.send.mockClear();
  mock.setupState.mockRejectedValueOnce(error);
  mock.setup.deps?.apply(mock.settingsStore.get() as Settings);
  await vi.waitFor(() => {
    expect(log).toHaveBeenCalledWith("Unable to refresh settings:", error);
    expect(mock.window.webContents.send).toHaveBeenCalledWith("setup:changed", expect.anything());
  });
});
