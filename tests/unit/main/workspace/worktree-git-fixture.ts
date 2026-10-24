import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { WorktreeService } from "../../../../src/main/workspace/worktrees";
import { git } from "../../../helpers/git.js";

/** Fresh state per suite; tracked native work settles before fixture removal. */
export function createWorktreeFixture() {
  const pending = new Set<Promise<void>>();
  const directories: string[] = [];
  return {
    // Vitest timeouts do not cancel callbacks. Keep the whole callback, including
    // Git started after a timeout, alive through teardown.
    usingFixture: (work: () => Promise<void>): (() => Promise<void>) => {
      return () => {
        const operation = work();
        pending.add(operation);
        return operation;
      };
    },
    async create() {
      const temporary = await realpath(await mkdtemp(join(tmpdir(), "foom-worktrees-")));
      directories.push(temporary);
      const repo = join(temporary, "repo with spaces");
      const root = join(temporary, "root");
      await mkdir(repo);
      await git(["init", "-b", "main"], { cwd: repo });
      await git(
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--allow-empty",
          "-m",
          "Initial",
        ],
        { cwd: repo },
      );
      const service = new WorktreeService(root);
      await service.addRepository(repo);
      return { temporary, repo, root, service };
    },
    async cleanup(): Promise<void> {
      await Promise.allSettled(pending);
      pending.clear();
      vi.unstubAllEnvs();
      for (const directory of directories.splice(0))
        await rm(directory, { recursive: true, force: true });
    },
  };
}
