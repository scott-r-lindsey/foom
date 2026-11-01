import { mkdir, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Workspace } from "../../../../src/main/workspace/workspace";
import { git } from "../../../helpers/git.js";
import { createWorktreeFixture } from "./worktree-git-fixture";

const fixture = createWorktreeFixture();
afterEach(() => fixture.cleanup());

for (const mode of [
  "small",
  "large",
  "external",
  "nested ignored",
  "untracked large",
  "ignored symlink",
  "changed to file",
  "changed to symlink",
  "tracked edit",
  "untracked edit",
]) {
  it(
    `merged cleanup inspects ${mode} output with real Git`,
    fixture.usingFixture(async () => {
      const { temporary, repo, service } = await fixture.create();
      const run = async (...args: string[]) => (await git(args, { cwd: repo })).stdout;
      await writeFile(join(repo, ".gitignore"), "node_modules\n");
      await run("add", ".gitignore");
      await run(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "ignore build output",
      );
      const created = await service.createWorktree(repo, "merged-feature");
      const target = mode === "external" ? join(temporary, "external") : created.path;
      if (mode === "external") await run("worktree", "move", created.path, target);
      await writeFile(join(target, "feature.txt"), "merged content\n");
      await git(["add", "feature.txt"], { cwd: target });
      await git(
        ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "feature"],
        { cwd: target },
      );
      await run(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "merge",
        "--no-ff",
        "merged-feature",
        "-m",
        "merge feature",
      );
      const remote = join(temporary, "remote.git");
      await run("clone", "--bare", repo, remote);
      await run("remote", "add", "origin", remote);
      const output = join(target, "node_modules");
      await mkdir(output);
      // A bounded fixture of empty package files reproduces the inspection budget.
      const count = mode === "large" || mode === "untracked large" ? 10_001 : 1;
      for (let start = 0; start < count; start += 100) {
        await Promise.all(
          Array.from({ length: Math.min(100, count - start) }, (_, i) =>
            writeFile(join(output, `package-${String(start + i)}.js`), ""),
          ),
        );
      }
      if (mode === "nested ignored") await mkdir(join(output, ".git"));
      if (mode === "untracked large") await rename(output, join(target, "untracked-output"));
      if (mode === "ignored symlink") {
        await rename(output, join(temporary, "packages"));
        await symlink(join(temporary, "packages"), output, "junction");
      }
      expect(
        (await git(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: target })).stdout,
      ).toEqual(mode === "untracked large" ? expect.stringContaining("?? untracked-output/") : "");
      const base = await service.mergedDefault(repo, true);
      const tree = (await service.listWorktrees(repo)).find((item) => item.path === target);
      if (!tree) throw new Error("Missing fixture worktree");
      expect(await service.mergedCommit(repo, tree, base)).toBe(true);
      if (mode === "untracked large") {
        await expect(service.cleanupStatus(repo, target)).rejects.toThrow(
          "Cleanup directory walk exceeded its limit",
        );
      } else if (mode === "ignored symlink") {
        await expect(service.cleanupStatus(repo, target)).rejects.toThrow("Ignored symlinks");
      } else {
        expect(await service.cleanupStatus(repo, target)).toBe("!! node_modules/\0");
        if (mode === "external")
          await expect(service.cleanupChanges(repo, target)).rejects.toThrow(
            "Worktree path must stay inside its allowed root",
          );
      }
      const mutation = mode.startsWith("changed to") || mode.endsWith(" edit");
      const eligible = !["external", "untracked large", "ignored symlink"].includes(mode);
      const workspace = new Workspace({
        worktrees: service,
        terminals: {
          create: () => Promise.reject(new Error("No launch")),
          stop: () => Promise.resolve(true),
          kill: () => Promise.resolve(),
          tail: () => Promise.resolve([]),
        },
        verdicts: {
          forget: vi.fn(),
          classify: () => Promise.reject(new Error("No verdict")),
          commit: () => Promise.resolve(),
          recordAction: () => Promise.resolve(),
        },
        receiver: () => Promise.reject(new Error("No hooks")),
        onState: () => {},
        prepareWorktreeRemoval: async () => {
          if (mode.startsWith("changed to")) {
            await rename(output, join(temporary, "packages"));
            if (mode === "changed to file") await writeFile(output, "replacement");
            else await symlink(join(temporary, "packages"), output, "junction");
          } else if (mode === "tracked edit")
            await writeFile(join(target, "feature.txt"), "keep tracked edit");
          else if (mode === "untracked edit")
            await writeFile(join(target, "keep.txt"), "keep untracked edit");
          return () => {};
        },
      });
      let reviewed = false;
      try {
        await workspace.sidebarCommand(
          { kind: "delete-merged-worktrees", repository: repo },
          async (request) => {
            if (request.kind !== "merged-worktrees" || !request.feed)
              throw new Error("Missing feed");
            const feed = request.feed;
            // The real Git/directory scan can outlast waitFor's one-second default.
            // Subscribe before reading so completion cannot race the listener.
            await new Promise<void>((resolve) => {
              const completed = () => {
                if (feed.current().stage !== "checking") {
                  unsubscribe();
                  resolve();
                }
              };
              const unsubscribe = feed.subscribe(completed);
              completed();
            });
            expect(feed.current().stage).toBe("ready");
            reviewed = true;
            const item = request.feed
              .current()
              .progress.items.find((item) => item.branch === "merged-feature");
            const reason =
              mode === "untracked large" || mode === "ignored symlink"
                ? "unavailable"
                : mode === "external"
                  ? "uncommitted changes"
                  : undefined;
            expect(item).toBeDefined();
            expect(item?.reason).toBe(reason);
            return eligible;
          },
        );
        expect(reviewed).toBe(true);
        if (eligible && !mutation) {
          await expect(realpath(target)).rejects.toThrow();
        } else {
          expect(await realpath(target)).toBe(target);
          if (mode === "tracked edit")
            expect(await readFile(join(target, "feature.txt"), "utf8")).toBe("keep tracked edit");
          if (mode === "untracked edit")
            expect(await readFile(join(target, "keep.txt"), "utf8")).toBe("keep untracked edit");
        }
      } finally {
        await workspace.dispose();
      }
    }),
  );
}
