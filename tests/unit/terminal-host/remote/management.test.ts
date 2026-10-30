import type * as fsPromises from "node:fs/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  mkdtemp,
  realpath,
  rm,
  mkdir,
  chmod,
  symlink,
  writeFile,
  readdir,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LaunchFailure } from "../../../../src/shared/launch-failure";
import {
  HOST_CLONE_TIMEOUT_MS,
  HOST_NETWORK_GIT_TIMEOUT_MS,
} from "../../../../src/shared/registered-hosts";
import { gitSync } from "../../../helpers/git.js";
const mock = vi.hoisted(() => ({
  checkout: vi.fn(),
  discovery: vi.fn(),
  probe: vi.fn(),
  read: vi.fn(),
  lstat: vi.fn(),
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof fsPromises>();
  mock.read.mockImplementation(fs.readFile);
  mock.lstat.mockImplementation(fs.lstat);
  return { ...fs, readFile: mock.read, lstat: mock.lstat };
});
vi.mock("../../../../src/terminal-host/remote/agent-discovery", () => ({
  remoteCheckout: mock.checkout,
  hostDiscovery: mock.discovery,
  hostProbe: mock.probe,
  hostLoginEnvironment: () => Promise.resolve({ PATH: "/fixture-login" }),
}));
import {
  approvedCodeFolder,
  availableMemory,
  manageHost,
} from "../../../../src/terminal-host/remote/management";
let home: string;
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "management-")));
  mock.checkout.mockReset().mockResolvedValue("identity");
  mock.discovery.mockReset().mockResolvedValue({ version: "1.0", help: "--help" });
  mock.probe.mockReset().mockResolvedValue("");
  mock.read.mockResolvedValue("MemAvailable: 1234 kB\n");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});
