import { expect, test } from "vitest";
import {
  originSshArgs,
  hostAlias,
  codeFolder,
  registeredHosts,
  gitOrigin,
  hostManagement,
  hostResult,
  hostsAction,
} from "../../../src/shared/registered-hosts";
import { remoteRequest, remoteResponse } from "../../../src/shared/remote-host-protocol";
export const facts = {
  codeFolder: "/home/fixture/foom",
  version: "0.1.0",
  sessions: 2,
  cores: 4,
  load: [0.1, 0.2, 0.3],
  memoryTotal: 8000000,
  memoryAvailable: 4000000,
  agents: [{ id: "claude", state: "ready" as const }],
};
test("host settings reject options, shell syntax, path traversal and duplicate authorizations", () => {
  for (const host of ["worker", "me@worker.test", "127.0.0.1"]) expect(hostAlias(host)).toBe(true);
  for (const host of [
    null,
    "-oProxyCommand=x",
    "a;b",
    "a b",
    "ssh://host",
    "user@-host",
    "x".repeat(254),
  ])
    expect(hostAlias(host)).toBe(false);
  for (const path of ["~/foom", "/home/me/code"]) expect(codeFolder(path)).toBe(true);
  for (const path of [
    null,
    "relative",
    "~",
    "/",
    "/a/../b",
    "/a/./b",
    "/a\n",
    "/a//b",
    "/a/",
    "/a\u202eb",
    "/" + "a".repeat(4096),
  ])
    expect(codeFolder(path)).toBe(false);
  const host = { host: "worker", codeFolder: "/home/me/foom" };
  expect(registeredHosts([host])).toBe(true);
  for (const input of [
    null,
    {},
    [null],
    [{ ...host, option: true }],
    [{ ...host, host: "-x" }],
    [{ ...host, codeFolder: ".." }],
    [host, host],
    Array.from({ length: 33 }, (_, n) => ({ ...host, host: `worker${String(n)}` })),
  ])
    expect(registeredHosts(input)).toBe(false);
});
test("origin and management boundaries accept only closed operations and credential-free Git origins", () => {
  for (const origin of [
    "https://github.com/me/repo.git",
    "git@github.com:me/repo.git",
    "ssh://git@github.com:22/me/repo.git",
    "worker:me/repo",
  ])
    expect(gitOrigin(origin)).toBe(true);
  for (const origin of [
    null,
    "/local/repo",
    "file:///repo",
    "https://user:password@host/repo",
    "ext::sh x",
    "-option",
    "git@host:a;rm",
    "https://host/repo\n",
  ])
    expect(gitOrigin(origin)).toBe(false);
  const inspect = { type: "manage", operation: "inspect", codeFolder: "~/foom" };
  const repo = {
    ...inspect,
    operation: "clone",
    directory: "repo-123",
    origin: "git@host:me/repo.git",
  };
  for (const request of [
    inspect,
    repo,
    { ...repo, operation: "repository" },
    { ...inspect, agents: [{ id: "custom", executables: ["custom-cli"] }] },
  ]) {
    expect(hostManagement(request)).toBe(true);
    expect(remoteRequest(request)).toBe(true);
  }
  for (const value of [
    null,
    { ...inspect, type: "run" },
    { ...inspect, codeFolder: "../" },
    { ...inspect, extra: true },
    { ...repo, operation: "exec" },
    { ...repo, directory: "../repo" },
    { ...repo, origin: "/local" },
    { ...repo, shell: true },
    ...[
      null,
      {},
      Array(101).fill({}),
      [null],
      [{ id: "bad id", executables: ["cli"] }],
      [{ id: "custom", executables: [] }],
      [{ id: "custom", executables: Array(9).fill("cli") }],
      [{ id: "custom", executables: ["../cli"] }],
      [{ id: "custom", executables: ["cli\n"] }],
      [{ id: "custom\n", executables: ["cli"] }],
      [{ id: "custom", executables: [null] }],
      [{ id: "custom", executables: ["cli"], args: ["bad"] }],
    ].map((agents) => ({ ...inspect, agents })),
  ])
    expect(hostManagement(value)).toBe(false);
});
test("typed results expose bounded facts and fixed states only", () => {
  const valid = { ok: true, facts };
  expect(hostResult(valid)).toBe(true);
  expect(
    hostResult({ ...valid, facts: { ...facts, agents: [{ id: "claude\n", state: "ready" }] } }),
  ).toBe(false);
  expect(hostResult({ ok: false, reason: ["unreachable"] })).toBe(false);
  expect(
    hostResult({ ...valid, facts: { ...facts, agents: [{ id: "claude", state: ["ready"] }] } }),
  ).toBe(false);
  expect(hostResult({ ...valid, checkout: { path: "/repo", state: ["clean"] } })).toBe(false);
  expect(
    hostResult({ ...valid, facts: { ...facts, memoryTotal: Number.MAX_SAFE_INTEGER + 1 } }),
  ).toBe(false);
  expect(hostResult({ ...valid, facts: { ...facts, memoryAvailable: 0.5 } })).toBe(false);
  expect(
    hostResult({ ...valid, facts: { ...facts, version: "0.1.0-nightly.20261028+abcdef0" } }),
  ).toBe(true);
  expect(remoteResponse({ type: "managed", result: valid })).toBe(true);
  expect(hostResult({ ...valid, facts: { ...facts, codeFolder: "/home/fixture/foom/" } })).toBe(
    false,
  );
  for (const state of ["absent", "clean", "changed"])
    expect(hostResult({ ...valid, checkout: { path: "/home/fixture/foom/repo", state } })).toBe(
      true,
    );
  for (const reason of [
    "unreachable",
    "unsupported",
    "artifact-unavailable",
    "folder-refused",
    "unsafe-folder",
    "origin-unavailable",
    "origin-auth",
    "origin-host-key",
    "origin-unreachable",
    "timed-out",
    "checkout-invalid",
    "clone-failed",
    "checkout-refused",
  ])
    expect(hostResult({ ok: false, reason })).toBe(true);
  for (const value of [
    null,
    {},
    { ok: false, reason: "raw host output" },
    { ok: false, reason: "unreachable", stderr: "secret" },
    { ...valid, extra: true },
    { ...valid, facts: null },
    ...Object.entries({
      codeFolder: "relative",
      version: "raw output",
      sessions: -1,
      cores: 1.5,
      load: [1, 2],
      memoryTotal: NaN,
      memoryAvailable: Infinity,
      agents: [{ id: "x", state: "signed-in" }],
    }).map(([key, entry]) => ({ ...valid, facts: { ...facts, [key]: entry } })),
    { ...valid, facts: { ...facts, memoryAvailable: facts.memoryTotal + 1 } },
    { ...valid, facts: { ...facts, load: [1, -1, 3] } },
    { ...valid, facts: { ...facts, agents: [null] } },
    { ...valid, facts: { ...facts, agents: [{ id: "bad id", state: "ready" }] } },
    { ...valid, checkout: { path: "../", state: "clean" } },
    { ...valid, checkout: { path: "/repo", state: "raw" } },
  ])
    expect(hostResult(value)).toBe(false);
});
test("renderer actions contain only registered selectors, never remote commands or Git origins", () => {
  for (const action of [
    { action: "list" },
    { action: "locations" },
    { action: "add", host: "worker", codeFolder: "~/foom" },
    { action: "test", host: "worker", codeFolder: "~/foom" },
    { action: "refresh", host: "worker" },
    { action: "remove", host: "worker" },
    { action: "clone", host: "worker", repository: "/repo" },
  ])
    expect(hostsAction(action)).toBe(true);
  for (const action of [
    null,
    {},
    { action: "list", x: true },
    { action: "refresh", host: "-x" },
    { action: "remove", host: "worker", kill: true },
    { action: "add", host: "worker", codeFolder: "../" },
    { action: "clone", host: "worker", repository: 2 },
    { action: "exec", host: "worker" },
    { action: "clone", host: "worker", repository: "/repo", origin: "arbitrary" },
  ])
    expect(hostsAction(action)).toBe(false);
});

