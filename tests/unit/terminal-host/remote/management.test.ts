import type * as fsPromises from "node:fs/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, realpath, rm, mkdir, chmod, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LaunchFailure } from "../../../../src/shared/launch-failure";
const mock = vi.hoisted(() => ({
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
    mock.probe.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes("clone")) {
        await mkdir(path, { mode: 0o700 });
        return "";
      }
      if (args.includes("config")) return request.origin;
      if (args.includes("rev-parse")) return path;
      return "";
    });
    expect(
      await manageHost({ ...request, operation: "clone" }, 0, "/fixture", "0.1.0", home),
    ).toMatchObject({ ok: true, checkout: { path, state: "clean" } });
    expect(mock.probe).toHaveBeenCalledWith(
      "git",
      ["--no-optional-locks", "clone", "--", request.origin, path],
      join(home, "code"),
      { PATH: "/fixture-login", GIT_TERMINAL_PROMPT: "0" },
      true,
    );
    mock.probe
      .mockResolvedValueOnce(request.origin)
      .mockResolvedValueOnce(path)
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
