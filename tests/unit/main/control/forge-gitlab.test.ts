import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FAKE_GLAB } from "../../../helpers/glab-cli.js";
import { ForgeRuntime } from "../../../../src/main/control/forge-runtime";
import { manifestForgeProvider } from "../../../../src/main/control/forge-interpreter";
import { pullRequest } from "../../../../src/main/control/forge";
import { gitlabManifest } from "../../../../src/main/control/forge-manifests";
import {
  forgeMergeCommits,
  forgeRemote,
  forgeValue,
} from "../../../../src/main/control/forge-mapping";
import { parseForgeManifest } from "../../../../src/shared/forge-manifest";
import gitlab from "../../../../src/shared/bundled-forges/gitlab.json";

const roots: string[] = [];
const runtimes: ForgeRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function capture(name: string): Promise<unknown> {
  const envelope: unknown = JSON.parse(
    await readFile(`spikes/forge-manifests/fixtures/glab-${name}-recorded.json`, "utf8"),
  );
  const stdout = forgeValue(envelope, ["stdout"]);
  if (typeof stdout !== "string") throw new Error("Missing recorded stdout");
  const result: unknown = JSON.parse(stdout);
  return result;
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected object");
  return Object.fromEntries(Object.entries(value));
}
const remote = { host: "gitlab.com", project: "scott-test-projects/foom-forge-fixtures" };
const context = () => Promise.resolve({ identity: "fixture", validate: () => Promise.resolve() });
const branch = "evidence-522/success";
async function batchRow(number = 2) {
  const row = object(
    forgeValue(await capture(number === 9 ? "batch-skipped" : "batch"), [
      "data",
      "project",
      `mr${String(number)}`,
    ]),
  );
  if (number !== 9) return row;
  // The skipped GraphQL capture omits project identity. Derive this wrapper from
  // its recorded REST detail; do not claim a complete live GraphQL observation.
  const rest = object(await capture("skipped-pipeline-rest"));
  return {
    ...row,
    sourceProject: { id: `gid://gitlab/Project/${String(rest["source_project_id"])}` },
    targetProject: { id: `gid://gitlab/Project/${String(rest["target_project_id"])}` },
  };
}
function batch(row: unknown, discovered = false, patch: object = {}) {
  return {
    data: {
      project: {
        id: "gid://gitlab/Project/87769054",
        repository: { rootRef: "main" },
        p0: discovered ? { nodes: [row], pageInfo: { hasNextPage: false } } : row,
        ...patch,
      },
    },
  };
}
function provider(value: unknown, manifest = gitlabManifest) {
  const run = vi.fn((_argv: readonly string[]) =>
    Promise.resolve({ code: 0, stdout: JSON.stringify(value), stderr: "" }),
  );
  return { run, forge: manifestForgeProvider(manifest, remote, run, "main") };
}
it("matches nested HTTPS and SSH remotes without granting host authority", () => {
  for (const url of [
    "https://gitlab.com/group/sub/project.git",
    "git@gitlab.com:group/sub/project.git",
    "ssh://git@gitlab.com/group/sub/project.git/",
  ]) {
    expect(forgeRemote(url, gitlabManifest.remote.namespace)).toEqual({
      host: "gitlab.com",
      project: "group/sub/project",
    });
  }
  expect(() => parseForgeManifest(JSON.stringify(gitlab))).toThrow();
});
it("maps recorded batch lifecycle and pipeline states, including manual and genuinely skipped pipelines", async () => {
  for (const [number, state, checks] of [
    [1, "OPEN", "pending"],
    [2, "OPEN", "success"],
    [3, "OPEN", "failure"],
    [4, "OPEN", "pending"],
    [5, "OPEN", "success"],
    [6, "OPEN", "none"],
    [7, "MERGED", "none"],
    [8, "CLOSED", "none"],
    [9, "OPEN", "none"],
  ] as const) {
    const row = await batchRow(number);
    const { forge, run } = provider(batch(row));
    const observations = await forge.batch?.([{ branch: String(row["sourceBranch"]), number }]);
    expect(observations?.get(String(row["sourceBranch"]))).toMatchObject({
      number,
      state,
      requiredChecks: checks,
      requestLabel: "Merge request",
      numberPrefix: "!",
      board: {
        numberPrefix: "!",
        checks: {
          passed: checks === "success" ? 1 : 0,
          failed: checks === "failure" ? 1 : 0,
          pending: checks === "pending" ? 1 : 0,
        },
      },
    });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toContain(`project=${remote.project}`);
    expect(run.mock.calls[0]?.[0].find((arg) => arg.startsWith("query="))).toContain(
      `iid: "${String(number)}"`,
    );
  }
});
it("rejects malformed IDs, fork identities, wrong heads and partial/error responses", async () => {
  const row = await batchRow();
  for (const id of [
    null,
    87769054,
    "gid://gitlab/Project/0",
    "gid://gitlab/Project/01",
    "gid://gitlab/Project/9007199254740992",
    "gid://gitlab/User/87769054",
    "gid://gitlab/Project/2",
  ]) {
    expect(
      (
        await provider(batch({ ...row, sourceProject: { id } })).forge.batch?.([
          { branch, number: 2 },
        ])
      )?.size,
    ).toBe(0);
  }
  for (const iid of [2, "02", "-1", "2.0", "9007199254740992", null]) {
    expect(
      (await provider(batch({ ...row, iid })).forge.batch?.([{ branch, number: 2 }]))?.size ?? 0,
    ).toBe(0);
  }
  for (const headPipeline of [
    { sha: "b".repeat(40), status: "SUCCESS" },
    {},
    { sha: row["diffHeadSha"], status: "NEW" },
  ]) {
    expect(
      (await provider(batch({ ...row, headPipeline })).forge.batch?.([{ branch, number: 2 }]))?.get(
        branch,
      ),
    ).toMatchObject({ requiredChecks: "unknown", board: { checks: null } });
  }
  for (const value of [
    { errors: [] },
    batch(row, false, { repository: { rootRef: null } }),
    batch(row, false, { p0: undefined }),
  ]) {
    expect(await provider(value).forge.batch?.([{ branch, number: 2 }])).toBeUndefined();
  }
  expect(
    (
      await provider(batch(row, false, { id: "gid://gitlab/Project/2" })).forge.batch?.([
        { branch, number: 2 },
      ])
    )?.size,
  ).toBe(0);
});
it("keeps discovery checks unknown until binding and bounds requests with nested config copies", async () => {
  const row = await batchRow();
  const { forge, run } = provider(batch(row, true));
  expect((await forge.batch?.([{ branch }]))?.get(branch)).toMatchObject({
    requiredChecks: "unknown",
    board: { checks: { passed: 1 } },
  });
  expect(run.mock.calls[0]?.[0]).toContain(`b0=${branch}`);
  const selected = Array.from({ length: 1000 }, (_, i) => ({ branch: `feature-${String(i)}` }));
  const count = forge.batchSize?.(selected) ?? 0;
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThan(1000);
  run.mockClear();
  await forge.batch?.(selected.slice(0, count));
  expect(run).toHaveBeenCalledOnce();
  run.mockClear();
  await forge.batch?.(selected.slice(0, count + 1));
  expect(run).not.toHaveBeenCalled();
  for (const p0 of [
    { nodes: [row, row], pageInfo: { hasNextPage: false } },
    { nodes: [row], pageInfo: { hasNextPage: true } },
    { nodes: [row], pageInfo: {} },
  ]) {
    expect((await provider(batch(row, false, { p0 })).forge.batch?.([{ branch }]))?.size ?? 0).toBe(
      0,
    );
  }
  const copy = parseForgeManifest(
    JSON.stringify({
      ...gitlab,
      id: "custom",
      remote: { ...gitlab.remote, hosts: ["git.example.org"] },
    }),
  );
  expect(
    (await provider(batch(row), copy).forge.batch?.([{ branch, number: 2 }]))?.get(branch)?.number,
  ).toBe(2);
});
it("single-MR operations compare numeric project IDs and always recheck head/state", async () => {
  const row = object(await capture("success-rest"));
  const { forge, run } = provider(row);
  expect(await forge.resolve?.(2)).toEqual({ branch, state: "OPEN", sameRepository: true });
  expect(await forge.lookup(branch, 2)).toMatchObject({
    requiredChecks: "success",
    numberPrefix: "!",
  });
  expect(run).toHaveBeenCalledTimes(5);
  for (const patch of [
    { source_project_id: 1 },
    { target_project_id: 1 },
    { project_id: 1 },
    { source_project_id: "87769054" },
  ]) {
    expect(await provider({ ...row, ...patch }).forge.lookup(branch, 2)).toBeUndefined();
  }
  run.mockReset();
  run.mockResolvedValue({ code: 0, stdout: JSON.stringify(row), stderr: "" });
  run.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify(row), stderr: "" });
  run.mockResolvedValueOnce({
    code: 0,
    stdout: JSON.stringify({ ...row, head_pipeline: { sha: "b".repeat(40), status: "success" } }),
    stderr: "",
  });
  expect(await forge.lookup(branch, 2)).toMatchObject({ requiredChecks: "unknown" });
  run.mockReset();
  run.mockResolvedValue({
    code: 0,
    stdout: JSON.stringify({ ...row, sha: "b".repeat(40) }),
    stderr: "",
  });
  run.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify(row), stderr: "" });
  expect(await forge.lookup(branch, 2)).toBeUndefined();
});
it.skipIf(process.platform === "win32")(
  "runs recorded glab fixture on controlled PATH for bundled and assigned self-hosted routing",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "foom-glab-"));
    roots.push(root);
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "glab"),
      FAKE_GLAB.replace("#!/usr/bin/env node", `#!${process.execPath}`),
    );
    await chmod(join(bin, "glab"), 0o700);
    const rest = await capture("success-rest");
    const row = await batchRow();
    const state = join(root, "state.json");
    const log = join(root, "calls.jsonl");
    const write = (patch: object = {}) =>
      writeFile(state, JSON.stringify({ rest: [rest], rows: [row], ...patch }));
    await write();
    let settings = { forges: { gitlab: true }, forgeHosts: { "gitlab.com": "gitlab" } };
    const runtime = new ForgeRuntime(
      () => settings,
      () => Promise.resolve(bin),
      { environment: { TEST_FORGE_STATE: state, TEST_FORGE_LOG: log } },
    );
    runtimes.push(runtime);
    const forge = await runtime.provider(`https://${remote.host}/${remote.project}.git`, context);
    expect(await forge?.lookup(branch, 2)).toMatchObject({ requiredChecks: "success" });
    expect((await forge?.batch?.([{ branch, number: 2 }]))?.get(branch)).toMatchObject({
      requiredChecks: "success",
    });
    await write({ loggedOut: true });
    runtime.invalidate();
    expect(await forge?.lookup(branch, 2)).toBeUndefined();
    // No version gate/probe: 1.124.0 is recorded evidence, not a required minimum.
    expect(await readFile(log, "utf8")).not.toContain("--version");
    settings = { forges: { gitlab: true }, forgeHosts: { "gitlab.com": "gitlab" } };
    await write({ host: "git.example.org" });
    const hosted = new ForgeRuntime(
      () => ({ forges: { gitlab: true }, forgeHosts: { "git.example.org": "gitlab" } }),
      () => Promise.resolve(bin),
      { environment: { TEST_FORGE_STATE: state } },
    );
    runtimes.push(hosted);
    expect(await hosted.hostStatus("git.example.org")).toBe("ready");
    const absent = new ForgeRuntime(
      () => settings,
      () => Promise.resolve(join(root, "absent")),
    );
    runtimes.push(absent);
    expect(await absent.hostStatus("gitlab.com")).toBe("not-installed");
  },
);