test("worktree management is closed, bounded and cannot select arbitrary commands or paths", () => {
  const request = {
    type: "manage",
    operation: "create-worktree",
    profile: "a".repeat(32),
    codeFolder: "/code",
    directory: "repo",
    origin: "git@fixture.test:team/repo.git",
    branch: "feature",
  };
  expect(hostManagement(request)).toBe(true);
  expect(remoteRequest(request)).toBe(true);
  for (const patch of [
    { branch: "-evil" },
    { branch: "@{-1}" },
    { branch: "a b" },
    { branch: "a\n" },
    { branch: "a\u202e" },
    { branch: "" },
    { branch: "a".repeat(201) },
    { directory: "../outside" },
    { command: "evil" },
  ])
    expect(hostManagement({ ...request, ...patch })).toBe(false);
  const common = {
    type: request.type,
    operation: request.operation,
    codeFolder: request.codeFolder,
    directory: request.directory,
    origin: request.origin,
  };
  const removal = {
    ...common,
    operation: "remove-worktree",
    profile: "a".repeat(32),
    path: "/code/.foom-worktree-fixture",
    identity: "a".repeat(64),
    changes: "?? file\n",
  };
  expect(hostManagement(removal)).toBe(true);
  for (const patch of [
    { path: "../outside" },
    { identity: "invalid" },
    { changes: "x".repeat(65537) },
    { force: true },
  ])
    expect(hostManagement({ ...removal, ...patch })).toBe(false);
  const worktree = {
    path: removal.path,
    branch: "feature",
    identity: removal.identity,
    changes: "",
  };
  expect(hostResult({ ok: true, facts, worktree })).toBe(true);
  const evidence = { ...worktree, head: "b".repeat(40), origin: "https://github.com/o/r" };
  expect(hostResult({ ok: true, facts, worktree: evidence })).toBe(true);
  for (const patch of [
    { head: 1 },
    { head: "bad" },
    { origin: "https://user:secret@host/repo" },
    { origin: 1 },
  ])
    expect(hostResult({ ok: true, facts, worktree: { ...evidence, ...patch } })).toBe(false);

  for (const patch of [{ branch: "" }, { identity: "x" }, { changes: 1 }, { extra: true }])
    expect(hostResult({ ok: true, facts, worktree: { ...worktree, ...patch } })).toBe(false);
});

