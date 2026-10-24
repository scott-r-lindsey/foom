import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, record } from "./worktree-operations";

export const commitId = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;

/** Reachability from default is necessary, but cannot tie a forge hint to this head. */
export async function hintIntegratesHead(
  repository: string,
  commit: string,
  head: string,
  base: string,
): Promise<boolean> {
  if (![commit, head, base].every((sha) => commitId.test(sha))) return false;
  return withMergeProof(repository, async (run) => {
    if (!(await isAncestor(run, commit, base))) return false;
    if (await isAncestor(run, head, commit)) return true;
    const parents = (await run(["rev-list", "--parents", "-n", "1", commit])).trim().split(" ");
    const parent = parents[1];
    if (parents.length !== 2 || parents[0] !== commit || !parent || !commitId.test(parent))
      return false;
    const mergeBase = (await run(["merge-base", "--all", parent, head])).trim();
    // Multiple merge bases are ambiguous; never pick one using forge claims.
    if (!commitId.test(mergeBase)) return false;
    return mergeMatchesTree(run, parent, head, commit);
  });
}

export async function isAncestor(
  run: (args: string[]) => Promise<string>,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  if (![ancestor, descendant].every((sha) => commitId.test(sha))) return false;
  try {
    await run(["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (error) {
    // Only an ordinary non-ancestor result permits another proof or hint.
    if (!record(error) || error["code"] !== 1) throw error;
    return false;
  }
}

/** Never let repository attributes/configuration manufacture a cleanup proof. */
export async function withMergeProof(
  repository: string,
  prove: (run: (args: string[]) => Promise<string>) => Promise<boolean>,
): Promise<boolean> {
  const objects = await realpath(
    (
      await git(repository, ["rev-parse", "--path-format=absolute", "--git-path", "objects"])
    ).trim(),
  );
  if (/[\r\n]/u.test(objects)) return false;
  const format = (await git(repository, ["rev-parse", "--show-object-format"])).trim();
  if (format !== "sha1" && format !== "sha256") return false;
  const proof = await mkdtemp(join(tmpdir(), "foom-merge-proof-"));
  try {
    const run = (args: string[]) =>
      git(proof, ["-c", "core.commitGraph=false", ...args], 30_000, undefined, true);
    await run(["init", "--bare", "--template=", `--object-format=${format}`]);
    await Promise.all(
      ["info", "objects/info"].map((path) => mkdir(join(proof, path), { recursive: true })),
    );
    // Git's alternates file accepts C-quoted absolute paths. Objects are read
    // from the source store; merge output is written only in this disposable repo.
    await writeFile(join(proof, "objects/info/alternates"), `${JSON.stringify(objects)}\n`, {
      mode: 0o600,
    });
    // info/attributes has higher precedence than every versioned attributes file.
    await writeFile(
      join(proof, "info/attributes"),
      "* merge=text -text -eol -filter -working-tree-encoding\n",
      { mode: 0o600 },
    );
    // Alternates expose objects only, never source refs, grafts or config.
    // Read raw commits rather than trusting cached graphs in that object store.
    return await prove(run);
  } finally {
    await rm(proof, { recursive: true, force: true });
  }
}

export async function mergeMatchesTree(
  run: (args: string[]) => Promise<string>,
  left: string,
  head: string,
  expected: string,
): Promise<boolean> {
  if (![left, head, expected].every((sha) => commitId.test(sha))) return false;
  const expectedTree = (await run(["rev-parse", "--verify", `${expected}^{tree}`])).trim();
  if (!commitId.test(expectedTree)) return false;
  // Config controls also work on Git versions whose merge-tree has no -X.
  // The isolated repo has no other strategy or merge-driver configuration.
  const merged = (
    await run([
      "-c",
      "core.attributesFile=",
      "-c",
      "core.commitGraph=false",
      "-c",
      "core.autocrlf=false",
      "-c",
      "merge.renormalize=false",
      "-c",
      "merge.renames=false",
      "-c",
      "merge.directoryRenames=false",
      "-c",
      "diff.algorithm=histogram",
      "merge-tree",
      "--write-tree",
      "--no-messages",
      left,
      head,
    ])
  ).trim();
  return commitId.test(merged) && merged === expectedTree;
}
