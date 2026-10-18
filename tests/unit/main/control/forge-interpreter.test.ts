import { expandForgeArguments, forgeJson } from "../../../../src/main/control/forge-execution";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { forgeProvider, rollupChecks } from "../../../../src/main/control/forge";
import { manifestForgeProvider } from "../../../../src/main/control/forge-interpreter";
import type { ForgeResponse, ForgeTransport } from "../../../../src/main/control/forge.d";
import { githubManifest, bundledForge } from "../../../../src/main/control/forge-manifests";
import github from "../../../../src/shared/bundled-forges/github.json";
import {
  forgeIdentity,
  forgeOwnership,
  forgeRemote,
  forgeValue,
  reduceForgeChecks,
} from "../../../../src/main/control/forge-mapping";
import { parseForgeManifest } from "../../../../src/shared/forge-manifest";
import type { ForgeCheckResult } from "../../../../src/shared/forge-plugin";

const remote = { host: "github.com", project: "cli/cli" };
const row = {
  number: 14700,
  headRefName: "feature",
  headRefOid: "a".repeat(40),
  state: "OPEN",
  headRepositoryOwner: { login: "cli" },
  isCrossRepository: false,
};
const response = (value: unknown, code = 0): ForgeResponse => ({
  code,
  stdout: JSON.stringify(value),
  stderr: "",
});
const reply = (value: unknown, code = 0) => Promise.resolve(response(value, code));
const provider = (run: ForgeTransport, defaultBranch = "main") =>
  manifestForgeProvider(githubManifest, remote, run, defaultBranch);
const checks = githubManifest.checks.primary.result;
const fallback = githubManifest.checks.fallback;
if (!fallback) throw new Error("Missing bundled fallback");
const fallbackResult = fallback.result;
const rawRollup = (nodes: unknown, hasNextPage: unknown = false) => ({
  data: {
    node: {
      headRefOid: row.headRefOid,
      commits: {
        nodes: [
          {
            commit: {
              oid: row.headRefOid,
              statusCheckRollup: { contexts: { nodes, pageInfo: { hasNextPage } } },
            },
          },
        ],
      },
    },
  },
});

it("locks bundled identity/digest and loads through the shared kind dispatcher", () => {
  expect(githubManifest.id).toBe("github");
  expect(githubManifest.minimumIntervalSeconds).toBe(20);
  expect(Object.isFrozen(githubManifest.checks.primary.result.variants)).toBe(true);
  expect(() => bundledForge(github, "github", "bad")).toThrow("integrity");
});

it("runs both paths over recorded public gh captures before removing the old provider", async () => {
  // Recorded public PR is a fork. Integrated lookup must refuse it before any check request.
  const fixture: unknown = JSON.parse(
    await readFile("spikes/forge-manifests/fixtures/gh-list-public.json", "utf8"),
  );
  const branch = "docs/gh-skill-gh-api-field-passing";
  const stdout = forgeValue(fixture, ["stdout"]);
  if (typeof stdout !== "string") throw new Error("Invalid recorded stdout");
  const oldRun = vi.fn<(args: readonly string[]) => Promise<string>>(() => Promise.resolve(stdout));
  const newRun = vi.fn(() => Promise.resolve({ code: 0, stdout, stderr: "" }));
  expect(await forgeProvider("https://github.com/cli/cli", oldRun)?.lookup(branch)).toBeUndefined();
  expect(await provider(newRun).lookup(branch)).toBeUndefined();
  // #579 adds only this optional field to the legacy query; #521 maps it separately.
  expect(newRun.mock.calls).toEqual(
    oldRun.mock.calls.map(([args]) => [args.map((arg) => arg.replace(",mergeCommit", ""))]),
  );
  const capture: unknown = JSON.parse(
    await readFile("spikes/forge-manifests/fixtures/gh-rollup-public.json", "utf8"),
  );
  const capturedStdout = forgeValue(capture, ["stdout"]);
  if (typeof capturedStdout !== "string") throw new Error("Invalid recorded stdout");
  const data: unknown = JSON.parse(capturedStdout);
  const head = forgeValue(data, ["data", "node", "headRefOid"]);
  if (typeof head !== "string") throw new Error("Invalid recorded head");
  expect(reduceForgeChecks(data, fallbackResult, head, 14700)).toBe(rollupChecks(data, head));
  expect(reduceForgeChecks(data, fallbackResult, head, 14700)).toBe("none");
});

