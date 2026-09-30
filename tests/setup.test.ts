import { beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/settings";
import { Setup } from "../src/setup";
import type { SetupDependencies } from "../src/setup";
import type { Verdict } from "../src/shared/evaluator";
import type {
  ApiProvider,
  InferenceConfig,
  ProbeResult,
  ProbeUpdate,
} from "../src/shared/inference";
import type { Settings, SettingsPatch } from "../src/shared/setup";

const verdict: Verdict = { state: "needs_input", reason: "r", signal: "model", confidence: 0.9 };
let settings: Settings;
let stored: Set<ApiProvider>;
let checks: boolean[];
const built: [InferenceConfig, number][] = [];
const progress = vi.fn<(update: ProbeUpdate) => void>();
const probe = vi.fn(
  (
    _config: unknown,
    _timeoutMs: number,
    onUpdate: (update: ProbeUpdate) => void,
    _signal: AbortSignal,
  ): Promise<ProbeResult> => {
    onUpdate({ kind: "stream", thinking: 0, reply: "{}" });
    const ok = checks.shift() ?? true;
    return Promise.resolve({
      ok,
      message: ok ? "passed" : "failed",
      timings: { totalMs: 900 },
      request: { url: "u", model: "m", parameters: {}, prompt: "p" },
      reply: "{}",
      thinking: 0,
    });
  },
);
const check = (setup: Setup, config: unknown, id = "c1") => setup.check(id, config, 5000, progress);
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
    evaluator: (config, timeoutMs) => {
      built.push([config, timeoutMs]);
      return { evaluate };
    },
    probe,
    models: (endpoint) => Promise.resolve({ ok: true, models: [String(endpoint)], server: null }),
  };
});

const local = { kind: "local", model: "qwen3:8b", endpoint: "http://127.0.0.1:11434/v1" } as const;

test("applies stored settings at startup and reports state without key material", async () => {
  stored.add("openai");
  const setup = new Setup(deps);
  expect(apply).toHaveBeenCalledExactlyOnceWith(DEFAULT_SETTINGS);
  expect(built).toEqual([[{ kind: "rules" }, 5000]]);
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
  checks.push(false);
  await expect(check(setup, local)).resolves.toMatchObject({ ok: false });
  expect(progress).toHaveBeenCalledWith({ kind: "stream", thinking: 0, reply: "{}" });
  await expect(setup.save({ inference: local })).rejects.toThrow("Run check on this source");
  await expect(check(setup, local)).resolves.toMatchObject({ ok: true });
  await check(setup, local);
  const state = await setup.save({ inference: local });
  expect(state.settings.inference).toEqual(local);
  // The app's evaluator now uses the new source; re-saving it needs no new check.
  expect(built.at(-1)).toEqual([local, 5000]);
  const count = built.length;
  await setup.save({ inference: local, hooks: false });
  expect(built).toHaveLength(count);
  // A new time limit rebuilds the evaluator with it.
  await setup.save({ inferenceTimeoutMs: 15_000 });
  expect(built.at(-1)).toEqual([local, 15_000]);
  await expect(setup.check("c2", local, "5000", progress)).rejects.toThrow("Invalid time limit");
});

test("a new or removed key needs a new check", async () => {
  const setup = new Setup(deps);
  const cloud = { kind: "anthropic", model: "claude-haiku-4-5" } as const;
  expect((await setup.setKey("anthropic", "sk-test")).keys.anthropic).toBe(true);
  expect(setKey).toHaveBeenCalledWith("anthropic", "sk-test");
  await check(setup, cloud);
  await check(setup, local);
  await setup.setKey("anthropic", "sk-other");
  await expect(setup.save({ inference: cloud })).rejects.toThrow("Run check on this source");
  // Other sources keep their check.
  await setup.save({ inference: local });
  await check(setup, cloud);
  expect((await setup.removeKey("anthropic")).keys.anthropic).toBe(false);
  await expect(setup.save({ inference: cloud })).rejects.toThrow("Run check on this source");
  await expect(setup.setKey("../escape", "k")).rejects.toThrow("Invalid key provider");
  await expect(setup.removeKey(7)).rejects.toThrow("Invalid key provider");
});

test("one check runs at a time, and a check can be cancelled", async () => {
  const setup = new Setup(deps);
  const signals: AbortSignal[] = [];
  probe.mockImplementation((_config, _timeout, _update, signal) => {
    signals.push(signal);
    return new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        resolve({
          ok: false,
          failure: "cancelled",
          message: "Cancelled",
          timings: { totalMs: 1 },
          request: { url: "u", model: "m", parameters: {}, prompt: "p" },
          reply: "",
          thinking: 0,
        });
      });
    });
  });
  const first = check(setup, local, "first");
  const second = check(setup, local, "second");
  await expect(first).resolves.toMatchObject({ failure: "cancelled" });
  setup.cancel("unknown");
  expect(signals[1]?.aborted).toBe(false);
  setup.cancel("second");
  await expect(second).resolves.toMatchObject({ failure: "cancelled" });
  await expect(setup.models("http://127.0.0.1:1/v1")).resolves.toMatchObject({
    models: ["http://127.0.0.1:1/v1"],
  });
});

test("uses the real model evaluator, probe and model list by default", async () => {
  const defaults: SetupDependencies = { ...deps };
  delete defaults.evaluator;
  delete defaults.probe;
  delete defaults.models;
  const setup = new Setup(defaults);
  await expect(check(setup, { kind: "rules" })).rejects.toThrow("Rules only needs no check");
  await expect(setup.models("http://example.com/v1")).rejects.toThrow("loopback");
  // Nothing listens here, so the real probe fails fast at its first step.
  await expect(
    check(setup, { ...local, endpoint: "http://127.0.0.1:59999/v1" }),
  ).resolves.toMatchObject({ failure: "refused" });
  await expect(
    setup.classify({ terminalId: "t", tail: ["Continue? (y/n)"] }),
  ).resolves.toMatchObject({ state: "needs_input" });
});