test("snapshot management has no process authority and accepts only bounded evidence", () => {
  const request = {
    type: "manage",
    operation: "snapshot-worktree",
    profile: "a".repeat(32),
    codeFolder: "/code",
    directory: "repository-fixture",
    origin: "https://forge.test/o/r",
    path: "/code/.foom-worktree-fixture",
    identity: "a".repeat(64),
  };
  expect(hostManagement(request)).toBe(true);
  for (const extra of [
    { terminalId: "hub" },
    { snapshot: {} },
    { command: "git" },
    { profile: undefined },
    { profile: "bad" },
  ])
    expect(hostManagement({ ...request, ...extra })).toBe(false);
  const worktree = {
    path: request.path,
    branch: "feature",
    identity: request.identity,
    changes: "",
    snapshot: { head: "b".repeat(40), digest: "c".repeat(64) },
  };
  expect(hostResult({ ok: true, facts, worktree })).toBe(true);
  expect(
    hostResult({
      ok: true,
      facts,
      worktree: { ...worktree, snapshot: { ...worktree.snapshot, contents: "file" } },
    }),
  ).toBe(false);
});

test("worktree inventory is bounded and validates private profile metadata and every returned locator", () => {
  const request = {
    type: "manage",
    operation: "list-worktrees",
    codeFolder: "/code",
    profile: "a".repeat(32),
  };
  expect(hostManagement(request)).toBe(true);
  for (const patch of [
    { profile: undefined },
    { profile: "bad" },
    { terminalId: "foreign" },
    { directory: "repo" },
    { origin: "git@fixture.test:x/y" },
  ])
    expect(hostManagement({ ...request, ...patch })).toBe(false);
  const tree = {
    repository: "/code/repository-fixture",
    path: "/code/.foom-worktree-fixture",
    branch: "main",
    identity: "a".repeat(64),
    origin: "git@fixture.test:team/repo.git",
  };
  const result = { ok: true, facts, inventory: { own: [tree], other: 3 } };
  expect(hostResult(result)).toBe(true);
  for (const inventory of [
    null,
    { own: [], other: -1 },
    { own: [], other: 0.5 },
    { own: [], other: "3" },
    { own: Array.from({ length: 129 }, () => tree), other: 0 },
    { own: [null], other: 0 },
    { own: [{ ...tree, identity: "bad" }], other: 0 },
    { own: [{ ...tree, origin: "file:///secret" }], other: 0 },
    { own: [{ ...tree, repository: "relative" }], other: 0 },
    { own: [{ ...tree, path: "/../secret" }], other: 0 },
    { own: [{ ...tree, branch: "-bad" }], other: 0 },
    { own: [{ ...tree, extra: "raw" }], other: 0 },
    { own: [], other: 0, extra: true },
  ])
    expect(hostResult({ ...result, inventory })).toBe(false);
});