it("preserves old/new argv and observations for derived same-repository fixtures, all buckets and fallback", async () => {
  const envelope: unknown = JSON.parse(
    await readFile("spikes/forge-manifests/fixtures/gh-list-public.json", "utf8"),
  );
  const stdout = forgeValue(envelope, ["stdout"]);
  if (typeof stdout !== "string") throw new Error("Missing recorded list");
  const recorded: unknown = JSON.parse(stdout);
  const raw = forgeValue(recorded, [0]);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error("Missing recorded PR");
  // Change only fork ownership to model a same-repository capture; keep recorded identity.
  const derived = { ...raw, headRepositoryOwner: { login: "cli" }, isCrossRepository: false };
  const branch = forgeValue(derived, ["headRefName"]);
  const head = forgeValue(derived, ["headRefOid"]);
  if (typeof branch !== "string" || typeof head !== "string")
    throw new Error("Invalid recorded identity");
  for (const mode of [
    "pass",
    "fail",
    "cancel",
    "pending",
    "skipping",
    "empty",
    "unknown",
    "fallback",
    "failure",
  ]) {
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "api")
        return reply({
          data: {
            node: {
              headRefOid: head,
              commits: { nodes: [{ commit: { oid: head, statusCheckRollup: null } }] },
            },
          },
        });
      if (args.at(-1) === "id") {
        if (mode === "failure") throw new Error("Unavailable");
        return reply({ id: "PR_test" });
      }
      if (args[1] === "checks") {
        if (mode === "fallback" || mode === "failure") throw new Error("Unsupported JSON");
        return reply(mode === "empty" ? [] : [{ bucket: mode }]);
      }
      return reply(args[1] === "list" ? [derived] : derived);
    });
    const oldRun = vi.fn(async (args: readonly string[]) => (await run(args)).stdout);
    const old = await forgeProvider("https://github.com/cli/cli", oldRun)?.lookup(branch);
    const newRun = vi.fn(async (args: readonly string[]) => run(args));
    expect(await provider(newRun).lookup(branch)).toEqual(old);
    // #579 adds only this optional field to the legacy query; #521 maps it separately.
    expect(newRun.mock.calls).toEqual(
      oldRun.mock.calls.map(([args]) => [args.map((arg) => arg.replace(",mergeCommit", ""))]),
    );
  }
});

it("follows bound closed/merged numbers and all-state searches, and resolves incomplete fork evidence", async () => {
  for (const state of ["CLOSED", "MERGED"]) {
    const data = { ...row, state };
    const run = vi.fn(async (args: readonly string[]) =>
      reply(args[1] === "checks" ? [] : args[1] === "list" ? [data] : data),
    );
    expect(await provider(run).lookup("feature", row.number)).toMatchObject({ state });
    expect(await provider(run).lookup("feature", undefined, "all")).toMatchObject({ state });
    expect(await provider(run).lookup("feature")).toBeUndefined();
  }
  expect(await provider(async () => reply(row)).resolve?.(14700)).toEqual({
    branch: "feature",
    state: "OPEN",
    sameRepository: true,
  });
  expect(
    await provider(async () => reply({ ...row, isCrossRepository: true })).resolve?.(14700),
  ).toEqual({ branch: "feature", state: "OPEN", sameRepository: false });
  for (const data of [
    { ...row, number: 4 },
    { ...row, headRefName: "--help" },
    { ...row, state: "BAD" },
    {},
  ])
    expect(await provider(async () => reply(data)).resolve?.(14700)).toBeUndefined();
  expect(
    await provider(() => Promise.reject(new Error("offline"))).resolve?.(14700),
  ).toBeUndefined();
  const run = vi.fn();
  for (const number of [0, -1, 1.5, NaN])
    expect(await provider(run).resolve?.(number)).toBeUndefined();
  expect(run).not.toHaveBeenCalled();
});

