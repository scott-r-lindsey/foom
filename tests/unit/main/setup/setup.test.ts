import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../../../src/main/setup/settings";
import { Setup } from "../../../../src/main/setup/setup";
import type { SetupDependencies } from "../../../../src/main/setup/setup";
import type { Verdict } from "../../../../src/shared/evaluator";
import type {
  ApiProvider,
  InferenceConfig,
  ProbeResult,
  ProbeUpdate,
} from "../../../../src/shared/inference";
import type { ScanProgress, Settings, SettingsPatch } from "../../../../src/shared/setup";

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
const NOW = Date.UTC(2026, 8, 30);
let added: { path: string; name: string }[];
const pick = vi.fn<() => Promise<string | null>>();
const found = (name: string, daysAgo: number | null) => ({
  path: `/code/${name}`,
  name,
  relative: name,
  branch: "main",
  lastActive: daysAgo === null ? null : NOW - daysAgo * 86_400_000,
});
const scanFolder = vi.fn(
  (
    folder: string,
    options?: { exclude?: readonly string[]; onProgress?: (p: ScanProgress) => void },
  ) => {
    options?.onProgress?.({ folders: 4, repositories: 3 });
    return Promise.resolve({
      folder,
      folders: 4,
      truncated: false,
      repositories: [
        found("new", 1),
        found("old", 90),
        found("busy", 5),
        found("broken", 2),
        found("idle", null),
      ],
    });
  },
);

beforeEach(() => {
  added = [
    { path: "/code/busy", name: "busy" },
    { path: "/elsewhere/x", name: "x" },
  ];
  pick.mockReset();
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
    code: {
      worktrees: {
        listRepositories: () => [...added],
        addRepository: vi.fn((path: string) => {
          if (path.endsWith("broken"))
            return Promise.reject(new Error("Repository must be a Git work tree"));
          const repository = { path, name: path.split("/").at(-1) ?? path };
          added.push(repository);
          return Promise.resolve(repository);
        }),
        removeRepository: vi.fn((path: string) => {
          if (path.endsWith("busy"))
            return Promise.reject(new Error("Has 1 worktree Foom made; remove it first"));
          added.splice(
            added.findIndex((entry) => entry.path === path),
            1,
          );
          return Promise.resolve();
        }),
      },
      home: "/home/me",
      pickFolder: pick,
      scan: scanFolder,
      now: () => NOW,
    },
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

test("scanning a code folder marks recent and added repositories and saves the folder", async () => {
  const setup = new Setup(deps);
  const progress = vi.fn();
  await expect(setup.scanCode("/somewhere/else", progress)).rejects.toThrow("Unknown code folder");
  await expect(setup.scanCode(7, progress)).rejects.toThrow("Unknown code folder");
  pick.mockResolvedValueOnce(null);
  await expect(setup.scanCode(null, progress)).resolves.toBeNull();
  pick.mockResolvedValueOnce("/code");
  const scan = await setup.scanCode(null, progress);
  expect(scanFolder).toHaveBeenLastCalledWith("/code", {
    exclude: ["/home/me/.foom/worktrees"],
    onProgress: progress,
  });
  expect(progress).toHaveBeenCalledWith({ folders: 4, repositories: 3 });
  expect(scan?.repositories.map((repo) => [repo.name, repo.recent, repo.added])).toEqual([
    ["new", true, false],
    ["old", false, false],
    ["busy", true, true],
    ["broken", true, false],
    ["idle", false, false],
  ]);
  expect(settings.codeFolder).toBe("/code");
  // The saved folder can be scanned again without the picker.
  await setup.scanCode("/code", progress);
  expect(pick).toHaveBeenCalledTimes(2);
});

test("suggestions are folders with repositories in them, counted by a quick scan", async () => {
  const home = await mkdtemp(join(tmpdir(), "foom-home-"));
  try {
    for (const name of ["code", "src", "projects"]) await mkdir(join(home, name));
    const quick = vi.fn((folder: string) => {
      if (folder.endsWith("projects")) return Promise.reject(new Error("EACCES"));
      const many = folder.endsWith("code");
      return Promise.resolve({
        folder,
        folders: 10,
        truncated: many,
        repositories: many ? [found("a", 1), found("b", 2)] : [],
      });
    });
    const setup = new Setup({ ...deps, code: { ...deps.code, home, scan: quick } });
    // An empty folder and an unreadable one aren't suggested.
    await expect(setup.codeSuggestions()).resolves.toEqual([
      { path: join(home, "code"), repositories: 2, more: true },
    ]);
    expect(quick).toHaveBeenCalledWith(join(home, "code"), {
      exclude: ["/home/me/.foom/worktrees"],
      maxFolders: 5000,
    });
    await expect(setup.scanCode(join(home, "src"), vi.fn())).rejects.toThrow("Unknown code folder");
    await expect(setup.scanCode(join(home, "code"), vi.fn())).resolves.toMatchObject({
      folder: join(home, "code"),
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("suggested folders can be scanned directly", async () => {
  const setup = new Setup({ ...deps, code: { ...deps.code, home: "/nonexistent-home" } });
  await expect(setup.codeSuggestions()).resolves.toEqual([]);
  await expect(setup.scanCode("/nonexistent-home/code", vi.fn())).rejects.toThrow(
    "Unknown code folder",
  );
});

test("applying a selection adds and removes only scanned repositories, reporting refusals", async () => {
  const setup = new Setup(deps);
  await expect(setup.applyRepositories(["/code/new"])).rejects.toThrow(
    "Choose repositories from the latest scan",
  );
  pick.mockResolvedValueOnce("/code");
  await setup.scanCode(null, vi.fn());
  for (const bad of ["/code/new", ["/etc"], [7], null])
    await expect(setup.applyRepositories(bad)).rejects.toThrow("latest scan");
  const update = await setup.applyRepositories(["/code/new", "/code/broken"]);
  expect(update.repositories.map((repo) => repo.path)).toEqual([
    "/code/busy",
    "/elsewhere/x",
    "/code/new",
  ]);
  expect(update.failures).toEqual([
    { path: "/code/busy", message: "Has 1 worktree Foom made; remove it first" },
    { path: "/code/broken", message: "Repository must be a Git work tree" },
  ]);
  // Repositories outside the scan are never touched.
  expect(deps.code.worktrees.removeRepository).not.toHaveBeenCalledWith("/elsewhere/x");
  const again = await setup.applyRepositories(["/code/new", "/code/busy"]);
  // Unselected and not added: nothing is attempted, so nothing fails.
  expect(again.failures).toEqual([]);
});