test("partial preflight requests, observations and explicit folder actions have closed payloads", () => {
  const request = {
    type: "manage",
    operation: "inspect",
    codeFolder: "~/code",
    readOnly: true,
    partial: true,
  };
  expect(hostManagement(request)).toBe(true);
  expect(hostManagement({ ...request, readOnly: undefined })).toBe(false);
  expect(hostManagement({ ...request, partial: "yes" })).toBe(false);
  expect(hostManagement({ type: "manage", operation: "create-folder", codeFolder: "~/code" })).toBe(
    true,
  );
  expect(
    hostManagement({
      type: "manage",
      operation: "origin",
      codeFolder: "~/code",
      directory: "repo",
      origin: "git@fixture.test:team/repo.git",
    }),
  ).toBe(true);
  for (const action of ["preflight", "change-folder"])
    expect(hostsAction({ action, host: "worker", codeFolder: "~/code" })).toBe(true);
  expect(hostsAction({ action: "create-folder", host: "worker" })).toBe(true);
  expect(
    hostsAction({ action: "create-folder", host: "worker", codeFolder: "/unregistered" }),
  ).toBe(false);
  expect(registeredHosts([{ host: "worker", codeFolder: "~/code" }])).toBe(true);
  for (const folder of [
    { state: "pass" },
    { state: "not-checked" },
    { state: "fail", reason: "folder-missing" },
  ])
    expect(hostResult({ ok: true, facts: { ...facts, folder } })).toBe(true);
  for (const folder of [
    { state: "pass", secret: true },
    { state: "fail", reason: "raw" },
    { state: "fail" },
    null,
  ])
    expect(hostResult({ ok: true, facts: { ...facts, folder } })).toBe(false);
  const connection = {
    ssh: { state: "pass" },
    platform: { state: "not-checked" },
    artifact: { state: "fail", reason: "artifact-unavailable" },
  };
  expect(hostResult({ ok: false, reason: "artifact-unavailable", connection })).toBe(true);
  expect(
    hostResult({
      ok: false,
      reason: "artifact-unavailable",
      connection: { ...connection, raw: true },
    }),
  ).toBe(false);
  expect(remoteResponse({ type: "hello", build: "a".repeat(64), hostPreflight: 1 })).toBe(true);
  expect(remoteResponse({ type: "hello", build: "a".repeat(64), hostPreflight: 2 })).toBe(false);
});

