import * as fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import {
  hintIntegratesHead,
  isAncestor,
  mergeMatchesTree,
  withMergeProof,
} from "../../../../src/main/workspace/merge-proof";
import { git } from "../../../../src/main/workspace/worktree-operations";
import type * as operations from "../../../../src/main/workspace/worktree-operations";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof fs>()),
  realpath: vi.fn(),
}));
vi.mock("../../../../src/main/workspace/worktree-operations", async (original) => ({
  ...(await original<typeof operations>()),
  git: vi.fn(),
}));

const head = "a".repeat(40);
const base = "b".repeat(40);

it("refuses malformed proof inputs before running Git", async () => {
  const run = vi.fn();
  await expect(hintIntegratesHead("repo", "--help", head, base)).resolves.toBe(false);
  await expect(isAncestor(run, head, "bad")).resolves.toBe(false);
  await expect(mergeMatchesTree(run, head, base, "bad")).resolves.toBe(false);
  expect(run).not.toHaveBeenCalled();
  expect(git).not.toHaveBeenCalled();
});

it("permits only exit one to mean non-ancestry", async () => {
  const run = vi.fn();
  run.mockRejectedValueOnce({ code: 1 });
  await expect(isAncestor(run, head, base)).resolves.toBe(false);
  for (const error of [{ code: 128 }, "broken transport"]) {
    run.mockRejectedValueOnce(error);
    await expect(isAncestor(run, head, base)).rejects.toBe(error);
  }
});

it("refuses malformed tree output and propagates Git failures", async () => {
  const run = vi.fn();
  run.mockResolvedValueOnce("not-a-tree");
  await expect(mergeMatchesTree(run, head, base, head)).resolves.toBe(false);
  expect(run).toHaveBeenCalledTimes(1);
  run.mockResolvedValueOnce(head).mockResolvedValueOnce("invalid merged tree");
  await expect(mergeMatchesTree(run, head, base, head)).resolves.toBe(false);
  run.mockResolvedValueOnce(head).mockRejectedValueOnce(new Error("conflict"));
  await expect(mergeMatchesTree(run, head, base, head)).rejects.toThrow("conflict");
});

it("refuses newline alternates and unsupported object formats before creating proof storage", async () => {
  const prove = vi.fn();
  vi.mocked(fs.realpath).mockResolvedValueOnce("/objects\ninjected");
  vi.mocked(git).mockResolvedValue("objects");
  await expect(withMergeProof("repo", prove)).resolves.toBe(false);
  vi.mocked(fs.realpath).mockResolvedValueOnce("/objects");
  vi.mocked(git).mockResolvedValueOnce("objects").mockResolvedValueOnce("unsupported");
  await expect(withMergeProof("repo", prove)).resolves.toBe(false);
  expect(prove).not.toHaveBeenCalled();
});

it("isolates SHA-256 proof execution and removes temporary output even after refusal", async () => {
  vi.mocked(fs.realpath).mockResolvedValue("/objects");
  vi.mocked(git)
    .mockReset()
    .mockResolvedValueOnce("objects")
    .mockResolvedValueOnce("sha256")
    .mockResolvedValue("");
  let directory: string | undefined;
  await expect(
    withMergeProof("repo", async (run) => {
      directory = vi.mocked(git).mock.calls[2]?.[0];
      if (!directory) throw new Error("Missing proof repository");
      expect(await fs.readFile(`${directory}/objects/info/alternates`, "utf8")).toBe(
        '"/objects"\n',
      );
      expect(await fs.readFile(`${directory}/info/attributes`, "utf8")).toBe(
        "* merge=text -text -eol -filter -working-tree-encoding\n",
      );
      await run(["merge-base", "--is-ancestor", head, base]);
      throw new Error("proof refused");
    }),
  ).rejects.toThrow("proof refused");
  expect(git).toHaveBeenNthCalledWith(
    3,
    expect.any(String),
    ["-c", "core.commitGraph=false", "init", "--bare", "--template=", "--object-format=sha256"],
    30_000,
    undefined,
    true,
  );
  expect(git).toHaveBeenLastCalledWith(
    directory,
    ["-c", "core.commitGraph=false", "merge-base", "--is-ancestor", head, base],
    30_000,
    undefined,
    true,
  );
  if (!directory) throw new Error("Missing proof directory");
  await expect(fs.lstat(directory)).rejects.toThrow();
});
