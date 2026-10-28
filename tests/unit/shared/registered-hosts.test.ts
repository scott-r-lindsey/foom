import { expect, test } from "vitest";
import {
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
    codeFolder: "/code",
    directory: "repo",
    origin: "git@fixture.test:team/repo.git",
    branch: "feature",
  };
  expect(hostManagement(request)).toBe(true);
  expect(remoteRequest(request)).toBe(true);
  for (const patch of [
    { branch: "-evil" },
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
  for (const patch of [{ branch: "" }, { identity: "x" }, { changes: 1 }, { extra: true }])
    expect(hostResult({ ok: true, facts, worktree: { ...worktree, ...patch } })).toBe(false);
});
