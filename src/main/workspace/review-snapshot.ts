import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ReviewSnapshot } from "../control/review-loops.d";
import type { WorktreeService } from "./worktrees";
import { assertInside, git } from "./worktree-operations";

/** Hash entry identity and semantic flags, excluding Git's mutable stat cache. */
function indexState(output: string): string {
  const entries: [string, number][] = [];
  let rest = output;
  while (rest) {
    const end = rest.indexOf("\0");
    if (end < 0) throw new Error("Unsupported index metadata");
    const entry = rest.slice(0, end);
    rest = rest.slice(end + 1);
    // --debug adds five lines after each NUL-terminated pathname. Read only
    // that block: filenames may contain newlines resembling debug fields.
    const debug = /^(?:[^\n\0]*\n){4}[^\n\0]*\tflags: ([0-9a-f]{1,8})\n/iu.exec(rest);
    const flags = debug?.[1];
    if (!debug || flags === undefined) throw new Error("Unsupported index metadata");
    // CE_VALID (assume-unchanged), CE_SKIP_WORKTREE, CE_INTENT_TO_ADD.
    // Stage, object id, mode and -v status are already present in entry.
    entries.push([entry, Number.parseInt(flags, 16) & 0x60008000]);
    rest = rest.slice(debug[0].length);
  }
  return JSON.stringify(entries);
}

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
  hash.update(indexState(await inspect(["ls-files", "--stage", "-v", "--debug", "-z"])));
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
  // Guard local rules that decide which untracked bytes enter the snapshot.
  // Resolve through Git so linked worktrees use the applicable metadata.
  const entries = await Promise.all(
    ["info/sparse-checkout", "info/exclude"].map(async (name) => ({
      file: ["git", name],
      path: resolve(worktree, (await inspect(["rev-parse", "--git-path", name])).trim()),
    })),
  );
  entries.push(
    ...files.map((file) => {
      const path = resolve(worktree, file);
      assertInside(worktree, path);
      return { file: ["worktree", file], path };
    }),
  );
  let total = 0;
  for (const { file, path } of entries) {
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
