import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { parse, print } from "graphql/language";
import { batchForge } from "../../../../src/main/control/forge-batch";
import { manifestForgeProvider } from "../../../../src/main/control/forge-interpreter";
import { githubManifest } from "../../../../src/main/control/forge-manifests";
import { forgeValue } from "../../../../src/main/control/forge-mapping";
import { parseForgeManifest } from "../../../../src/shared/forge-manifest";
import type { ForgeMatch } from "../../../../src/main/control/forge.d";
import github from "../../../../src/shared/bundled-forges/github.json";

const remote = { host: "github.com", project: "o/r" };
const sha = "a".repeat(40);
const matches = [{ branch: "feature", number: 12 }];
const context = { __typename: "StatusContext", isRequired: true, state: "SUCCESS" };
const commits = (nodes: unknown = [context], more: unknown = false, oid = sha) => ({
  nodes: [
    {
      commit: { oid, statusCheckRollup: { contexts: { nodes, pageInfo: { hasNextPage: more } } } },
    },
  ],
});
const row = (patch: object = {}) => ({
  number: 12,
  title: "A <plain> title",
  headRefName: "feature",
  headRefOid: sha,
  state: "OPEN",
  isCrossRepository: false,
  headRepository: { nameWithOwner: "o/r" },
  commits: commits(),
  ...patch,
});
const response = (pr: unknown = row(), bound = true, defaultBranch: unknown = "main") => ({
  data: {
    repository: {
      defaultBranchRef: { name: defaultBranch },
      p0: bound ? pr : { pageInfo: { hasNextPage: false }, nodes: [pr] },
    },
  },
});
function provider(value: unknown, manifest = githubManifest, selectedRemote = remote) {
  const run = vi.fn((_argv: readonly string[]) =>
    Promise.resolve({
      code: 0,
      stdout: JSON.stringify(value),
      stderr: "",
    }),
  );
  const forge = manifestForgeProvider(manifest, selectedRemote, run, "main");
  return { run, forge };
}
async function parity(value: unknown, selected: readonly ForgeMatch[] = matches) {
  const { forge } = provider(value);
  const old = await batchForge("o/r", selected, () => Promise.resolve(JSON.stringify(value)));
  const actual = await forge.batch?.(selected);
  expect(actual).toEqual(old);
  return actual;
}

it("composes the same dynamic query/argv for mixed discovery and bound PRs", async () => {
  const selected = [{ branch: "feature" }, { branch: "other", number: 99 }];
  const value = {
    data: {
      repository: {
        defaultBranchRef: { name: "main" },
        p0: { pageInfo: { hasNextPage: false }, nodes: [row()] },
        p1: row({ number: 99, headRefName: "other" }),
      },
    },
  };
  const { forge, run } = provider(value);
  const old = vi.fn((_argv: readonly string[]) => Promise.resolve(JSON.stringify(value)));
  expect(await forge.batch?.(selected)).toEqual(await batchForge("o/r", selected, old));
  // The lifecycle stage adds mergeCommit; the legacy batch has no merge field.
  const canonical = (argv: readonly string[]) =>
    argv.map((arg) =>
      arg.startsWith("query=")
        ? `query=${print(parse(arg.slice(6).replace(/mergeCommit\s*\{\s*oid\s*\}/gu, "")))}`
        : arg,
    );
  expect(canonical(run.mock.calls[0]?.[0] ?? [])).toEqual(canonical(old.mock.calls[0]?.[0] ?? []));
  expect(run).toHaveBeenCalledTimes(1);
  expect((await forge.batch?.(selected))?.get("feature")?.requiredChecks).toBe("unknown");
  expect((await forge.batch?.(selected))?.get("other")?.requiredChecks).toBe("success");
});

