import { expect, it, vi } from "vitest";
import { batchForge, parseBatch } from "../../../helpers/legacy-forge-batch";
import { forgeProvider } from "../../../helpers/legacy-forge";
const sha = "a".repeat(40);
const match = [{ branch: "feature" }];
const bound = [{ branch: "feature", number: 12 }];
function pr(overrides: Record<string, unknown> = {}) {
  return {
    number: 12,
    title: "A <script>plain title</script>",
    headRefName: "feature",
    headRefOid: sha,
    state: "OPEN",
    isCrossRepository: false,
    headRepository: { nameWithOwner: "o/r" },
    commits: commits([
      { __typename: "CheckRun", isRequired: true, status: "IN_PROGRESS", conclusion: null },
    ]),
    ...overrides,
  };
}
function commits(nodes: unknown[], more = false) {
  return {
    nodes: [
      {
        commit: {
          oid: sha,
          statusCheckRollup: { contexts: { pageInfo: { hasNextPage: more }, nodes } },
        },
      },
    ],
  };
}
function response(row: unknown = pr(), discovered = true, defaultBranch: unknown = "main") {
  return {
    data: {
      repository: {
        defaultBranchRef: { name: defaultBranch },
        p0: discovered ? { pageInfo: { hasNextPage: false }, nodes: [row] } : row,
      },
    },
  };
}
it("batches branches and bound required checks into one read-only argv request", async () => {
  const run = vi.fn((_args: readonly string[]) => Promise.resolve(JSON.stringify(response())));
  const provider = forgeProvider("https://github.com/o/r.git", run);
  expect((await provider?.batch?.(match))?.get("feature")).toMatchObject({
    number: 12,
    requiredChecks: "unknown",
    board: { url: "https://github.com/o/r/pull/12", checks: { pending: 1 } },
  });
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]?.[0]?.slice(0, 4)).toEqual([
    "api",
    "graphql",
    "--hostname",
    "github.com",
  ]);
  expect(run.mock.calls[0]?.[0]).toContain("b0=feature");
  run.mockResolvedValue(JSON.stringify(response(pr(), false)));
  expect((await batchForge("o/r", bound, run))?.get("feature")?.requiredChecks).toBe("pending");
  expect(forgeProvider("https://unknown/o/r", run)).toBeUndefined();
});
it("separates optional board failures from required success and validates the head", () => {
  const rows = [
    { __typename: "CheckRun", isRequired: false, status: "COMPLETED", conclusion: "FAILURE" },
    { __typename: "StatusContext", isRequired: true, state: "SUCCESS" },
  ];
  expect(
    parseBatch(response(pr({ commits: commits(rows) }), false), "o/r", bound)?.get("feature"),
  ).toMatchObject({
    requiredChecks: "success",
    board: { checks: { failed: 1, passed: 1, pending: 0 } },
  });
  for (const check of ["CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "ERROR", "FAILURE"]) {
    const node = pr({
      commits: commits([{ __typename: "StatusContext", isRequired: true, state: check }]),
    });
    expect(
      parseBatch(response(node, false), "o/r", bound)?.get("feature")?.board.checks?.failed,
    ).toBe(1);
  }
  for (const value of [
    null,
    {},
    { nodes: [] },
    { nodes: [null] },
    { nodes: [{ commit: { oid: "b".repeat(40) } }] },
    commits([], true),
    commits([{}]),
    commits([null]),
    commits(Array.from({ length: 101 }, () => ({}))),
  ]) {
    expect(
      parseBatch(response(pr({ commits: value }), false), "o/r", bound)?.get("feature"),
    ).toMatchObject({ requiredChecks: "unknown", board: { checks: null } });
  }
  const empty = { nodes: [{ commit: { oid: sha, statusCheckRollup: null } }] };
  expect(
    parseBatch(response(pr({ commits: empty }), false), "o/r", bound)?.get("feature"),
  ).toMatchObject({
    requiredChecks: "none",
    board: { checks: { passed: 0, failed: 0, pending: 0 } },
  });
});
it("refuses forks, ambiguous branches, default branches and mismatched bound identities", () => {
  for (const row of [
    null,
    pr({ isCrossRepository: true }),
    pr({ headRepository: null }),
    pr({ headRepository: { nameWithOwner: "o/fork" } }),
    pr({ headRefName: "other" }),
  ])
    expect(parseBatch(response(row), "o/r", match)?.size).toBe(0);
  expect(parseBatch(response(pr(), true, "feature"), "o/r", match)?.size).toBe(0);
  expect(parseBatch(response(null, false), "o/r", bound)?.size).toBe(0);
  expect(parseBatch(response(pr({ number: 13 }), false), "o/r", bound)?.size).toBe(0);
  for (const nodes of [[], [pr(), pr()]])
    expect(
      parseBatch(
        {
          data: {
            repository: {
              defaultBranchRef: { name: "main" },
              p0: { pageInfo: { hasNextPage: false }, nodes },
            },
          },
        },
        "o/r",
        match,
      )?.size,
    ).toBe(0);
  expect(
    parseBatch(response(pr({ state: "MERGED" }), false), "o/r", bound)?.get("feature")?.state,
  ).toBe("MERGED");
  expect(
    parseBatch(response(pr({ headRepository: { nameWithOwner: "O/R" } })), "o/r", match)?.size,
  ).toBe(1);
});
it("fails closed for malformed, incomplete, oversized or unavailable query output", async () => {
  for (const value of [
    null,
    [],
    {},
    { errors: [] },
    response(pr(), true, null),
    { data: { repository: { defaultBranchRef: { name: "main" }, p0: {} } } },
    response(pr({ title: "\u0000" })),
    response(pr({ title: "x".repeat(1025) })),
    response(pr({ number: -1 })),
    response(pr({ state: "CLOSED" })),
  ])
    expect(parseBatch(value, "o/r", match)).toBeUndefined();
  for (const value of ["{", " ".repeat(256 * 1024 + 1)])
    expect(await batchForge("o/r", match, () => Promise.resolve(value))).toBeUndefined();
  expect(
    await batchForge("o/r", match, () => Promise.reject(new Error("offline"))),
  ).toBeUndefined();
  const run = vi.fn(() => Promise.resolve("{}"));
  for (const invalid of [
    [],
    [{ branch: "--help" }],
    [{ branch: "feature", number: -1 }],
    Array.from({ length: 1001 }, () => ({ branch: "feature" })),
  ])
    expect(await batchForge("o/r", invalid, run)).toBeUndefined();
  expect(run).not.toHaveBeenCalled();
});
