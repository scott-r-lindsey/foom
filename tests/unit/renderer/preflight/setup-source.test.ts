// @vitest-environment jsdom
import { expect, test, vi } from "vitest";
import { createSetupSource } from "../../../../src/renderer/preflight/setup-source";

test("preflight reaches main only through the setup bridge", async () => {
  const repository = { path: "/code/app", name: "app" };
  const desktop = {
    openThemesFolder: vi.fn(async () => {}),
    setupState: vi.fn(() => Promise.resolve("state")),
    saveSetup: vi.fn(() => Promise.resolve("saved")),
    onSetupChange: vi.fn(() => "off"),
    codeSuggestions: vi.fn(() => Promise.resolve(["/code"])),
    scanCode: vi.fn(() => Promise.resolve("scan")),
    applyRepositories: vi.fn(() => Promise.resolve("applied")),
    changeAgyPlugin: vi.fn(() => Promise.resolve("plugin")),
    scanAgents: vi.fn(() => Promise.resolve("scan")),
    workspace: vi.fn(() => Promise.resolve({ repositories: [repository], terminals: [] })),
    environmentState: vi.fn(() => Promise.resolve("env")),
    saveEnvironment: vi.fn(() => Promise.resolve("env")),
    removeEnvironment: vi.fn(() => Promise.resolve("env")),
    readShellEnvironment: vi.fn(() => Promise.resolve([])),
    importEnvironment: vi.fn(() => Promise.resolve("env")),
  };
  Object.defineProperty(window, "desktop", { configurable: true, value: desktop });
  const source = createSetupSource();
  await source.openThemesFolder("theme");
  expect(desktop.openThemesFolder).toHaveBeenCalledWith("theme");
  await expect(source.state()).resolves.toBe("state");
  await expect(source.save({ hooks: false })).resolves.toBe("saved");
  const listener = vi.fn();
  expect(source.subscribe(listener)).toBe("off");
  expect(desktop.onSetupChange).toHaveBeenCalledWith(listener);
  await expect(source.suggestions()).resolves.toEqual(["/code"]);
  const onProgress = vi.fn();
  await expect(source.scan("s1", null, onProgress)).resolves.toBe("scan");
  expect(desktop.scanCode).toHaveBeenCalledWith("s1", null, onProgress);
  await expect(source.apply(["/code/a"])).resolves.toBe("applied");
  expect(desktop.applyRepositories).toHaveBeenCalledWith(["/code/a"]);
  await expect(source.changeAgyPlugin("install")).resolves.toBe("plugin");
  expect(desktop.changeAgyPlugin).toHaveBeenCalledWith("install");
  await expect(source.scanAgents(true)).resolves.toBe("scan");
  await expect(source.repositories()).resolves.toEqual([repository]);
  expect(desktop.saveSetup).toHaveBeenCalledWith({ hooks: false });
  expect(desktop.scanAgents).toHaveBeenCalledWith(true);
  const environment = source.environment;
  if (!environment) throw new Error("Missing environment");
  const change = { scope: "all", previous: null, name: "A", value: "1", secret: false } as const;
  await environment.environmentState();
  await environment.saveEnvironment(change);
  await environment.removeEnvironment("codex", "A");
  await environment.readShellEnvironment();
  await environment.importEnvironment(["HTTPS_PROXY"]);
  expect(desktop.saveEnvironment).toHaveBeenCalledWith(change);
  expect(desktop.removeEnvironment).toHaveBeenCalledWith("codex", "A");
  expect(desktop.importEnvironment).toHaveBeenCalledWith(["HTTPS_PROXY"]);
  expect(desktop.environmentState).toHaveBeenCalledOnce();
  expect(desktop.readShellEnvironment).toHaveBeenCalledOnce();
});