test("host nicknames validate literal bounded names, unique labels and legacy defaults", async () => {
  const { hostDisplayName, hostNickname, hostNicknameError } = await import(
    "../../../src/shared/registered-hosts"
  );
  for (const value of ["Dozer", "Équipe 2._-", "a".repeat(40)])
    expect(hostNickname(value)).toBe(true);
  for (const value of [
    undefined,
    "",
    "a".repeat(41),
    " a",
    "a ",
    "a\nb",
    "a\u202eb",
    "$(x)",
    "<b>",
    "a/b",
    "😀",
  ])
    expect(hostNickname(value)).toBe(false);
  expect(hostDisplayName({ host: "slindsey@dozer.local" })).toBe("dozer");
  expect(hostDisplayName({ host: "me@127.0.0.1" })).toBe("127.0.0.1");
  expect(hostDisplayName({ host: "worker" })).toBe("worker");
  expect(hostDisplayName({ host: "me@dozer.local", nickname: "Build box" })).toBe("Build box");
  const entries = [
    { host: "me@one.local", codeFolder: "~/code", nickname: "Dozer" },
    { host: "two.local", codeFolder: "~/code" },
  ];
  expect(registeredHosts(entries)).toBe(true);
  expect(hostNicknameError(entries, "two.local", "dozer")).toBe("Name already used");
  expect(hostNicknameError(entries, "me@one.local", "TWO")).toBe("Name already used");
  expect(hostNicknameError(entries, "me@one.local", "Dozer")).toBeUndefined();
  expect(hostNicknameError(entries, "two.local", "")).toBeUndefined();
  expect(hostNicknameError(entries, "two.local", "<x>")).toMatch(/1–40/);
  expect(registeredHosts([{ ...entries[0], nickname: "" }])).toBe(false);
  expect(
    registeredHosts([...entries, { host: "three", codeFolder: "~/code", nickname: "dozer" }]),
  ).toBe(false);
  expect(
    registeredHosts([
      { host: "a@one.local", codeFolder: "~/code" },
      { host: "b@one.local", codeFolder: "~/code" },
    ]),
  ).toBe(true);
  for (const nickname of ["", "Dozer"])
    expect(hostsAction({ action: "rename", host: "worker", nickname })).toBe(true);
  for (const nickname of [null, "<x>", "x".repeat(41)])
    expect(hostsAction({ action: "rename", host: "worker", nickname })).toBe(false);
  expect(hostsAction({ action: "rename", host: "worker", nickname: "Box", command: "x" })).toBe(
    false,
  );
});

test("clearing nicknames checks the effective default against other nicknames, preserving legacy default duplicates", async () => {
  const { hostNicknameError } = await import("../../../src/shared/registered-hosts");
  const entries = [
    { host: "me@one.local", codeFolder: "~/code", nickname: "Build box" },
    { host: "two.local", codeFolder: "~/code", nickname: "ONE" },
  ];
  expect(registeredHosts(entries)).toBe(true);
  expect(hostNicknameError(entries, "me@one.local", "")).toBe("Name already used");
  expect(hostNicknameError(entries, "two.local", "")).toBeUndefined();
  const legacy = [
    { host: "a@one.local", codeFolder: "~/code" },
    { host: "b@one.local", codeFolder: "~/code" },
  ];
  expect(registeredHosts(legacy)).toBe(true);
  expect(hostNicknameError(legacy, "a@one.local", "")).toBeUndefined();
  expect(
    hostNicknameError(
      [{ host: "other", codeFolder: "~/code", nickname: "127.0.0.1" }],
      "me@127.0.0.1",
      "",
    ),
  ).toBe("Name already used");
});

test("local progress action accepts no host or arbitrary payload", () => {
  expect(hostsAction({ action: "progress" })).toBe(true);
  expect(hostsAction({ action: "progress", host: "worker" })).toBe(false);
});