it("preserves board counts, required-only reduction and all legacy malformed-check cases", async () => {
  for (const nodes of [
    [],
    [context],
    [{ ...context, isRequired: false, state: "FAILURE" }],
    [{ ...context, isRequired: false, state: "FAILURE" }, context],
    [null],
    [{}],
    [{ ...context, state: "NEW" }],
    [{ ...context, isRequired: "true" }],
    Array.from({ length: 101 }, () => context),
    ...[
      "FAILURE",
      "ERROR",
      "TIMED_OUT",
      "ACTION_REQUIRED",
      "CANCELLED",
      "PENDING",
      "NEUTRAL",
      "SKIPPED",
    ].map((state) => [{ ...context, state }]),
    ...["IN_PROGRESS", "QUEUED", "PENDING", "WAITING", "REQUESTED", "COMPLETED", "OTHER"].map(
      (status) => [{ __typename: "CheckRun", isRequired: true, status, conclusion: "SUCCESS" }],
    ),
  ])
    await parity(response(row({ commits: commits(nodes) })));
  for (const value of [
    null,
    {},
    { nodes: [] },
    { nodes: [null] },
    commits([], true),
    commits([], false, "b".repeat(40)),
    { nodes: [{ commit: { oid: sha, statusCheckRollup: null } }] },
    commits([context], undefined),
  ]) {
    await parity(response(row({ commits: value })));
  }
  expect(
    (
      await parity(
        response(
          row({ commits: commits([{ ...context, isRequired: false, state: "FAILURE" }, context]) }),
        ),
      )
    )?.get("feature"),
  ).toMatchObject({
    requiredChecks: "success",
    board: { checks: { passed: 1, failed: 1, pending: 0 } },
  });
});

it("keeps fork, repository, branch, number and default-branch refusals in Foom code", async () => {
  for (const patch of [
    { isCrossRepository: true },
    { headRepository: null },
    { headRepository: { nameWithOwner: "o/fork" } },
    { headRefName: "other" },
    { number: 13 },
    { headRepository: { nameWithOwner: "O/R" } },
    { state: "CLOSED" },
    { state: "MERGED" },
  ])
    await parity(response(row(patch)));
  await parity(response(null));
  await parity(response(row(), true, "feature"));
  for (const pr of [
    null,
    row({ state: "CLOSED" }),
    row({ number: -1 }),
    row({ title: "\u0000" }),
    row({ title: "x".repeat(1025) }),
  ])
    await parity(response(pr, false), [{ branch: "feature" }]);
  for (const nodes of [[], [row(), row()], [row(), row(), row()]])
    await parity(
      {
        data: {
          repository: {
            defaultBranchRef: { name: "main" },
            p0: { nodes, pageInfo: { hasNextPage: false } },
          },
        },
      },
      [{ branch: "feature" }],
    );
  const hostile = parseForgeManifest(
    JSON.stringify({
      ...github,
      id: "hostile",
      mapping: { ...github.mapping, states: { OPEN: "OPEN", CLOSED: "OPEN" } },
    }),
  );
  for (const pr of [
    row({ isCrossRepository: true }),
    row({ headRepository: { nameWithOwner: "other/repo" } }),
  ])
    expect((await provider(response(pr), hostile).forge.batch?.(matches))?.size).toBe(0);
  expect(
    (
      await provider(response(row({ headRefName: "main" })), hostile).forge.batch?.([
        { branch: "main", number: 12 },
      ])
    )?.size,
  ).toBe(0);
});

it("replays recorded gh identity and rollup fields in an explicitly derived batch envelope", async () => {
  const capture: unknown = JSON.parse(
    await readFile("spikes/forge-manifests/fixtures/gh-rollup-public.json", "utf8"),
  );
  const stdout = forgeValue(capture, ["stdout"]);
  if (typeof stdout !== "string") throw new Error("Missing recorded stdout");
  const recorded: unknown = JSON.parse(stdout);
  const node = forgeValue(recorded, ["data", "node"]);
  const recordedHead = forgeValue(node, ["headRefOid"]);
  const recordedCommits = forgeValue(node, ["commits"]);
  await parity(response(row({ headRefOid: recordedHead, commits: recordedCommits })));
  const view: unknown = JSON.parse(
    await readFile("spikes/forge-manifests/fixtures/gh-view-public.json", "utf8"),
  );
  const viewStdout = forgeValue(view, ["stdout"]);
  if (typeof viewStdout !== "string") throw new Error("Missing recorded PR stdout");
  const pr: unknown = JSON.parse(viewStdout);
  // The public capture is a fork: retain its ownership fact; no live batch capture is claimed.
  await parity(response(row({ isCrossRepository: forgeValue(pr, ["isCrossRepository"]) })));
});

it("runs renamed config copies through the same engine and supports absent batch plans", async () => {
  const copy = parseForgeManifest(
    JSON.stringify({
      ...github,
      id: "copy",
      remote: { ...github.remote, hosts: ["git.example.org"] },
    }),
  );
  const { forge, run } = provider(response(), copy, { ...remote, host: "git.example.org" });
  expect((await forge.batch?.(matches))?.get("feature")?.board.url).toBe(
    "https://git.example.org/o/r/pull/12",
  );
  expect(run.mock.calls[0]?.[0]).toContain("git.example.org");
  const absent = parseForgeManifest(
    JSON.stringify({
      ...github,
      id: "no-batch",
      operations: { ...github.operations, batchStatus: undefined },
    }),
  );
  expect(Object.hasOwn(provider(response(), absent).forge, "batch")).toBe(false);
});