it("covers constructed pending/failure statuses and missing pipeline data without guessing", async () => {
  const row = await batchRow();
  for (const [status, expected] of [
    ["CREATED", "pending"],
    ["WAITING_FOR_RESOURCE", "pending"],
    ["PREPARING", "pending"],
    ["PENDING", "pending"],
    ["SCHEDULED", "pending"],
    ["CANCELED", "failure"],
    ["NEW", "unknown"],
  ]) {
    const result = await provider(
      batch({ ...row, headPipeline: { sha: row["diffHeadSha"], status } }),
    ).forge.batch?.([{ branch, number: 2 }]);
    expect(result?.get(branch)?.requiredChecks).toBe(expected);
  }
  expect(
    (
      await provider(batch({ ...row, headPipeline: undefined })).forge.batch?.([
        { branch, number: 2 },
      ])
    )?.get(branch)?.requiredChecks,
  ).toBe("unknown");
});
it("validates new batch mapping and display grammar equally for config copies", () => {
  const valid = { ...gitlab, id: "custom" };
  for (const patch of [
    { requestLabel: "<b>MR</b>" },
    { numberPrefix: "!!" },
    { minimumVersion: "1.124.0" },
    {
      operations: {
        ...gitlab.operations,
        batchStatus: { ...gitlab.operations.batchStatus, numberEncoding: "coerce" },
      },
    },
    {
      operations: {
        ...gitlab.operations,
        batchStatus: { ...gitlab.operations.batchStatus, projectIdEncoding: "url" },
      },
    },
    {
      operations: {
        ...gitlab.operations,
        batchStatus: { ...gitlab.operations.batchStatus, projectContext: ["__proto__"] },
      },
    },
    {
      operations: {
        ...gitlab.operations,
        batchStatus: {
          ...gitlab.operations.batchStatus,
          checks: { ...gitlab.operations.batchStatus.checks, required: ["isRequired"] },
        },
      },
    },
  ]) {
    expect(() => parseForgeManifest(JSON.stringify({ ...valid, ...patch }))).toThrow();
  }
  expect(parseForgeManifest(JSON.stringify(valid)).requestLabel).toBe("Merge request");
});

