import { beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/settings";
import { Setup } from "../src/setup";
import type { SetupDependencies } from "../src/setup";
import type { Verdict } from "../src/shared/evaluator";
import type { ApiProvider, InferenceConfig, ModelCheck } from "../src/shared/inference";
import type { Settings, SettingsPatch } from "../src/shared/setup";

const verdict: Verdict = { state: "needs_input", reason: "r", signal: "model", confidence: 0.9 };
let settings: Settings;
let stored: Set<ApiProvider>;
let checks: ModelCheck["status"][];
const built: InferenceConfig[] = [];
const apply = vi.fn<(settings: Settings) => void>();
const evaluate = vi.fn(() => Promise.resolve(verdict));
const setKey = vi.fn((provider: ApiProvider) => {
  stored.add(provider);
  return Promise.resolve();
});
let deps: SetupDependencies;

beforeEach(() => {
  settings = { ...DEFAULT_SETTINGS };
  stored = new Set();
  checks = [];
  built.length = 0;
  vi.clearAllMocks();
  deps = {
    store: {
      get: () => settings,
      update: vi.fn((patch: SettingsPatch) => {
        settings = { ...settings, ...patch };
        return Promise.resolve(settings);
      }),
    },
    keys: {
      available: () => true,
      has: (provider) => Promise.resolve(stored.has(provider)),
      get: () => Promise.resolve("key"),
      set: setKey,
      remove: vi.fn((provider: ApiProvider) => {
        stored.delete(provider);
        return Promise.resolve();
      }),
    },
    worktreeRoot: "/home/me/.foom/worktrees",
    apply,
    evaluator: (config) => {
      built.push(config);
      return {
        evaluate,
        runCheck: () =>
          Promise.resolve({ verdict, status: checks.shift() ?? "model", elapsedMs: 900 }),
      };
    },
  };
});

const local = { kind: "local", model: "qwen3:8b", endpoint: "http://127.0.0.1:11434/v1" } as const;

test("applies stored settings at startup and reports state without key material", async () => {
  stored.add("openai");
  const setup = new Setup(deps);
  expect(apply).toHaveBeenCalledExactlyOnceWith(DEFAULT_SETTINGS);
  expect(built).toEqual([{ kind: "rules" }]);
  await expect(setup.state()).resolves.toEqual({
    settings: DEFAULT_SETTINGS,
    keys: { anthropic: false, openai: true, google: false },
    secureStorage: true,
    worktreeRoot: "/home/me/.foom/worktrees",
  });
  await expect(setup.classify({ terminalId: "t", tail: [] })).resolves.toBe(verdict);
});

test("saves validated settings and applies them", async () => {
  const setup = new Setup(deps);
  const state = await setup.save({ hooks: false, setupComplete: true });
  expect(state.settings).toMatchObject({ hooks: false, setupComplete: true });
  expect(apply).toHaveBeenLastCalledWith(state.settings);
  await expect(setup.save({ hooks: "no" })).rejects.toThrow("Invalid settings");
  // Choosing rules needs no check and doesn't rebuild an unchanged evaluator.
  await setup.save({ inference: { kind: "rules" } });
  expect(built).toHaveLength(1);
});

test("a model source is saved only after it passes Run check", async () => {
  const setup = new Setup(deps);
  await expect(setup.save({ inference: local })).rejects.toThrow("Run check on this source");
  checks.push("timeout");
  await expect(setup.check(local)).resolves.toMatchObject({ status: "timeout" });
  await expect(setup.save({ inference: local })).rejects.toThrow("Run check on this source");
  await expect(setup.check(local)).resolves.toMatchObject({ status: "model" });
  await setup.check(local);
  const state = await setup.save({ inference: local });
  expect(state.settings.inference).toEqual(local);
  // The app's evaluator now uses the new source; re-saving it needs no new check.
  expect(built.at(-1)).toEqual(local);
  const count = built.length;
  await setup.save({ inference: local, hooks: false });
  expect(built).toHaveLength(count);
  await expect(setup.check({ kind: "claude" })).rejects.toThrow("CLI inference unavailable");
});

test("cloud checks need a stored key, and a new or removed key needs a new check", async () => {
  const setup = new Setup(deps);
  const cloud = { kind: "anthropic", model: "claude-haiku-4-5" } as const;
  await expect(setup.check(cloud)).rejects.toThrow("Save an API key first");
  expect((await setup.setKey("anthropic", "sk-test")).keys.anthropic).toBe(true);
  expect(setKey).toHaveBeenCalledWith("anthropic", "sk-test");
  await setup.check(cloud);
  await setup.check(local);
  await setup.setKey("anthropic", "sk-other");
  await expect(setup.save({ inference: cloud })).rejects.toThrow("Run check on this source");
  // Other sources keep their check.
  await setup.save({ inference: local });
  await setup.check(cloud);
  expect((await setup.removeKey("anthropic")).keys.anthropic).toBe(false);
  await expect(setup.save({ inference: cloud })).rejects.toThrow("Run check on this source");
  await expect(setup.setKey("../escape", "k")).rejects.toThrow("Invalid key provider");
  await expect(setup.removeKey(7)).rejects.toThrow("Invalid key provider");
});

test("uses the real model evaluator by default", async () => {
  const defaults: SetupDependencies = { ...deps };
  delete defaults.evaluator;
  const setup = new Setup(defaults);
  // Rules only: no model is called and the check reports the rules fallback.
  await expect(setup.check({ kind: "rules" })).resolves.toMatchObject({ status: "rules" });
  await expect(
    setup.classify({ terminalId: "t", tail: ["Continue? (y/n)"] }),
  ).resolves.toMatchObject({ state: "needs_input" });
});
