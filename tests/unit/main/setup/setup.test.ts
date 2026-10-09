import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../../../src/main/setup/settings";
import { Setup } from "../../../../src/main/setup/setup";
import type { SetupDependencies } from "../../../../src/main/setup/setup";
import type { ScanProgress, Settings, SettingsPatch } from "../../../../src/shared/setup";

let settings: Settings;
const apply = vi.fn<(settings: Settings) => void>();
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
  vi.clearAllMocks();
  deps = {
    store: {
      get: () => settings,
      update: vi.fn((patch: SettingsPatch) => {
        settings = { ...settings, ...patch };
        return Promise.resolve(settings);
      }),
    },
    worktreeRoot: "/home/me/.foom/worktrees",
    apply,
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

test("applies stored settings at startup and reports state without key material", async () => {
  const setup = new Setup(deps);
  expect(apply).toHaveBeenCalledExactlyOnceWith(DEFAULT_SETTINGS);
  await expect(setup.state()).resolves.toEqual({
    settings: DEFAULT_SETTINGS,
    worktreeRoot: "/home/me/.foom/worktrees",
  });
});

test("saves validated settings and applies them", async () => {
  const setup = new Setup(deps);
  const state = await setup.save({ hooks: false, setupComplete: true });
  expect(state.settings).toMatchObject({ hooks: false, setupComplete: true });
  expect(apply).toHaveBeenLastCalledWith(state.settings);
  await expect(setup.save({ hooks: "no" })).rejects.toThrow("Invalid settings");
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
  const setup = new Setup({
    ...deps,
    code: {
      ...deps.code,
      home: "/nonexistent-home",
      scan: (folder) => Promise.resolve({ folder, folders: 0, truncated: false, repositories: [] }),
    },
  });
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

test("choosing a legacy appearance mode returns to Eclipse but size changes keep a theme", async () => {
  const setup = new Setup(deps);
  expect((await setup.save({ interfaceTheme: "moonlight" })).settings.interfaceTheme).toBe(
    "moonlight",
  );
  expect((await setup.save({ interfaceScale: 110 })).settings.interfaceTheme).toBe("moonlight");
  expect((await setup.save({ colorMode: "dark" })).settings.interfaceTheme).toBe("follow");
  expect(
    (await setup.save({ colorMode: "system", interfaceTheme: "deep-field" })).settings
      .interfaceTheme,
  ).toBe("deep-field");
});

test("confirms bypass once per agent, persists it and serializes concurrent saves", async () => {
  const confirm = vi.fn(() => Promise.resolve(true));
  const setup = new Setup({ ...deps, confirmBypass: confirm });
  const agentArguments = { claude: ["--permission-mode", "bypassPermissions"], codex: [], agy: [] };
  await Promise.all([setup.save({ agentArguments }), setup.save({ agentArguments })]);
  expect(confirm).toHaveBeenCalledExactlyOnceWith("claude");
  expect(settings.agentBypassAcknowledged.claude).toBe(true);
  await setup.save({ agentArguments: { claude: [], codex: [], agy: [] } });
  const reopened = new Setup({ ...deps, confirmBypass: confirm });
  await reopened.save({
    agentArguments: { ...agentArguments, agy: ["--dangerously-skip-permissions"] },
  });
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(confirm).toHaveBeenLastCalledWith("agy");
});

test("cannot forge acknowledgement and cancelled disclosure saves nothing", async () => {
  const confirm = vi.fn(() => Promise.resolve(false));
  const setup = new Setup({ ...deps, confirmBypass: confirm });
  await expect(
    setup.save({ agentBypassAcknowledged: { claude: true, codex: true, agy: true } }),
  ).rejects.toThrow("confirmation dialog");
  const patch = {
    hooks: false,
    agentArguments: { claude: [], codex: ["--dangerously-bypass-approvals-and-sandbox"], agy: [] },
  };
  await expect(setup.save(patch)).rejects.toThrow("cancelled");
  expect(settings).toEqual(DEFAULT_SETTINGS);
  await expect(new Setup(deps).save(patch)).rejects.toThrow("cancelled");
  await setup.save({ hooks: false });
  expect(settings.hooks).toBe(false);
});

test("failed persistence does not remember bypass acknowledgement", async () => {
  const confirm = vi.fn(() => Promise.resolve(true));
  const setup = new Setup({ ...deps, confirmBypass: confirm });
  vi.mocked(deps.store.update).mockRejectedValueOnce(new Error("disk full"));
  const patch = {
    agentArguments: { claude: ["--dangerously-skip-permissions"], codex: [], agy: [] },
  };
  await expect(setup.save(patch)).rejects.toThrow("disk full");
  expect(settings.agentBypassAcknowledged.claude).toBe(false);
  await setup.save(patch);
  expect(confirm).toHaveBeenCalledTimes(2);
});

test("Codex sandbox full access requires the same one-time acknowledgement as its bypass flag", async () => {
  const confirm = vi.fn(() => Promise.resolve(false));
  const setup = new Setup({ ...deps, confirmBypass: confirm });
  const patch = {
    agentArguments: { claude: [], codex: ["--sandbox", "danger-full-access"], agy: [] },
  };
  await expect(setup.save(patch)).rejects.toThrow("cancelled");
  expect(confirm).toHaveBeenCalledExactlyOnceWith("codex");
  expect(settings.agentBypassAcknowledged.codex).toBe(false);
  confirm.mockResolvedValue(true);
  await setup.save(patch);
  await setup.save({
    agentArguments: { ...patch.agentArguments, codex: ["-c", 'sandbox_mode="danger-full-access"'] },
  });
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(settings.agentBypassAcknowledged.codex).toBe(true);
});
