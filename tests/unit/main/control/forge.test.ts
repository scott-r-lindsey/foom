import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FAKE_GH } from "../../../helpers/forge-cli.js";
import {
  forgeBranch,
  forgeProvider,
  githubRepository,
  pullRequest,
  requiredChecks,
  rollupChecks,
} from "../../../../src/main/control/forge";
const pr = { number: 340, headSha: "a".repeat(40), state: "OPEN", requiredChecks: "pending" };
const raw = { number: 340, headRefOid: pr.headSha, headRefName: "child-one", state: "OPEN" };
afterEach(() => vi.unstubAllEnvs());
it("selects GitHub from exact remote hosts and refuses unfamiliar URLs", () => {
  for (const remote of [
    "https://github.com/owner/repo.git",
    "git@github.com:owner/repo.git",
    "ssh://git@github.com/owner/repo",
    "https://github.com/owner/repo/",
  ])
    expect(githubRepository(remote)).toBe("owner/repo");
  for (const remote of [
    "",
    "https://github.com.evil/owner/repo",
    "https://token@github.com/owner/repo",
    "git@gitlab.com:owner/repo",
    "https://github.com/../repo",
    "https://github.com/o/-repo",
    "https://github.com/o/.repo",
    "file:///tmp/repo",
    "https://github.com/o/repo?token=secret",
  ])
    expect(forgeProvider(remote)).toBeUndefined();
});
it("validates branch names and whitelists every PR metadata field", () => {
  expect(forgeBranch("feature/pr-340")).toBe(true);
  for (const value of [
    null,
    5,
    "",
    "a".repeat(201),
    "--help",
    "a b",
    "a..b",
    "a@{b",
    "a.",
    "/a",
    "a//b",
    ".hidden",
    "a.lock",
    "a\x1b",
    "a\u202e",
  ])
    expect(forgeBranch(value)).toBe(false);
  expect(pullRequest({ ...pr, requiredChecks: "unknown" })).toEqual({
    ...pr,
    requiredChecks: "unknown",
  });
  expect(pullRequest({ ...pr, token: "secret", content: "terminal" })).toEqual(pr);
  for (const value of [
    null,
    [],
    { ...pr, number: "340" },
    { ...pr, number: 0 },
    { ...pr, number: 1.5 },
    { ...pr, headSha: "bad" },
    { ...pr, headSha: 10 },
    { ...pr, state: "unknown" },
    { ...pr, requiredChecks: "unrecognized" },
  ])
    expect(pullRequest(value)).toBeUndefined();
});
it("aggregates only required buckets, including cancellation and skipped checks", () => {
  expect(requiredChecks([])).toBe("none");
  expect(requiredChecks([{ bucket: "pass" }, { bucket: "skipping" }])).toBe("success");
  expect(requiredChecks([{ bucket: "pass" }, { bucket: "pending" }])).toBe("pending");
  for (const bucket of ["fail", "cancel"])
    expect(requiredChecks([{ bucket }, { bucket: "pending" }])).toBe("failure");
  for (const value of [
    null,
    {},
    Array.from({ length: 1001 }, () => ({ bucket: "pass" })),
    [null],
    [{ bucket: 10 }],
    [{ bucket: "unknown" }],
  ])
    expect(requiredChecks(value)).toBeUndefined();
});
it("uses fixed read-only argv and verifies the head after required checks", async () => {
  const runner = vi.fn((args: readonly string[]) =>
    Promise.resolve(
      JSON.stringify(
        args[1] === "list" ? [raw] : args[1] === "checks" ? [{ bucket: "pending" }] : raw,
      ),
    ),
  );
  const provider = forgeProvider("git@github.com:o/r.git", runner);
  expect(await provider?.lookup("child-one")).toEqual(pr);
  expect(runner.mock.calls.map(([args]) => args)).toEqual([
    [
      "pr",
      "list",
      "--repo",
      "github.com/o/r",
      "--head",
      "child-one",
      "--state",
      "open",
      "--limit",
      "2",
      "--json",
      "number,headRefOid,headRefName,state",
    ],
    ["pr", "checks", "340", "--repo", "github.com/o/r", "--required", "--json", "bucket"],
    [
      "pr",
      "view",
      "340",
      "--repo",
      "github.com/o/r",
      "--json",
      "number,headRefOid,headRefName,state",
    ],
  ]);
  runner.mockClear();
  expect(await provider?.lookup("child-one", undefined, "all")).toEqual(pr);
  expect(runner.mock.calls[0]?.[0]).toContain("all");
  runner.mockClear();
  expect(await provider?.lookup("child-one", 340)).toEqual(pr);
  expect(runner.mock.calls[0]?.[0]?.[1]).toBe("view");
  for (const number of [0, 1.5, NaN])
    expect(await provider?.lookup("child-one", number)).toBeUndefined();
  expect(await provider?.lookup("--help")).toBeUndefined();
});
it("suppresses absent, ambiguous, malformed and mismatched CLI data", async () => {
  for (const value of [
    [],
    [raw, raw],
    null,
    [{ ...raw, headRefName: "other" }],
    [{ ...raw, headRefOid: "bad" }],
  ]) {
    expect(
      await forgeProvider("https://github.com/o/r", () =>
        Promise.resolve(JSON.stringify(value)),
      )?.lookup("child-one"),
    ).toBeUndefined();
  }
  expect(
    await forgeProvider("https://github.com/o/r", () => Promise.resolve("garbage"))?.lookup(
      "child-one",
    ),
  ).toBeUndefined();
  expect(
    await forgeProvider("https://github.com/o/r", () =>
      Promise.reject(new Error("logged out")),
    )?.lookup("child-one"),
  ).toBeUndefined();
  expect(
    await forgeProvider("https://github.com/o/r", () =>
      Promise.resolve(JSON.stringify({ ...raw, number: 341 })),
    )?.lookup("child-one", 340),
  ).toBeUndefined();
  expect(
    await forgeProvider("https://github.com/o/r", (args) =>
      Promise.resolve(
        JSON.stringify(
          args[1] === "list" ? [raw] : args[1] === "checks" ? [{ bucket: "unknown" }] : raw,
        ),
      ),
    )?.lookup("child-one"),
  ).toEqual({ ...pr, requiredChecks: "unknown" });
  for (const patch of [
    { headRefOid: "b".repeat(40) },
    { headRefName: "other" },
    { number: 341 },
    { state: "MERGED" },
  ])
    expect(
      await forgeProvider("https://github.com/o/r", (args) =>
        Promise.resolve(
          JSON.stringify(
            args[1] === "list" ? [raw] : args[1] === "checks" ? [] : { ...raw, ...patch },
          ),
        ),
      )?.lookup("child-one"),
    ).toBeUndefined();
  expect(
    await forgeProvider("https://github.com/o/r", (args) =>
      Promise.resolve(
        JSON.stringify(args[1] === "list" ? [raw] : args[1] === "checks" ? [] : null),
      ),
    )?.lookup("child-one"),
  ).toBeUndefined();
});
it.skipIf(process.platform === "win32")(
  "runs the user's CLI via execFile, including pending and failure exit codes",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-cli-"));
    try {
      const executable = join(root, "gh");
      const fixture = join(root, "state.json");
      await writeFile(executable, FAKE_GH);
      await chmod(executable, 0o755);
      vi.stubEnv("PATH", `${root}:${process.env["PATH"] ?? ""}`);
      vi.stubEnv("TEST_FORGE_STATE", fixture);
      for (const [bucket, exitCode, conclusion] of [
        ["pass", 0, "success"],
        ["pending", 8, "pending"],
        ["fail", 1, "failure"],
      ]) {
        await writeFile(fixture, JSON.stringify({ checks: [{ bucket }], exitCode }));
        expect(await forgeProvider("https://github.com/o/r")?.lookup("child-one")).toMatchObject({
          requiredChecks: conclusion,
        });
      }
      await writeFile(fixture, JSON.stringify({ error: true }));
      expect(await forgeProvider("https://github.com/o/r")?.lookup("child-one")).toBeUndefined();
      vi.stubEnv("PATH", root + "/missing");
      expect(await forgeProvider("https://github.com/o/r")?.lookup("child-one")).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
// The shared fake is also callable as a Node script on Windows, without a shell shim.
it("can execute the shared fake forge directly without a network", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-script-"));
  try {
    const script = join(root, "fake.cjs");
    const fixture = join(root, "state.json");
    await writeFile(script, FAKE_GH);
    await writeFile(fixture, "{}");
    const runner = async (args: readonly string[]) =>
      (
        await promisify(execFile)(process.execPath, [script, ...args], {
          env: { ...process.env, TEST_FORGE_STATE: fixture },
        })
      ).stdout;
    expect(await forgeProvider("https://github.com/o/r", runner)?.lookup("child-one")).toEqual(pr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("can discover a closed or merged PR after an offline interval while default lookup stays open-only", async () => {
  for (const state of ["CLOSED", "MERGED"]) {
    const closed = { ...raw, state };
    const runner = (args: readonly string[]) =>
      Promise.resolve(
        JSON.stringify(
          args[1] === "checks"
            ? [{ bucket: "pass" }]
            : args[1] === "list"
              ? args.includes("all")
                ? [closed]
                : []
              : closed,
        ),
      );
    const provider = forgeProvider("https://github.com/o/r", runner);
    expect(await provider?.lookup("child-one")).toBeUndefined();
    expect(await provider?.lookup("child-one", undefined, "all")).toEqual({
      ...pr,
      state,
      requiredChecks: "success",
    });
  }
});
it("does not let an old closed PR claim a newly tracked branch, but follows an already-bound PR", async () => {
  for (const state of ["CLOSED", "MERGED"]) {
    const closed = { ...raw, state };
    const provider = forgeProvider("https://github.com/o/r", (args) =>
      Promise.resolve(
        JSON.stringify(
          args[1] === "checks" ? [{ bucket: "pass" }] : args[1] === "list" ? [closed] : closed,
        ),
      ),
    );
    expect(await provider?.lookup("child-one")).toBeUndefined();
    expect(await provider?.lookup("child-one", 340)).toEqual({
      ...pr,
      state,
      requiredChecks: "success",
    });
  }
});

function rollup(nodes: unknown = [], patch: Record<string, unknown> = {}) {
  return {
    data: {
      node: {
        headRefOid: pr.headSha,
        commits: {
          nodes: [
            {
              commit: {
                oid: pr.headSha,
                statusCheckRollup: {
                  contexts: { nodes, pageInfo: { hasNextPage: false }, ...patch },
                },
              },
            },
          ],
        },
      },
    },
  };
}
it("validates complete head-bound rollups and excludes optional checks", () => {
  const check = {
    __typename: "CheckRun",
    isRequired: true,
    status: "COMPLETED",
    conclusion: "SUCCESS",
  };
  const status = { __typename: "StatusContext", isRequired: true, state: "SUCCESS" };
  expect(rollupChecks(rollup(), pr.headSha)).toBe("none");
  expect(rollupChecks(rollup([{ isRequired: false, state: "FAILURE" }]), pr.headSha)).toBe("none");
  for (const conclusion of ["SUCCESS", "NEUTRAL", "SKIPPED"])
    expect(rollupChecks(rollup([{ ...check, conclusion }, status]), pr.headSha)).toBe("success");
  for (const conclusion of [
    "FAILURE",
    "ERROR",
    "TIMED_OUT",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
    "STALE",
    "CANCELLED",
  ])
    expect(rollupChecks(rollup([{ ...check, conclusion }]), pr.headSha)).toBe("failure");
  for (const state of ["FAILURE", "ERROR", "PENDING"])
    expect(rollupChecks(rollup([{ ...status, state }]), pr.headSha)).toBe(
      state === "PENDING" ? "pending" : "failure",
    );
  for (const state of ["IN_PROGRESS", "QUEUED", "PENDING", "WAITING", "REQUESTED"])
    expect(rollupChecks(rollup([{ ...check, status: state, conclusion: null }]), pr.headSha)).toBe(
      "pending",
    );
  for (const value of [
    null,
    {},
    { ...rollup(), errors: [] },
    { data: { node: null } },
    { data: { node: { headRefOid: pr.headSha, commits: { nodes: [] } } } },
    rollup(null),
    rollup(Array.from({ length: 101 }, () => check)),
    rollup([], { pageInfo: { hasNextPage: true } }),
    rollup([], { pageInfo: {} }),
    rollup([null]),
    rollup([{ ...check, isRequired: "true" }]),
    rollup([{ ...check, __typename: "Other" }]),
    rollup([{ ...check, status: "OTHER" }]),
    rollup([{ ...check, conclusion: null }]),
    rollup([{ ...check, conclusion: "OTHER" }]),
  ])
    expect(rollupChecks(value, pr.headSha)).toBe("unknown");
  expect(rollupChecks(rollup([check]), "b".repeat(40))).toBe("unknown");
  const mismatched = rollup();
  const commit = mismatched.data.node.commits.nodes[0]?.commit;
  if (commit) commit.oid = "b".repeat(40);
  expect(rollupChecks(mismatched, pr.headSha)).toBe("unknown");
});
it("falls back with fixed read-only API arguments and keeps unknown PRs head-verified", async () => {
  const runner = vi.fn((args: readonly string[]) => {
    if (args[1] === "checks") return Promise.reject(new Error("unsupported"));
    return Promise.resolve(
      JSON.stringify(
        args[0] === "api"
          ? rollup()
          : args.at(-1) === "id"
            ? { id: "PR_test" }
            : args[1] === "list"
              ? [raw]
              : raw,
      ),
    );
  });
  const provider = forgeProvider("https://github.com/o/r", runner);
  expect(await provider?.lookup("child-one", 340)).toEqual({ ...pr, requiredChecks: "none" });
  expect(runner.mock.calls[2]?.[0]).toEqual([
    "pr",
    "view",
    "340",
    "--repo",
    "github.com/o/r",
    "--json",
    "id",
  ]);
  const api = runner.mock.calls[3]?.[0];
  expect(api?.slice(0, 5)).toEqual(["api", "graphql", "--hostname", "github.com", "-f"]);
  expect(api?.[5]).toMatch(/^query=query\(\$id: ID!\)/u);
  expect(api?.slice(6)).toEqual(["-f", "id=PR_test"]);
  expect(api?.[5]).not.toContain("mutation");
  for (const identity of [null, {}, { id: "--help" }, { id: "a".repeat(201) }, { id: 123 }]) {
    runner.mockImplementation((args) =>
      args[1] === "checks"
        ? Promise.reject(new Error("unsupported"))
        : Promise.resolve(
            JSON.stringify(
              args.at(-1) === "id" ? identity : ["list"].includes(args[1] ?? "") ? [raw] : raw,
            ),
          ),
    );
    expect(await provider?.lookup("child-one")).toEqual({ ...pr, requiredChecks: "unknown" });
  }
  runner.mockImplementation((args) =>
    args[1] === "checks" || args.at(-1) === "id"
      ? Promise.reject(new Error("unavailable"))
      : Promise.resolve(JSON.stringify(args[1] === "list" ? [raw] : raw)),
  );
  expect(await provider?.lookup("child-one")).toEqual({ ...pr, requiredChecks: "unknown" });
  runner.mockImplementation((args) =>
    args[1] === "checks"
      ? Promise.reject(new Error("unsupported"))
      : Promise.resolve(
          JSON.stringify(
            args.at(-1) === "id"
              ? {}
              : args[1] === "list"
                ? [raw]
                : { ...raw, headRefOid: "b".repeat(40) },
          ),
        ),
  );
  expect(await provider?.lookup("child-one")).toBeUndefined();
});
it("supports the shared old-gh mode, API failures and all PR states", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-old-"));
  try {
    const script = join(root, "fake.cjs");
    const fixture = join(root, "state.json");
    await writeFile(script, FAKE_GH);
    const runner = async (args: readonly string[]) =>
      (
        await promisify(execFile)(process.execPath, [script, ...args], {
          env: { ...process.env, TEST_FORGE_STATE: fixture },
          maxBuffer: 256 * 1024,
          timeout: 10000,
        })
      ).stdout;
    for (const state of ["OPEN", "CLOSED", "MERGED"]) {
      for (const [conclusion, expected] of [
        ["SUCCESS", "success"],
        ["FAILURE", "failure"],
        [null, "pending"],
      ]) {
        await writeFile(
          fixture,
          JSON.stringify({
            oldGh: true,
            pr: { state },
            contexts: [
              {
                __typename: "CheckRun",
                isRequired: true,
                status: conclusion === null ? "IN_PROGRESS" : "COMPLETED",
                conclusion,
              },
              { __typename: "StatusContext", isRequired: false, state: "FAILURE" },
            ],
          }),
        );
        expect(
          await forgeProvider("https://github.com/o/r", runner)?.lookup("child-one", 340),
        ).toEqual({ ...pr, state, requiredChecks: expected });
      }
    }
    for (const patch of [{ contexts: [] }, { apiError: true }, { rollup: {} }]) {
      await writeFile(fixture, JSON.stringify({ oldGh: true, ...patch }));
      expect(await forgeProvider("https://github.com/o/r", runner)?.lookup("child-one")).toEqual({
        ...pr,
        requiredChecks: "contexts" in patch ? "none" : "unknown",
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