it("keeps fork, same-repository and trusted default-branch refusals outside hostile tables", async () => {
  const hostile = parseForgeManifest(
    JSON.stringify({
      ...github,
      id: "hostile",
      mapping: { ...github.mapping, states: { OPEN: "OPEN", CLOSED: "OPEN", MERGED: "OPEN" } },
    }),
  );
  for (const data of [
    { ...row, isCrossRepository: true },
    { ...row, headRepositoryOwner: { login: "attacker" } },
    { ...row, isCrossRepository: "false" },
  ]) {
    const run = vi.fn(async () => reply([data]));
    expect(
      await manifestForgeProvider(hostile, remote, run, "main").lookup("feature"),
    ).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
  }
  const run = vi.fn();
  expect(
    await manifestForgeProvider(hostile, remote, run, "feature").lookup("feature"),
  ).toBeUndefined();
  expect(run).not.toHaveBeenCalled();
});

it("discards ambiguous, invalid and raced candidates; rechecks even unknown results", async () => {
  for (const data of [
    [],
    [row, row],
    [{ ...row, headRefName: "other" }],
    [{ ...row, headRefOid: "bad" }],
    [{ ...row, number: 0 }],
  ])
    expect(await provider(async () => reply(data)).lookup("feature")).toBeUndefined();
  for (const patch of [
    { headRefOid: "b".repeat(40) },
    { state: "CLOSED" },
    { headRefName: "other" },
    { number: 3 },
    { isCrossRepository: true },
    { headRepositoryOwner: { login: "attacker" } },
  ]) {
    const run = vi.fn(async (args: readonly string[]) =>
      reply(
        args[1] === "list"
          ? [row]
          : args[1] === "checks"
            ? [{ bucket: "unknown" }]
            : { ...row, ...patch },
      ),
    );
    expect(await provider(run).lookup("feature")).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(3);
  }
  const run = vi.fn();
  for (const [branch, number] of [
    ["--help", undefined],
    ["feature", 0],
  ] as const)
    expect(await provider(run).lookup(branch, number)).toBeUndefined();
  expect(run).not.toHaveBeenCalled();
  expect(
    await provider(async () => reply({ ...row, number: 5 })).lookup("feature", 14700),
  ).toBeUndefined();
  expect(
    await provider(() => Promise.reject(new Error("offline"))).lookup("feature"),
  ).toBeUndefined();
});

it("falls back only on command/JSON failure and binds only validated node IDs", async () => {
  for (const id of ["PR_test", "@file", "", 1]) {
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[1] === "checks") throw new Error("old gh");
      if (args.at(-1) === "id") return reply({ id });
      if (args[0] === "api") throw new Error("offline");
      return reply(args[1] === "list" ? [row] : row);
    });
    expect(await provider(run).lookup("feature")).toMatchObject({ requiredChecks: "unknown" });
    expect(run.mock.calls.some(([args]) => args[0] === "api")).toBe(id === "PR_test");
  }
  const noFallback = {
    ...githubManifest,
    checks: { ...githubManifest.checks, fallback: undefined },
  };
  const run = vi.fn(async (args: readonly string[]) => {
    if (args[1] === "checks") throw new Error("offline");
    return reply(args[1] === "list" ? [row] : row);
  });
  expect(await manifestForgeProvider(noFallback, remote, run).lookup("feature")).toMatchObject({
    requiredChecks: "unknown",
  });
});

it("bounds stdout/stderr and handles JSON exits and exact empty-check diagnostics", () => {
  const command = githubManifest.checks.primary.commands[0];
  if (!command) throw new Error("Missing checks command");
  for (const code of [0, 1, 8]) expect(forgeJson(response([], code), command)).toEqual([]);
  for (const stderr of [
    "no required checks reported on the 'feature' branch",
    "no checks reported on the 'feature' branch\r\n",
  ])
    expect(forgeJson({ code: 1, stdout: "", stderr }, command)).toEqual([]);
  for (const data of [
    { code: 1, stdout: "{}", stderr: "" },
    { code: 2, stdout: "[]", stderr: "" },
    { code: 0, stdout: "bad", stderr: "" },
    { code: 1, stdout: "", stderr: "no checks reported on the '--help' branch" },
    { code: 1, stdout: "", stderr: "prefix no checks reported on the 'feature' branch" },
    { code: 0, stdout: "x".repeat(256 * 1024 + 1), stderr: "" },
    { code: 0, stdout: "[]", stderr: "x".repeat(256 * 1024 + 1) },
  ])
    expect(() => forgeJson(data, command)).toThrow();
});

