import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ReviewSnapshot } from "../control/review-loops.d";
import type { WorktreeService } from "./worktrees";
import { assertInside, git } from "./worktree-operations";

/** Bounded local Git snapshot, never output or a model request. Ignored files are excluded. */
export async function reviewSnapshot(
  service: Pick<WorktreeService, "launchIdentity">,
  repository: string,
  worktree: string,
  identity: string,
): Promise<ReviewSnapshot> {
  const validate = async () => {
    if ((await service.launchIdentity(repository, worktree)) !== identity)
      throw new Error("Worktree changed");
  };
  const inspect = (args: string[]) =>
    git(worktree, ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], 3000);
  await validate();
  const head = (await inspect(["rev-parse", "HEAD"])).trim();
  const hash = createHash("sha256").update(head);
  hash.update(JSON.stringify(await inspect(["ls-files", "--stage", "-z"])));
  // Read tracked bytes as well as untracked files; diff alone misses skip-worktree
  // entries and changes within an already-dirty file. No filters or diff helpers run.
  const files = [
    ...new Set(
      (await inspect(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]))
        .split("\0")
        .filter(Boolean),
    ),
  ].sort();
  if (files.some((file) => file.includes("\ufffd")))
    throw new Error("Unsupported filename encoding");
  if (files.length > 10000) throw new Error("Snapshot capacity");
  let total = 0;
  for (const file of files) {
    const path = resolve(worktree, file);
    assertInside(worktree, path);
    const stat = await lstat(path).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) {
      hash.update(JSON.stringify([file, "missing"]));
      continue;
    }
    const parent = await realpath(dirname(path));
    if (parent !== dirname(path)) throw new Error("Redirected snapshot path");
    if (stat.isSymbolicLink())
      hash.update(
        JSON.stringify([
          file,
          stat.mode,
          "link",
          (await readlink(path, { encoding: "buffer" })).toString("hex"),
        ]),
      );
    else {
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024 - total)
        throw new Error("Snapshot capacity");
      const handle = await open(
        path,
        constants.O_RDONLY |
          (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
      );
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev)
          throw new Error("Snapshot changed");
        const content = createHash("sha256");
        const buffer = Buffer.alloc(65536);
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          total += bytesRead;
          if (total > 32 * 1024 * 1024) throw new Error("Snapshot capacity");
          content.update(buffer.subarray(0, bytesRead));
        }
        hash.update(JSON.stringify([file, stat.mode, "file", content.digest("hex")]));
      } finally {
        await handle.close();
      }
    }
  }
  await validate();
  if ((await inspect(["rev-parse", "HEAD"])).trim() !== head) throw new Error("Snapshot changed");
  return { head, digest: hash.digest("hex") };
}