test("origin trust selects only SSH targets and preserves explicit ports without a command", () => {
  expect(originSshArgs("git@forge.test:team/repo.git")?.slice(-2)).toEqual([
    "--",
    "git@forge.test",
  ]);
  expect(originSshArgs("ssh://git@forge.test:2222/team/repo.git")?.slice(-4)).toEqual([
    "-p",
    "2222",
    "--",
    "git@forge.test",
  ]);
  expect(originSshArgs("forge.test:team/repo.git")?.at(-1)).toBe("forge.test");
  expect(originSshArgs("ssh://forge.test/team/repo.git")?.at(-1)).toBe("forge.test");
  for (const origin of [
    "https://forge.test/team/repo.git",
    "ssh://forge.test:99999/team/repo",
    "-oProxyCommand=x",
    "git@forge.test:a;bad",
    null,
  ])
    expect(originSshArgs(origin)).toBeUndefined();
  expect(hostsAction({ action: "trust-origin", host: "worker", repository: "/local/repo" })).toBe(
    true,
  );
  expect(
    hostsAction({
      action: "trust-origin",
      host: "worker",
      repository: "/local/repo",
      origin: "bad",
    }),
  ).toBe(false);
  const request = {
    type: "open",
    id: "trust",
    request: 1,
    cols: 80,
    rows: 24,
    reattach: false,
    human: true,
    trustOrigin: "git@forge.test:team/repo.git",
  };
  expect(remoteRequest(request)).toBe(true);
  for (const patch of [
    { human: false },
    { reattach: true },
    { checkout: {} },
    { context: {} },
    { recipe: {} },
    { trustOrigin: "https://forge.test/repo" },
  ])
    expect(remoteRequest({ ...request, ...patch })).toBe(false);
});

test("saved host observations accept only bounded display facts and closed checks", () => {
  const result = { ok: true, facts };
  const preflight = {
    ssh: { state: "pass" },
    platform: { state: "not-checked" },
    artifact: { state: "fail", reason: "unreachable" },
    result,
    repositories: [{ repository: "/local/project", origin: { state: "pass" }, checkout: result }],
  };
  const observation = {
    checkedAt: 1700000000000,
    preflight,
    foreignSessions: 2,
    foreignWorktrees: 0,
  };
  const host = { host: "worker", codeFolder: "/remote/code", observation };
  expect(registeredHosts([host])).toBe(true);
  expect(
    registeredHosts([
      {
        ...host,
        observation: {
          checkedAt: 0,
          preflight: { ...preflight, result: { ok: false, reason: "unreachable" } },
        },
      },
    ]),
  ).toBe(true);
  for (const invalid of [
    null,
    [],
    {},
    { ...observation, secret: "raw" },
    { ...observation, checkedAt: -1 },
    { ...observation, checkedAt: 1.5 },
    { ...observation, checkedAt: 8640000000000001 },
    { ...observation, foreignSessions: -1 },
    { ...observation, foreignWorktrees: "0" },
    { ...observation, preflight: null },
    { ...observation, preflight: { ...preflight, raw: "secret" } },
    ...["ssh", "platform", "artifact"].map((key) => ({
      ...observation,
      preflight: { ...preflight, [key]: { state: "invalid" } },
    })),
    { ...observation, preflight: { ...preflight, result: { ok: false, reason: "raw secret" } } },
    {
      ...observation,
      preflight: { ...preflight, result: { ...result, inventory: { own: [], other: 0 } } },
    },
    ...[
      null,
      Array(1001).fill(preflight.repositories[0]),
      [null],
      [{ ...preflight.repositories[0], raw: "output" }],
      [{ ...preflight.repositories[0], repository: 1 }],
      [{ ...preflight.repositories[0], repository: "x".repeat(4097) }],
      [{ ...preflight.repositories[0], repository: "\n" }],
      [{ ...preflight.repositories[0], origin: null }],
      [{ ...preflight.repositories[0], checkout: null }],
    ].map((repositories) => ({ ...observation, preflight: { ...preflight, repositories } })),
  ])
    expect(registeredHosts([{ ...host, observation: invalid }])).toBe(false);
});
