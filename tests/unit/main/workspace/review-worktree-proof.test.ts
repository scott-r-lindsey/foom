import { expect, it, vi } from "vitest";
import type { Worktree } from "../../../../src/shared/worktrees";
import { unchangedReview } from "../../../../src/main/workspace/review-worktrees";
import { git } from "../../../../src/main/workspace/worktree-operations";

vi.mock("../../../../src/main/workspace/worktree-operations", async (original) => {
  const actual = await original<Record<string, unknown>>();
  return { ...actual, git: vi.fn() };
});

const head = "a".repeat(40);
const other = "b".repeat(40);
function fixture() {
  const tree: Worktree = {
    path: "/review",
    branch: null,
    head,
    bare: false,
    locked: false,
    prunable: false,
    managed: true,
  };
  const source = {
    launchIdentity: vi.fn(() => Promise.resolve("identity")),
    listWorktrees: vi.fn(() => Promise.resolve([tree])),
    cleanupStatus: vi.fn(() => Promise.resolve("")),
  };
  const facts: {
    config: string;
    configError: Error | undefined;
    refs: string;
    count: string;
    head: string;
    symbolic: string;
  } = {
    config: "true",
    configError: undefined,
    refs: `refs/heads/author\t${head}\n`,
    count: "0",
    head,
    symbolic: "HEAD",
  };
  vi.mocked(git)
    .mockReset()
    .mockImplementation((_path, args) => {
      const query = args[0] === "-c" ? args.slice(2) : args;
      switch (query[0]) {
        case "config":
          return facts.configError === undefined
            ? Promise.resolve(facts.config)
            : Promise.reject(facts.configError);
        case "for-each-ref":
          return Promise.resolve(facts.refs);
        case "rev-list":
          return Promise.resolve(facts.count);
        case "rev-parse":
          return Promise.resolve(
            args.includes("--symbolic-full-name") ? facts.symbolic : facts.head,
          );
        default:
          return Promise.reject(new Error("Unexpected Git proof command"));
      }
    });
  const review = { head, branch: "feature", refs: facts.refs };
  const check = () => unchangedReview(source, "/repo", "/review", "identity", review);
  return { tree, source, facts, review, check };
}

it("accepts an unchanged review, default reflog configuration and new refs within its captured history", async () => {
  const f = fixture();
  expect(await f.check()).toBe(true);
  f.facts.configError = Object.assign(new Error("No explicit setting"), { code: 1 });
  f.facts.refs += `refs/heads/retained\t${head}\n`;
  expect(await f.check()).toBe(true);
  expect(git).toHaveBeenCalledWith("/review", [
    "-c",
    "core.commitGraph=false",
    "rev-list",
    "--count",
    head,
    "--not",
    head,
    "--",
  ]);
});

it.each([
  "invalid-head",
  "identity",
  "missing",
  "attached",
  "moved",
  "locked",
  "prunable",
  "bare",
  "dirty",
  "logging-disabled",
  "config-error",
  "non-object-error",
  "new-commit",
  "malformed-ref",
  "missing-ref-oid",
  "final-identity",
  "final-head",
  "final-attached",
  "final-dirty",
  "unreadable",
])("refuses unavailable or changed review proof: %s", async (mode) => {
  const f = fixture();
  switch (mode) {
    case "invalid-head":
      f.review.head = "-unsafe";
      break;
    case "identity":
      f.source.launchIdentity.mockResolvedValue("replacement");
      break;
    case "missing":
      f.source.listWorktrees.mockResolvedValue([]);
      break;
    case "attached":
      f.source.listWorktrees.mockResolvedValue([{ ...f.tree, branch: "feature" }]);
      break;
    case "moved":
      f.source.listWorktrees.mockResolvedValue([{ ...f.tree, head: other }]);
      break;
    case "locked":
      f.source.listWorktrees.mockResolvedValue([{ ...f.tree, locked: true }]);
      break;
    case "prunable":
      f.source.listWorktrees.mockResolvedValue([{ ...f.tree, prunable: true }]);
      break;
    case "bare":
      f.source.listWorktrees.mockResolvedValue([{ ...f.tree, bare: true }]);
      break;
    case "dirty":
      f.source.cleanupStatus.mockResolvedValue(" M tracked\0");
      break;
    case "logging-disabled":
      f.facts.config = "false";
      break;
    case "config-error":
      f.facts.configError = Object.assign(new Error("Cannot read config"), { code: 128 });
      break;
    case "non-object-error":
      vi.mocked(git).mockRejectedValueOnce(null);
      break;
    case "new-commit":
      f.facts.refs += `refs/custom/work\t${other}\n`;
      f.facts.count = "1";
      break;
    case "malformed-ref":
      f.facts.refs += "refs/custom/work\tnot-an-oid\n";
      break;
    case "missing-ref-oid":
      f.facts.refs += "refs/custom/work\n";
      break;
    case "final-identity":
      f.source.launchIdentity.mockResolvedValueOnce("identity").mockResolvedValue("replacement");
      break;
    case "final-head":
      f.facts.head = other;
      break;
    case "final-attached":
      f.facts.symbolic = "refs/heads/feature";
      break;
    case "final-dirty":
      f.source.cleanupStatus.mockResolvedValueOnce("").mockResolvedValue("?? new\0");
      break;
    case "unreadable":
      f.source.listWorktrees.mockRejectedValue(new Error("Cannot inspect inventory"));
      break;
  }
  expect(await f.check()).toBe(false);
});
