// @vitest-environment jsdom
import { expect, test, vi } from "vitest";
import { createSetupSource } from "../../../../src/renderer/preflight/setup-source";

test("preflight reaches main only through the setup bridge", async () => {
  const repository = { path: "/code/app", name: "app" };
  const desktop = {
    setupState: vi.fn(() => Promise.resolve("state")),
    saveSetup: vi.fn(() => Promise.resolve("saved")),
    setInferenceKey: vi.fn(() => Promise.resolve("set")),
    removeInferenceKey: vi.fn(() => Promise.resolve("removed")),
    checkInference: vi.fn(() => Promise.resolve("checked")),
    cancelInferenceCheck: vi.fn(() => Promise.resolve()),
    localModels: vi.fn(() => Promise.resolve("models")),
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
  await expect(source.state()).resolves.toBe("state");
  await expect(source.save({ hooks: false })).resolves.toBe("saved");
  await expect(source.setKey("openai", "sk")).resolves.toBe("set");
  await expect(source.removeKey("openai")).resolves.toBe("removed");
  const onUpdate = vi.fn();
  await expect(source.check("c1", { kind: "rules" }, 5000, onUpdate)).resolves.toBe("checked");
  await source.cancel("c1");
  await expect(source.models("http://127.0.0.1:1/v1")).resolves.toBe("models");
  expect(desktop.cancelInferenceCheck).toHaveBeenCalledWith("c1");
  const listener = vi.fn();
  expect(source.subscribe(listener)).toBe("off");
  expect(desktop.onSetupChange).toHaveBeenCalledWith(listener);
  await expect(source.suggestions()).resolves.toEqual(["/code"]);
  const onProgress = vi.fn();
  await expect(source.scan("s1", null, onProgress)).resolves.toBe("scan");
  expect(desktop.scanCode).toHaveBeenCalledWith("s1", null, onProgress);
  await expect(source.apply(["/code/a"])).resolves.toBe("applied");
  expect(desktop.applyRepositories).toHaveBeenCalledWith(["/code/a"]);
  expect(desktop.localModels).toHaveBeenCalledWith("http://127.0.0.1:1/v1");
  await expect(source.changeAgyPlugin("install")).resolves.toBe("plugin");
  expect(desktop.changeAgyPlugin).toHaveBeenCalledWith("install");
  await expect(source.scanAgents(true)).resolves.toBe("scan");
  await expect(source.repositories()).resolves.toEqual([repository]);
  expect(desktop.saveSetup).toHaveBeenCalledWith({ hooks: false });
  expect(desktop.setInferenceKey).toHaveBeenCalledWith("openai", "sk");
  expect(desktop.removeInferenceKey).toHaveBeenCalledWith("openai");
  expect(desktop.checkInference).toHaveBeenCalledWith("c1", { kind: "rules" }, 5000, onUpdate);
  expect(desktop.scanAgents).toHaveBeenCalledWith(true);
});