it("expands one argument per entry with typed bindings and caps", () => {
  expect(
    expandForgeArguments(
      [
        { parts: ["projects/", { slot: "project", encoding: "percent-component" }] },
        { parts: [{ slot: "branch", encoding: "literal" }] },
        "{branch}",
      ],
      { ...remote, branch: "feature/one" },
    ),
  ).toEqual(["projects/cli%2Fcli", "feature/one", "{branch}"]);
  for (const slot of ["host", "project", "number", "nodeId", "branch", "query"] as const)
    expect(() =>
      expandForgeArguments([{ parts: [{ slot, encoding: "literal" }] }], {
        host: "bad@host",
        project: "../repo",
      }),
    ).toThrow();
  for (const argv of [[""], ["a\n"], ["a".repeat(20481)], Array<string>(4).fill("a".repeat(20000))])
    expect(() => expandForgeArguments(argv, remote)).toThrow();
  expect(() =>
    expandForgeArguments([{ parts: [{ slot: "query", encoding: "literal" }] }], {
      ...remote,
      query: "\u001b",
    }),
  ).toThrow();
});

it("parses exact remote forms without URL normalization or inferred host routing", () => {
  for (const url of [
    "https://GitHub.com/cli/cli.git/",
    "ssh://git@github.com/cli/cli",
    "git@github.com:cli/cli",
  ])
    expect(forgeRemote(url, "pair")).toEqual(remote);
  expect(forgeRemote("https://git.example.org/group/nested/repo.git", "nested")).toEqual({
    host: "git.example.org",
    project: "group/nested/repo",
  });
  for (const url of [
    "",
    "https://github.com/../repo",
    "https://token@github.com/cli/cli",
    "https://github.com:443/cli/cli",
    "https://github.com/cli/cli?x",
    "https://github.com/cli/%2e",
    "file:///cli/cli",
    "ssh://user@github.com/cli/cli",
    "git@github.com/cli/cli",
    "https://127.0.0.1/cli/cli",
    "https://github.com/cli/.repo",
    "https://github.com/cli/-repo",
    "https://github.com/a/b/c",
    "https://github.com/a/" + "b".repeat(256),
    "https://github.com/" + Array<string>(17).fill("a").join("/"),
  ])
    expect(forgeRemote(url, "pair")).toBeUndefined();
  expect(forgeValue(Object.create({ field: 1 }), ["field"])).toBeUndefined();
  expect(forgeValue({ field: 1 }, ["field", "nested"])).toBeUndefined();
  expect(forgeValue({}, ["constructor"])).toBeUndefined();
});

it("compares host-scoped numeric project evidence and exact/ASCII owner evidence", () => {
  const manifest = {
    ...githubManifest,
    mapping: {
      ...githubManifest.mapping,
      projects: {
        mode: "numeric-project-ids" as const,
        source: ["source"],
        target: ["target"],
        context: ["context"],
      },
    },
  };
  expect(forgeOwnership(manifest, { source: 1, target: 1, context: 1 }, remote)).toBe(true);
  expect(forgeOwnership(manifest, { source: 2, target: 1, context: 1 }, remote)).toBe(false);
  expect(forgeOwnership(manifest, { source: 1, target: 1, context: 2 }, remote)).toBe(false);
  for (const data of [
    { source: 0, target: 1, context: 1 },
    { source: 1, target: "1", context: 1 },
    { source: 1, target: 1 },
  ])
    expect(forgeOwnership(manifest, data, remote)).toBeUndefined();
  const owner = { ...row, headRepositoryOwner: { login: "CLI" } };
  expect(forgeOwnership(githubManifest, owner, remote)).toBe(true);
  expect(
    forgeOwnership(
      { ...githubManifest, remote: { ...githubManifest.remote, case: "exact" } },
      owner,
      remote,
    ),
  ).toBe(false);
  expect(forgeIdentity(githubManifest, { ...row, state: "constructor" }, remote)).toBeUndefined();
});

