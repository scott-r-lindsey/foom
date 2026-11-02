import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import * as operations from "../../../../src/main/workspace/worktree-operations";
import { IncompleteRemovalError, errorMessage } from "../../../../src/shared/application-errors";
import { git } from "../../../helpers/git.js";
import { nativeDeadline } from "../../../helpers/native-test-policy";
import { createWorktreeFixture } from "./worktree-git-fixture";

vi.mock("../../../../src/main/workspace/worktree-operations", async (original) => ({
  ...(await original<typeof operations>()),
}));
vi.setConfig({ testTimeout: nativeDeadline(5000), hookTimeout: nativeDeadline(10_000) });
const fixture = createWorktreeFixture();
afterEach(async () => {
  vi.restoreAllMocks();
  await fixture.cleanup();
});

test(
  "Git success with leftover files is an incomplete removal, never deletion authority",
  fixture.usingFixture(async () => {
    const { service, repo } = await fixture.create();
    const { path } = await service.createWorktree(repo, "feature/incomplete");
    vi.spyOn(operations, "git").mockImplementation(async (cwd, args) => {
      const { stdout } = await git(args, { cwd });
      if (args[0] === "worktree" && args[1] === "remove") {
        // Simulate Git unregistering the checkout but leaving its directory behind.
        await mkdir(path);
        await writeFile(join(path, "unknown.txt"), "must survive");
      }
      return stdout;
    });
    const error = await service.removeWorktree(repo, path).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(IncompleteRemovalError);
    expect(errorMessage(error)).toContain(`Manually clean up: ${path}`);
    expect(await readFile(join(path, "unknown.txt"), "utf8")).toBe("must survive");
    expect(await service.listWorktrees(repo)).not.toContainEqual(expect.objectContaining({ path }));
    await expect(service.removeWorktree(repo, path, true)).rejects.toThrow("worktree-missing");
    expect(await realpath(path)).toBe(path);
  }),
);