test.skipIf(process.platform === "win32")(
  "approved folders are private, canonical, owned and never follow links",
  async () => {
    const folder = await approvedCodeFolder("~/code", home);
    expect(folder).toBe(join(home, "code"));
    expect(await approvedCodeFolder(folder, home)).toBe(folder);
    for (const path of ["/", join(home, "code", "..", "code") + "/", "relative"])
      await expect(approvedCodeFolder(path, home)).rejects.toThrow("unsafe");
    await chmod(folder, 0o777);
    await expect(approvedCodeFolder(folder, home)).rejects.toThrow("unsafe");
    await chmod(folder, 0o700);
    await symlink(folder, join(home, "link"));
    await expect(approvedCodeFolder(join(home, "link", "child"), home)).rejects.toThrow("unsafe");
    await writeFile(join(home, "file"), "x");
    await expect(approvedCodeFolder(join(home, "file", "child"), home)).rejects.toThrow("unsafe");
    const fs = await vi.importActual<typeof fsPromises>("node:fs/promises");
    const info = await fs.lstat(folder);
    mock.lstat.mockImplementation(async (path: string) =>
      path === folder
        ? { mode: info.mode, uid: -1, isDirectory: () => true, isSymbolicLink: () => false }
        : fs.lstat(path),
    );
    await expect(approvedCodeFolder(folder, home)).rejects.toThrow("unsafe");
    mock.lstat.mockImplementation(fs.lstat);
  },
);
test("available memory uses Linux MemAvailable and macOS free + inactive + speculative pages", async () => {
  expect(await availableMemory("linux", home)).toBe(1234 * 1024);
  mock.read.mockResolvedValue("MemFree: 100 kB");
  await expect(availableMemory("linux", home)).rejects.toThrow();
  mock.probe.mockResolvedValue(
    "Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 10.\nPages inactive: 20.\nPages speculative: 3.\nPages wired down: 900.\n",
  );
  expect(await availableMemory("darwin", home)).toBe(33 * 4096);
  for (const output of ["bad", "page size of 4096 bytes\nPages free: 1.\n"]) {
    mock.probe.mockResolvedValue(output);
    await expect(availableMemory("darwin", home)).rejects.toThrow();
  }
});
test.skipIf(process.platform === "win32")(
  "inspection returns only fixed agent states and sanitized host facts",
  async () => {
    mock.discovery
      .mockResolvedValueOnce({ version: "1", help: "--help" })
      .mockRejectedValueOnce(new LaunchFailure("remote_agent_unavailable"))
      .mockResolvedValueOnce({ version: "", help: "" })
      .mockRejectedValueOnce(new Error("raw secret"));
    const result = await manageHost(
      { type: "manage", operation: "inspect", codeFolder: "~/code" },
      3,
      "/fixture-shell",
      "0.1.0",
      home,
    );
    expect(result).toMatchObject({
      ok: true,
      facts: {
        sessions: 3,
        codeFolder: join(home, "code"),
        agents: [
          { id: "claude", state: "ready" },
          { id: "codex", state: "missing" },
          { id: "agy", state: "unable" },
          { id: "copilot", state: "unable" },
          { id: "opencode", state: "ready" },
          { id: "pi", state: "ready" },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    mock.read.mockRejectedValueOnce(new Error("raw"));
    mock.probe.mockRejectedValueOnce(new Error("raw"));
    expect(
      await manageHost(
        { type: "manage", operation: "inspect", codeFolder: "~/code", agents: [] },
        0,
        "/fixture",
        "0.1.0",
        home,
      ),
    ).toEqual({ ok: false, reason: "unreachable" });
  },
);
test.skipIf(process.platform === "win32")(
  "folder failures and custom enabled discovery fail closed",
  async () => {
    await mkdir(join(home, "unsafe"), { mode: 0o777 });
    await chmod(join(home, "unsafe"), 0o777);
    expect(
      await manageHost(
        { type: "manage", operation: "inspect", codeFolder: "~/unsafe" },
        0,
        "/fixture",
        "0.1.0",
        home,
      ),
    ).toEqual({ ok: false, reason: "unsafe-folder" });
    await writeFile(join(home, "file"), "x");
    expect(
      await manageHost(
        { type: "manage", operation: "inspect", codeFolder: "~/file/child" },
        0,
        "/fixture",
        "0.1.0",
        home,
      ),
    ).toEqual({ ok: false, reason: "unsafe-folder" });
    expect(
      await manageHost(
        { type: "manage", operation: "inspect", codeFolder: "../" },
        0,
        "/fixture",
        "0.1.0",
        home,
      ),
    ).toEqual({ ok: false, reason: "folder-refused" });
    expect(
      await manageHost(
        {
          type: "manage",
          operation: "inspect",
          codeFolder: "~/code",
          agents: [{ id: "custom", executables: ["custom-cli"] }],
        },
        0,
        "/fixture",
        "0.1.0",
        home,
      ),
    ).toMatchObject({ ok: true, facts: { agents: [{ id: "custom", state: "ready" }] } });
  },
);
test.skipIf(process.platform === "win32")(
  "repository operations stay in the approved folder, use host git access and fixed failure reasons",
  async () => {
    const request = {
      type: "manage",
      operation: "repository",
      codeFolder: "~/code",
      directory: "repo",
      origin: "git@forge.test:me/repo.git",
      agents: [],
    } as const;
    const path = join(home, "code/repo");
    expect(await manageHost(request, 0, "/fixture", "0.1.0", home)).toMatchObject({
      ok: true,
      checkout: { path, state: "absent" },
    });
    mock.probe.mockRejectedValueOnce(new Error("host denied credentials secret"));
    expect(
      await manageHost({ ...request, operation: "clone" }, 0, "/fixture", "0.1.0", home),
    ).toEqual({ ok: false, reason: "clone-failed" });
    mock.probe.mockImplementation((_cmd: string, args: string[], cwd: string) => {
      if (args.includes("clone")) {
        return Promise.resolve("");
      }
      if (args.includes("config")) return Promise.resolve(request.origin);
      if (args.includes("--show-toplevel")) return Promise.resolve(cwd);
      return Promise.resolve("");
    });
    expect(
      await manageHost({ ...request, operation: "clone" }, 0, "/fixture", "0.1.0", home),
    ).toMatchObject({ ok: true, checkout: { path, state: "clean" } });
    expect(mock.probe).toHaveBeenCalledWith(
      "git",
      [
        "--no-optional-locks",
        "clone",
        "--",
        request.origin,
        expect.stringContaining(".foom-clone-"),
      ],
      join(home, "code"),
      {
        PATH: "/fixture-login",
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_GRAFT_FILE: "/dev/null",
      },
      true,
      HOST_CLONE_TIMEOUT_MS,
      undefined,
    );
    mock.probe
      .mockResolvedValueOnce(request.origin)
      .mockResolvedValueOnce(path)
      .mockResolvedValueOnce("commit-id")
      .mockResolvedValueOnce(" M file\0");
    expect(await manageHost(request, 0, "/fixture", "0.1.0", home)).toMatchObject({
      ok: true,
      checkout: { state: "changed" },
    });
    mock.probe.mockResolvedValueOnce("different-origin");
    expect(await manageHost(request, 0, "/fixture", "0.1.0", home)).toEqual({
      ok: false,
      reason: "checkout-refused",
    });
    mock.probe.mockResolvedValueOnce(request.origin).mockResolvedValueOnce("/foreign");
    expect(await manageHost(request, 0, "/fixture", "0.1.0", home)).toEqual({
      ok: false,
      reason: "checkout-refused",
    });
    await chmod(path, 0o777);
    expect(await manageHost(request, 0, "/fixture", "0.1.0", home)).toEqual({
      ok: false,
      reason: "checkout-refused",
    });
  },
);

test.skipIf(process.platform === "win32")(
  "a refused code-folder creation reports a fixed reason without changing parent permissions",
  async () => {
    const parent = join(home, "read-only");
    await mkdir(parent, { mode: 0o500 });
    try {
      expect(
        await manageHost(
          { type: "manage", operation: "inspect", codeFolder: `${parent}/code` },
          0,
          "/fixture",
          "0.1.0",
          home,
        ),
      ).toEqual({ ok: false, reason: "folder-refused" });
    } finally {
      await chmod(parent, 0o700);
    }
  },
);

test.skipIf(process.platform === "win32")(
  "failed clones remove private staging directories and retries publish only validated checkouts",
  async () => {
    const request = {
      type: "manage",
      operation: "clone",
      codeFolder: "~/code",
      directory: "repo",
      origin: "git@forge.test:me/repo.git",
      agents: [],
    } as const;
    const folder = join(home, "code");
    const destination = join(folder, "repo");
    let fail = true;
    mock.probe.mockImplementation(async (_command: string, args: string[], cwd: string) => {
      if (!args.includes("clone")) return gitSync(args, { cwd }).toString();
      const staging = args.at(-1);
      if (!staging) throw new Error("Missing staging directory");
      expect(staging).not.toBe(destination);
      expect((await lstat(staging)).mode & 0o777).toBe(0o700);
      expect(await readdir(folder)).toEqual([staging.slice(folder.length + 1)]);
      gitSync(["init", "-q"], { cwd: staging });
      gitSync(["remote", "add", "origin", request.origin], { cwd: staging });
      await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
      if (fail) throw new Error("clone interrupted after initialization");
      gitSync(
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "commit",
          "--allow-empty",
          "-qm",
          "initial",
        ],
        { cwd: staging },
      );
      return "";
    });
    expect(await manageHost(request, 0, "/fixture", "0.1.0", home)).toEqual({
      ok: false,
      reason: "clone-failed",
    });
    expect(await readdir(folder)).toEqual([]);
    expect(
      await manageHost({ ...request, operation: "repository" }, 0, "/fixture", "0.1.0", home),
    ).toMatchObject({ ok: true, checkout: { state: "absent" } });
    fail = false;
    expect(await manageHost(request, 0, "/fixture", "0.1.0", home)).toMatchObject({
      ok: true,
      checkout: { path: destination, state: "clean" },
    });
    expect(await readdir(folder)).toEqual(["repo"]);
    expect(
      gitSync(["rev-parse", "--verify", "HEAD^{commit}"], { cwd: destination }).toString().trim(),
    ).toMatch(/^[a-f0-9]{40}$/u);
  },
);

test.skipIf(process.platform === "win32")(
  "an existing initialized repository with an unborn HEAD never reports a checkout",
  async () => {
    const path = join(home, "code/repo");
    await mkdir(path, { recursive: true, mode: 0o700 });
    const origin = "git@forge.test:me/repo.git";
    gitSync(["init", "-q"], { cwd: path });
    gitSync(["remote", "add", "origin", origin], { cwd: path });
    mock.probe.mockImplementation((_command: string, args: string[], cwd: string) =>
      Promise.resolve(gitSync(args, { cwd }).toString()),
    );
    for (const operation of ["repository", "clone"] as const)
      expect(
        await manageHost(
          {
            type: "manage",
            operation,
            codeFolder: "~/code",
            directory: "repo",
            origin,
            agents: [],
          },
          0,
          "/fixture",
          "0.1.0",
          home,
        ),
      ).toEqual({ ok: false, reason: "checkout-refused" });
  },
);

test.skipIf(process.platform === "win32").each(["unborn", "destination-appeared"] as const)(
  "a clone is not published when validation fails or its destination changes: %s",
  async (scenario) => {
    const folder = join(home, "code");
    const path = join(folder, "repo");
    const origin = "git@forge.test:me/repo.git";
    mock.probe.mockImplementation(async (_command: string, args: string[], cwd: string) => {
      if (!args.includes("clone")) return gitSync(args, { cwd }).toString();
      const staging = args.at(-1);
      if (!staging) throw new Error("Missing staging directory");
      gitSync(["init", "-q"], { cwd: staging });
      gitSync(["remote", "add", "origin", origin], { cwd: staging });
      if (scenario === "destination-appeared") {
        gitSync(
          [
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "--allow-empty",
            "-qm",
            "initial",
          ],
          { cwd: staging },
        );
        await mkdir(path, { mode: 0o700 });
        await writeFile(join(path, "keep"), "existing directory");
      }
      return "";
    });
    expect(
      await manageHost(
        {
          type: "manage",
          operation: "clone",
          codeFolder: "~/code",
          directory: "repo",
          origin,
          agents: [],
        },
        0,
        "/fixture",
        "0.1.0",
        home,
      ),
    ).toEqual({
      ok: false,
      reason: scenario === "unborn" ? "clone-failed" : "checkout-refused",
    });
    expect(await readdir(folder)).toEqual(scenario === "unborn" ? [] : ["repo"]);
    if (scenario === "destination-appeared") expect(await readdir(path)).toEqual(["keep"]);
  },
);

test.skipIf(process.platform === "win32")(
  "branch worktrees are fetched from the default, remain inside the approved folder, and removal binds identity and displayed changes",
  async () => {
    const folder = await approvedCodeFolder("~/code", home);
    const repository = join(folder, "repo");
    await mkdir(repository, { mode: 0o700 });
    const base = {
      type: "manage",
      codeFolder: folder,
      directory: "repo",
      origin: "git@fixture.test:team/repo.git",
      agents: [],
    } as const;
    let changes = "";
    let refs = "";
    let advertised = "ref: refs/heads/main\tHEAD\n";
    mock.probe.mockImplementation((_command: string, args: string[], cwd: string) => {
      if (args.includes("config")) return Promise.resolve(base.origin);
      if (args.includes("--show-toplevel")) return Promise.resolve(cwd);
      if (args.includes("for-each-ref")) return Promise.resolve(refs);
      if (args.includes("ls-remote")) return Promise.resolve(advertised);
      if (args.includes("symbolic-ref")) return Promise.resolve("feature\n");
      if (args.includes("status") && cwd !== repository) return Promise.resolve(changes);
      return Promise.resolve("");
    });
    const created = await manageHost(
      { ...base, operation: "create-worktree", branch: "feature" },
      0,
      "/fixture",
      "0.1.0",
      home,
    );
    if (!created.ok || !created.worktree) throw new Error("Missing worktree");
    const tree = created.worktree;
    expect(tree.path).toMatch(new RegExp(`^${folder}/\\.foom-worktree-[a-f0-9-]+$`, "u"));
    expect(mock.probe).toHaveBeenCalledWith(
      "git",
      ["--no-optional-locks", "ls-remote", "--symref", "origin", "HEAD"],
      repository,
      expect.anything(),
      true,
      HOST_NETWORK_GIT_TIMEOUT_MS,
      undefined,
    );
    expect(mock.probe).toHaveBeenCalledWith(
      "git",
      [
        "--no-optional-locks",
        "fetch",
        "--no-tags",
        "origin",
        "+refs/heads/main:refs/remotes/origin/main",
      ],
      repository,
      expect.anything(),
      true,
      HOST_CLONE_TIMEOUT_MS,
      undefined,
    );
    expect(mock.probe).toHaveBeenCalledWith(
      "git",
      [
        "--no-optional-locks",
        "worktree",
        "add",
        "--no-track",
        "-b",
        "feature",
        "--",
        tree.path,
        "refs/remotes/origin/main",
      ],
      repository,
      expect.anything(),
      true,
      5000,
      undefined,
    );
    mock.probe.mockClear();
    expect(
      await manageHost(
        { ...base, operation: "create-worktree", branch: "pr-branch", fromOrigin: true },
        0,
        "/fixture",
        "0.1.0",
        home,
      ),
    ).toMatchObject({ ok: true, worktree: { branch: "pr-branch" } });
    expect(mock.probe).toHaveBeenCalledWith(
      "git",
      [
        "--no-optional-locks",
        "fetch",
        "--no-tags",
        "origin",
        "+refs/heads/pr-branch:refs/remotes/origin/pr-branch",
      ],
      repository,
      expect.anything(),
      true,
      HOST_CLONE_TIMEOUT_MS,
      undefined,
    );
    expect(mock.probe).toHaveBeenCalledWith(
      "git",
      ["--no-optional-locks", "config", "branch.pr-branch.pushRemote", "origin"],
      repository,
      expect.anything(),
      true,
      5000,
      undefined,
    );
    expect(
      await manageHost(
        { ...base, operation: "create-worktree", branch: "main", fromOrigin: true },
        0,
        "/fixture",
        "0.1.0",
        home,
      ),
    ).toEqual({ ok: false, reason: "checkout-refused" });
    const request = {
      ...base,
      operation: "inspect-worktree",
      path: tree.path,
      identity: tree.identity,
    } as const;
    changes = "?? new-file\n";
    expect(await manageHost(request, 0, "/fixture", "0.1.0", home)).toMatchObject({
      ok: true,
      worktree: { changes },
    });
    for (const invalid of [
      { ...request, path: repository },
      { ...request, path: "/outside" },
      { ...request, path: `${tree.path}/nested` },
      { ...request, identity: "b".repeat(64) },
    ])
      expect(await manageHost(invalid, 0, "/fixture", "0.1.0", home)).toEqual({
        ok: false,
        reason: "checkout-refused",
      });
    const removal = { ...request, operation: "remove-worktree", changes: "" } as const;
    expect(await manageHost(removal, 0, "/fixture", "0.1.0", home)).toEqual({
      ok: false,
      reason: "checkout-refused",
    });
    expect(
      mock.probe.mock.calls.some(([, args]) => Array.isArray(args) && args.includes("remove")),
    ).toBe(false);
    expect(await manageHost({ ...removal, changes }, 0, "/fixture", "0.1.0", home)).toMatchObject({
      ok: true,
    });
    expect(mock.probe).toHaveBeenCalledWith(
      "git",
      ["--no-optional-locks", "worktree", "remove", "--force", "--", tree.path],
      repository,
      expect.anything(),
      true,
      5000,
      undefined,
    );
    mock.checkout.mockResolvedValueOnce("identity").mockResolvedValueOnce("replaced");
    expect(await manageHost({ ...removal, changes }, 0, "/fixture", "0.1.0", home)).toEqual({
      ok: false,
      reason: "checkout-refused",
    });
    changes = "x".repeat(65537);
    expect(await manageHost(request, 0, "/fixture", "0.1.0", home)).toEqual({
      ok: false,
      reason: "checkout-refused",
    });
    refs = "refs/heads/feature\n";
    expect(
      await manageHost(
        { ...base, operation: "create-worktree", branch: "feature" },
        0,
        "/fixture",
        "0.1.0",
        home,
      ),
    ).toEqual({ ok: false, reason: "checkout-refused" });
    refs = "";
    for (const value of ["", "ref: refs/heads/-evil\tHEAD\n"]) {
      advertised = value;
      expect(
        await manageHost(
          { ...base, operation: "create-worktree", branch: "feature" },
          0,
          "/fixture",
          "0.1.0",
          home,
        ),
      ).toEqual({ ok: false, reason: "checkout-refused" });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "detached remote removal requires HEAD reachability from a retained public ref and refuses changing evidence",
  async () => {
    const folder = await approvedCodeFolder("~/code", home);
    const repository = join(folder, "repo");
    const path = join(folder, ".foom-worktree-detached");
    await mkdir(repository, { mode: 0o700 });
    await mkdir(path, { mode: 0o700 });
    const { createHash } = await import("node:crypto");
    const identity = createHash("sha256").update("identity").digest("hex");
    const request = {
      type: "manage",
      operation: "remove-worktree",
      codeFolder: folder,
      directory: "repo",
      origin: "git@fixture.test:team/repo.git",
      agents: [],
      path,
      identity,
      changes: "",
    } as const;
    let symbolic = "HEAD";
    let refs = "refs/heads/preserved\n";
    let head = "a".repeat(40);
    let changed = false;
    let reads = 0;
    mock.probe.mockImplementation((_command: string, args: string[], cwd: string) => {
      if (args.includes("config")) return Promise.resolve(request.origin);
      if (args.includes("--show-toplevel")) return Promise.resolve(cwd);
      if (args.includes("symbolic-ref")) return Promise.reject(new Error("Detached HEAD"));
      if (args.includes("--symbolic-full-name")) return Promise.resolve(symbolic);
      if (args.includes("HEAD^{commit}"))
        return Promise.resolve(changed && cwd === path && reads++ > 0 ? "b".repeat(40) : head);
      if (args.includes("for-each-ref")) return Promise.resolve(refs);
      return Promise.resolve("");
    });
    expect(
      await manageHost({ ...request, operation: "inspect-worktree" }, 0, "/fixture", "0.1.0", home),
    ).toMatchObject({ ok: true, worktree: { branch: "HEAD" } });
    expect(await manageHost(request, 0, "/fixture", "0.1.0", home)).toMatchObject({ ok: true });
    expect(mock.probe).toHaveBeenCalledWith(
      "git",
      [
        "--no-optional-locks",
        "-c",
        "core.commitGraph=false",
        "for-each-ref",
        "--format=%(refname)",
        `--contains=${head}`,
        "refs/heads",
        "refs/remotes",
        "refs/tags",
      ],
      path,
      expect.objectContaining({ GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/dev/null" }),
      true,
      5000,
      undefined,
    );
    refs = "";
    expect(await manageHost(request, 0, "/fixture", "0.1.0", home)).toEqual({
      ok: false,
      reason: "checkout-refused",
    });
    refs = "refs/heads/preserved\n";
    head = "malformed";
    expect(await manageHost(request, 0, "/fixture", "0.1.0", home)).toEqual({
      ok: false,
      reason: "checkout-refused",
    });
    head = "a".repeat(40);
    changed = true;
    expect(await manageHost(request, 0, "/fixture", "0.1.0", home)).toEqual({
      ok: false,
      reason: "checkout-refused",
    });
    symbolic = "refs/heads/other";
    expect(await manageHost(request, 0, "/fixture", "0.1.0", home)).toEqual({
      ok: false,
      reason: "checkout-refused",
    });
  },
);

test.skipIf(process.platform === "win32").each(["replacement", "graft"] as const)(
  "detached remote removal ignores %s history overlays",
  async (overlay) => {
    const folder = await approvedCodeFolder("~/code", home);
    const repository = join(folder, "repo");
    const path = join(folder, ".foom-worktree-detached");
    await mkdir(repository, { mode: 0o700 });
    const git = (...args: string[]) => gitSync(args, { cwd: repository }).toString().trim();
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.test");
    git("commit", "--allow-empty", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    git("worktree", "add", "--detach", path, base);
    gitSync(["commit", "--allow-empty", "-qm", "detached work"], { cwd: path });
    const head = gitSync(["rev-parse", "HEAD"], { cwd: path }).toString().trim();
    git("commit", "--allow-empty", "-qm", "retained branch");
    const retained = git("rev-parse", "HEAD");
    if (overlay === "replacement") git("replace", "--graft", retained, head);
    else await writeFile(join(repository, ".git/info/grafts"), `${retained} ${head}\n`);
    expect(
      git(
        "-c",
        "core.commitGraph=false",
        "for-each-ref",
        `--contains=${head}`,
        "--format=%(refname)",
        "refs/heads/",
      ),
    ).toBe("refs/heads/main");
    git("remote", "add", "origin", "git@fixture.test:team/repo.git");

    // gitSync strips inherited GIT_* selectors. This fixture adapter restores only
    // the two history controls supplied by management, after that isolation step.
    const bin = join(home, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh
if [ -n "$FIXTURE_NO_REPLACE" ]; then export GIT_NO_REPLACE_OBJECTS="$FIXTURE_NO_REPLACE"; fi
if [ -n "$FIXTURE_GRAFT_FILE" ]; then export GIT_GRAFT_FILE="$FIXTURE_GRAFT_FILE"; fi
exec /usr/bin/git "$@"
`,
      { mode: 0o700 },
    );
    mock.probe.mockImplementation(
      async (_command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
        Promise.resolve(
          gitSync(args, {
            cwd,
            env: {
              PATH: `${bin}:/usr/bin:/bin`,
              FIXTURE_NO_REPLACE: env["GIT_NO_REPLACE_OBJECTS"],
              FIXTURE_GRAFT_FILE: env["GIT_GRAFT_FILE"],
            },
          }).toString(),
        ),
    );
    const { createHash } = await import("node:crypto");
    const request = {
      type: "manage",
      operation: "remove-worktree",
      codeFolder: folder,
      directory: "repo",
      origin: "git@fixture.test:team/repo.git",
      agents: [],
      path,
      identity: createHash("sha256").update("identity").digest("hex"),
      changes: "",
    } as const;
    const result = await manageHost(request, 0, "/fixture", "0.1.0", home);
    expect(result).toEqual({ ok: false, reason: "checkout-refused" });
    expect(await realpath(path)).toBe(path);
    expect(gitSync(["rev-parse", "HEAD"], { cwd: path }).toString().trim()).toBe(head);
    // A real retained ref still permits removal while the overlay remains present.
    git("update-ref", "refs/tags/saved-detached-work", head);
    expect(await manageHost(request, 0, "/fixture", "0.1.0", home)).toMatchObject({ ok: true });
    await expect(realpath(path)).rejects.toThrow();
  },
);