it("reduces complete, matching required contexts and refuses unknown/partial/malformed checks", () => {
  const check = {
    __typename: "CheckRun",
    isRequired: true,
    status: "COMPLETED",
    conclusion: "SUCCESS",
  };
  for (const [nodes, expected] of [
    [[], "none"],
    [[{ ...check, isRequired: false }], "none"],
    [[check], "success"],
    [[{ ...check, status: "QUEUED" }], "pending"],
    [[{ ...check, conclusion: "CANCELLED" }], "failure"],
    [[{ __typename: "StatusContext", isRequired: true, state: "ERROR" }], "failure"],
  ] as const)
    expect(reduceForgeChecks(rawRollup(nodes), fallbackResult, row.headRefOid, 14700)).toBe(
      expected,
    );
  for (const nodes of [
    null,
    [null],
    [[]],
    [{ ...check, isRequired: "true" }],
    [{ ...check, __typename: "Unknown" }],
    [{ ...check, conclusion: "UNKNOWN" }],
    [{ ...check, status: "BAD" }],
    Array<unknown>(101).fill(check),
  ])
    expect(reduceForgeChecks(rawRollup(nodes), fallbackResult, row.headRefOid, 14700)).toBe(
      "unknown",
    );
  for (const value of [
    rawRollup([check], true),
    rawRollup([check], null),
    { errors: [] },
    { data: {} },
    { data: { node: { headRefOid: row.headRefOid, commits: { nodes: [] } } } },
  ])
    expect(reduceForgeChecks(value, fallbackResult, row.headRefOid, 14700)).toBe("unknown");
  const nullRollup = {
    data: {
      node: {
        headRefOid: row.headRefOid,
        commits: { nodes: [{ commit: { oid: row.headRefOid, statusCheckRollup: null } }] },
      },
    },
  };
  expect(reduceForgeChecks(nullRollup, fallbackResult, row.headRefOid, 14700)).toBe("none");
  expect(reduceForgeChecks(nullRollup, fallbackResult, "b".repeat(40), 14700)).toBe("unknown");
  for (const value of [
    null,
    {},
    [null],
    [[]],
    [{ bucket: null }],
    [{ bucket: "constructor" }],
    [{ bucket: "fail" }, { bucket: "unknown" }],
    Array<unknown>(1001).fill({ bucket: "pass" }),
  ])
    expect(reduceForgeChecks(value, checks, row.headRefOid, 14700)).toBe("unknown");
});

it("reduces object pipelines, number guards, ambiguous variants and row guards conservatively", () => {
  const result: ForgeCheckResult = {
    ...checks,
    shape: "object",
    limit: 1,
    rows: ["pipeline"],
    guards: [{ path: ["number"], binding: "number", absent: false, length: undefined }],
    rowGuards: [{ path: ["sha"], binding: "headSha", absent: false, length: undefined }],
    variants: [
      {
        ...checks.variants[0],
        when: undefined,
        status: undefined,
        completed: undefined,
        unfinished: [],
        value: ["bucket"],
        table: { pass: "success", skip: "none", unknown: "unknown" },
      },
    ],
  };
  const data = { number: 14700, pipeline: { sha: row.headRefOid, bucket: "pass" } };
  expect(reduceForgeChecks(data, result, row.headRefOid, 14700)).toBe("success");
  expect(
    reduceForgeChecks(
      { ...data, pipeline: { ...data.pipeline, bucket: "skip" } },
      result,
      row.headRefOid,
      14700,
    ),
  ).toBe("none");
  for (const value of [
    { ...data, number: 3 },
    { ...data, pipeline: [] },
    { ...data, pipeline: null },
    { ...data, pipeline: { sha: "bad" } },
  ])
    expect(reduceForgeChecks(value, result, row.headRefOid, 14700)).toBe("unknown");
  expect(
    reduceForgeChecks(
      data,
      { ...result, variants: [...result.variants, ...result.variants] },
      row.headRefOid,
      14700,
    ),
  ).toBe("unknown");
});