it("refuses identical source and target identity selectors", () => {
  expect(() =>
    parseForgeManifest(
      JSON.stringify({
        ...gitlab,
        id: "custom",
        mapping: {
          ...gitlab.mapping,
          projects: { ...gitlab.mapping.projects, target: gitlab.mapping.projects.source },
        },
      }),
    ),
  ).toThrow();
});

// #718's reduced recordings omit both integration SHAs. These overrides are synthetic.
it.each([
  ["merge", "a".repeat(40), null],
  ["squash", null, "b".repeat(40)],
  ["both", "a".repeat(40), "b".repeat(40)],
  ["null", null, null],
  ["missing", undefined, undefined],
  ["malformed", "--help", "--help"],
  ["long", "a".repeat(64), "b".repeat(64)],
  ["uppercase", "A".repeat(40), "B".repeat(40)],
])(
  "maps synthetic %s integration evidence from recorded REST and GraphQL rows",
  async (_name, merge, squash) => {
    const rest: Record<string, unknown> = {
      ...object(await capture("merged-rest")),
      merge_commit_sha: merge,
      squash_commit_sha: squash,
    };
    const run = vi.fn((argv: readonly string[]) =>
      Promise.resolve({
        code: 0,
        stdout: JSON.stringify(argv[1]?.endsWith("/merge_requests") ? [rest] : rest),
        stderr: "",
      }),
    );
    const forge = manifestForgeProvider(gitlabManifest, remote, run, "main");
    const result = await forge.lookup(String(rest["source_branch"]), undefined, "all");
    expect(result?.state).toBe("MERGED");
    const valid = (value: unknown) =>
      typeof value === "string" && /^[a-f0-9]{40}$/u.test(value) ? value : undefined;
    expect(result?.mergeCommit).toBe(valid(merge));
    expect(result?.squashCommit).toBe(valid(squash));
    const row: Record<string, unknown> = { ...(await batchRow(7)), mergeCommitSha: merge };
    const { forge: batched, run: batchRun } = provider(batch(row));
    const sample = (
      await batched.batch?.([{ branch: String(row["sourceBranch"]), number: 7 }])
    )?.get(String(row["sourceBranch"]));
    expect(sample?.state).toBe("MERGED");
    expect(sample?.mergeCommit).toBe(valid(merge));
    expect(batchRun.mock.calls[0]?.[0].find((arg) => arg.startsWith("query="))).toContain(
      "mergeCommitSha",
    );
  },
);
it("refuses changed squash evidence during the final REST refresh", async () => {
  const rest = object(await capture("merged-rest"));
  let calls = 0;
  const forge = manifestForgeProvider(gitlabManifest, remote, () =>
    Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ ...rest, squash_commit_sha: (++calls < 3 ? "a" : "b").repeat(40) }),
      stderr: "",
    }),
  );
  expect(await forge.lookup(String(rest["source_branch"]), 7, "all")).toBeUndefined();
});

it("maps non-string merge evidence to absent without trusting nested SHA objects", () => {
  for (const value of [0, [], {}, { oid: "a".repeat(40) }]) {
    expect(
      forgeMergeCommits(gitlabManifest.mapping, {
        merge_commit_sha: value,
        squash_commit_sha: value,
      }),
    ).toEqual({});
  }
  expect(() =>
    parseForgeManifest(
      JSON.stringify({
        ...gitlab,
        id: "custom",
        mapping: { ...gitlab.mapping, squashCommit: ["__proto__"] },
      }),
    ),
  ).toThrow();
});

it("validates squash hints at the main-owned metadata boundary", () => {
  const pr = { number: 7, headSha: "a".repeat(40), state: "MERGED", requiredChecks: "none" };
  expect(pullRequest({ ...pr, squashCommit: "b".repeat(40) })?.squashCommit).toBe("b".repeat(40));
  for (const squashCommit of [null, 1, {}, "--help", "b".repeat(64)]) {
    expect(pullRequest({ ...pr, squashCommit })?.squashCommit).toBeUndefined();
  }
});