it("fails closed on missing rows, partial GraphQL data and invalid or oversized requests/results", async () => {
  for (const value of [
    null,
    [],
    {},
    { errors: [] },
    response(row(), true, null),
    response(row({ title: null })),
    response(row({ title: "\u0000" })),
    response(row({ state: "UNKNOWN" })),
    { data: { repository: { defaultBranchRef: { name: "main" }, p0: {} } } },
  ])
    await parity(value);
  const { forge, run } = provider(response());
  for (const selected of [
    [],
    [{ branch: "--help" }],
    [{ branch: "feature", number: -1 }],
    [{ branch: "feature", number: NaN }],
    [{ branch: "same" }, { branch: "same" }],
    Array.from({ length: 1001 }, (_, i) => ({ branch: `b${String(i)}` })),
    Array.from({ length: 100 }, (_, i) => ({ branch: `b${String(i)}` })),
  ] satisfies ForgeMatch[][])
    expect(await forge.batch?.(selected)).toBeUndefined();
  expect(run).not.toHaveBeenCalled();
  for (const stdout of ["{", " ".repeat(256 * 1024 + 1)]) {
    run.mockResolvedValue({ code: 0, stdout, stderr: "" });
    expect(await forge.batch?.(matches)).toBeUndefined();
  }
  run.mockRejectedValue(new Error("offline"));
  expect(await forge.batch?.(matches)).toBeUndefined();
  expect(
    await provider(response(), githubManifest, {
      host: "github.com",
      project: "invalid",
    }).forge.batch?.(matches),
  ).toBeUndefined();
});

it("rejects unsafe display URLs and preserves unknown counts for unmappable check rows", async () => {
  for (const webUrl of [
    "https://github.com:443/o/r/pull/12",
    "https://other.example/o/r",
    "http://github.com/o/r",
    "https://u@github.com/o/r",
    { parts: ["https://github.com/", "x".repeat(4096)] },
  ]) {
    const manifest = parseForgeManifest(
      JSON.stringify({
        ...github,
        id: "url-test",
        operations: {
          ...github.operations,
          batchStatus: { ...github.operations.batchStatus, webUrl },
        },
      }),
    );
    expect(await provider(response(), manifest).forge.batch?.(matches)).toBeUndefined();
  }
  const noTitle = parseForgeManifest(
    JSON.stringify({ ...github, id: "no-title", mapping: { ...github.mapping, title: undefined } }),
  );
  expect(await provider(response(), noTitle).forge.batch?.(matches)).toBeUndefined();
  const result = github.operations.batchStatus.checks;
  const none = parseForgeManifest(
    JSON.stringify({
      ...github,
      id: "none-context",
      operations: {
        ...github.operations,
        batchStatus: {
          ...github.operations.batchStatus,
          checks: { ...result, variants: [{ value: ["state"], table: { SUCCESS: "none" } }] },
        },
      },
    }),
  );
  expect((await provider(response(), none).forge.batch?.(matches))?.get("feature")).toMatchObject({
    requiredChecks: "none",
    board: { checks: null },
  });
});

it("keeps branch punctuation as a raw variable value instead of GraphQL syntax", async () => {
  const branch = 'x"){delete}';
  const { forge, run } = provider(response(row({ headRefName: branch }), false));
  expect((await forge.batch?.([{ branch }]))?.get(branch)?.number).toBe(12);
  const argv = run.mock.calls[0]?.[0] ?? [];
  expect(argv).toContain(`b0=${branch}`);
  const query = argv.find((arg) => arg.startsWith("query="))?.slice(6) ?? "";
  expect(query).not.toContain(branch);
  expect(() => parse(query)).not.toThrow();
});

it("maps only hex merge commits from the declared batch output path", async () => {
  for (const oid of ["b".repeat(40), "c".repeat(64), "invalid", null]) {
    const { forge } = provider(response(row({ state: "MERGED", mergeCommit: { oid } })));
    const pr = (await forge.batch?.(matches))?.get("feature");
    expect(pr).toBeDefined();
    expect(pr?.mergeCommit).toBe(
      typeof oid === "string" && /^[a-f0-9]{40,64}$/u.test(oid) ? oid : undefined,
    );
  }
});
