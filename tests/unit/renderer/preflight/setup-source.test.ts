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
});

test("Foom config reaches main only through the config bridge", async () => {
  const desktop = {
    configStatus: vi.fn(() => Promise.resolve("status")),
    decideConfig: vi.fn(() => Promise.resolve("decided")),
    revertConfig: vi.fn(() => Promise.resolve("reverted")),
    openConfigFolder: vi.fn(async () => {}),
    onConfigChange: vi.fn(() => "off"),
  };
  Object.defineProperty(window, "desktop", { configurable: true, value: desktop });
  const config = createSetupSource().config;
  if (!config) throw new Error("Expected config source");
  await expect(config.status()).resolves.toBe("status");
  await expect(config.decide("keep")).resolves.toBe("decided");
  expect(desktop.decideConfig).toHaveBeenCalledWith("keep");
  await expect(config.revert("a".repeat(40))).resolves.toBe("reverted");
  expect(desktop.revertConfig).toHaveBeenCalledWith("a".repeat(40));
  await config.openFolder();
  expect(desktop.openConfigFolder).toHaveBeenCalled();
  const listener = vi.fn();
  expect(config.subscribe(listener)).toBe("off");
  expect(desktop.onConfigChange).toHaveBeenCalledWith(listener);
});
