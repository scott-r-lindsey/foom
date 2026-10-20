import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { git } from "../../../helpers/git.js";
import { FAKE_GH } from "../../../helpers/forge-cli.js";
import { ForgeRuntime } from "../../../../src/main/control/forge-runtime";
import { forgeProvider } from "../../../helpers/legacy-forge";
import { forgeValue } from "../../../../src/main/control/forge-mapping";
import { executeForge, resolveForgeExecutable } from "../../../../src/main/control/forge-process";
import { parseForgeManifest } from "../../../../src/shared/forge-manifest";
import github from "../../../../src/shared/bundled-forges/github.json";
import { WorktreeService } from "../../../../src/main/workspace/worktrees";

vi.mock("../../../../src/main/control/forge-process", () => ({
  executeForge: vi.fn(),
  resolveForgeExecutable: vi.fn(),
  ForgeExecutionError: class extends Error {},
}));

describe.each(["legacy", "manifest"] as const)("adoption integration parity: %s", (mode) => {
  let root: string;
  let repo: string;
  let state: string;
  let service: WorktreeService;
  let runtime: ForgeRuntime;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "foom-forge-adopt-")));
    repo = join(root, "repo");
    const remote = join(root, "remote.git");
    await mkdir(repo);
    const run = (args: string[]) => git(args, { cwd: repo });
    await run(["init", "-b", "main"]);
    await run([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=t@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "init",
    ]);
    await run(["branch", "child-one"]);
    await run(["clone", "--bare", repo, remote]);
    await run(["branch", "-D", "child-one"]);
    await run(["remote", "add", "origin", "https://github.com/o/r.git"]);
    await run(["config", `url.${remote}.insteadOf`, "https://github.com/o/r.git"]);
    state = join(root, "state.json");
    await writeFile(state, "{}");
    const script = join(root, "fixture-gh.cjs");
    await writeFile(script, FAKE_GH);
    const execute = async (args: readonly string[]) =>
      promisify(execFile)(process.execPath, [script, ...args], {
        env: { TEST_FORGE_STATE: state },
      });
    vi.mocked(resolveForgeExecutable).mockResolvedValue({
      executable: script,
      identity: "fixture-executable-1",
    });
    vi.mocked(executeForge).mockImplementation(async (_exe, args) => ({
      code: 0,
      stderr: "",
      stdout: (await execute(args)).stdout,
    }));
    runtime = new ForgeRuntime(
      () => ({ forges: { hostile: true }, forgeHosts: { "github.com": "hostile" } }),
      () => Promise.resolve(root),
    );
    // Even a renamed config manifest with its own state table cannot grant adoption authority.
    const manifest = parseForgeManifest(
      JSON.stringify({
        ...github,
        id: "hostile",
        mapping: {
          ...github.mapping,
          states: { ...github.mapping.states, CLOSED: "OPEN" },
        },
      }),
    );
    runtime.replace([{ manifest, digest: "hostile-fixture", validate: async () => {} }]);
    service = new WorktreeService(
      join(root, "worktrees"),
      mode === "manifest"
        ? runtime.provider
        : (url) => forgeProvider(url, async (args) => (await execute(args)).stdout),
    );
    await service.addRepository(repo);
  });
  afterEach(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  it("adopts a same-repository head through the worktree entry point", async () => {
    const adopted = await service.adoptWorktree(repo, 340, [], vi.fn());
    expect(adopted.branch).toBe("child-one");
    expect(await service.launchIdentity(repo, adopted.path)).toBe(adopted.identity);
  });
  it.each([
    [{ isCrossRepository: true }, "pr_from_fork"],
    [{ headRepositoryOwner: { login: "another-owner" } }, "pr_from_fork"],
    [{ headRefName: "main" }, "default_branch"],
  ])("keeps Foom refusal policy for %j", async (pr, refusal) => {
    await writeFile(state, JSON.stringify({ pr }));
    await expect(service.adoptWorktree(repo, 340, [], vi.fn())).rejects.toThrow(refusal);
  });
  it("replays the recorded public fork through adoption without modifying its ownership evidence", async () => {
    const envelope: unknown = JSON.parse(
      await readFile("spikes/forge-manifests/fixtures/gh-view-public.json", "utf8"),
    );
    const stdout = forgeValue(envelope, ["stdout"]);
    if (typeof stdout !== "string") throw new Error("Missing capture");
    const pr: unknown = JSON.parse(stdout);
    await writeFile(state, JSON.stringify({ pr }));
    await expect(service.adoptWorktree(repo, 14700, [], vi.fn())).rejects.toThrow("pr_from_fork");
  });
  it.skipIf(mode === "legacy").each(["remote", "branch", "identity", "registration"])(
    "refuses publication when %s changes during CLI execution",
    async (change) => {
      const original = vi.mocked(executeForge).getMockImplementation();
      vi.mocked(executeForge).mockImplementation(async (...args) => {
        const response = await original?.(...args);
        if (args[1][1] === "view") {
          if (change === "remote")
            await git(["remote", "set-url", "origin", "https://github.com/other/repo.git"], {
              cwd: repo,
            });
          if (change === "branch") await git(["checkout", "-b", "changed"], { cwd: repo });
          if (change === "identity")
            vi.spyOn(service, "launchIdentity").mockResolvedValue("replaced");
          if (change === "registration") await service.removeRepository(repo);
        }
        return response ?? { code: 2, stdout: "", stderr: "" };
      });
      await expect(service.adoptWorktree(repo, 340, [], vi.fn())).rejects.toThrow(
        "forge_unavailable",
      );
    },
  );
});
