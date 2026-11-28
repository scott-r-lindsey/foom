import { join, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { Dispatcher, type DispatcherHost } from "../../../../src/main/control/dispatcher";
import { ControlService } from "../../../../src/main/control/service";
import { dispatcherRepositoryPath } from "../../../../src/shared/dispatcher-validation";
import { identifier, object } from "../../../../src/shared/control-validation";
import { locationId } from "../../../../src/main/control/metadata";
import { MessageBoard } from "../../../../src/main/control/message-board";
import { Operations } from "../../../../src/main/control/operations";
import {
  MCP_ID_LIMIT,
  MCP_RESPONSE_LIMIT,
  mcpToolResponse,
} from "../../../../src/node-common/mcp-response";
import { atomicPrivate, privateDirectory } from "../../../../src/node-common/private-files";
import type { WorkspaceTerminal } from "../../../../src/shared/workspace";

const directory = resolve("fixture-source");
const repository = resolve(directory, "team", "primary");
const other = resolve("other-projects", "secondary");

function row(id: string, path: string, scope: "source" | "orchestrator"): WorkspaceTerminal {
  return {
    id,
    kind: "agent",
    agent: "claude",
    repository: path,
    worktree: path,
    branch: null,
    attention: "evaluator",
    state: null,
    ...(scope === "source"
      ? { sourceSession: true }
      : { orchestration: { role: "orchestrator", active: true, children: 0, history: [] } }),
  };
}

function harness(orchestration?: ConstructorParameters<typeof ControlService>[2]) {
  const rows = [
    row("dispatcher", directory, "source"),
    row("second", directory, "source"),
    row("primary-orchestrator", repository, "orchestrator"),
  ];
  const repos = [
    { name: "primary", path: repository, identity: "primary-proof" },
    { name: "secondary", path: other, identity: "secondary-proof" },
  ];
  const host = {
    directoryIdentity: vi.fn(() => Promise.resolve("source-proof")),
    repository: vi.fn((_directory: string, path: string) => {
      const repo = repos.find((candidate) => candidate.path === path);
      return repo ? Promise.resolve(repo) : Promise.reject(new Error("repository refused"));
    }),
    repositories: vi.fn(() => Promise.resolve(repos)),
    validateHost: vi.fn(),
    agentName: vi.fn((id: string) => (id === "claude" ? "Claude Code" : undefined)),
    launch: vi.fn<DispatcherHost["launch"]>((_input, _repo, _id, _verify, _active, lifecycle) =>
      Promise.resolve(lifecycle.terminalId),
    ),
    prompt: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
  };
  const save = vi.fn((_state: unknown, validate: () => void) => {
    validate();
    return Promise.resolve();
  });
  const dispatcher = new Dispatcher(
    host,
    () => rows,
    save,
    () => {},
  );
  const persist = vi.fn(() => Promise.resolve());
  const service: ControlService = new ControlService(
    new Operations(persist, (actor) => {
      service.assertActive(actor);
    }),
    () => rows,
    orchestration,
    undefined,
    undefined,
    undefined,
    new MessageBoard(
      async () => {},
      () => [{ id: locationId(repository), name: "Primary" }],
    ),
    dispatcher,
  );
  const source = service.prepare(directory, directory, "agent", null, undefined, true);
  source.bind("dispatcher");
  const second = service.prepare(directory, directory, "agent", null, undefined, true);
  second.bind("second");
  const ordinary = service.prepare(repository, repository, "agent");
  ordinary.bind("ordinary");
  const token = source.env["FOOM_CONTROL_TOKEN"] ?? "";
  function call(method: string, params: unknown = {}, signal?: AbortSignal) {
    const actor = service.authenticate(token);
    return service.call(
      actor,
      { method, params, version: 1, instanceId: service.instanceId },
      signal,
    );
  }
  const elevate = async (selection = [repository]) => {
    await dispatcher.elevate(
      "dispatcher",
      () => Promise.resolve(selection),
      service.setRole.bind(service),
    );
  };
  return { host, dispatcher, service, rows, repos, save, persist, call, elevate, source };
}

const launch = {
  repo: other,
  agent: "claude",
  reason: "Review the fixtures",
  prompt: "Find the owner.",
  idempotencyKey: "secondary-key",
};

test("registered remote orchestrator relay authenticates its own grant and refuses unrelated tools", async () => {
  const { service } = harness();
  const grant = service.prepare(repository, repository, "orchestrator");
  const relay = grant.remoteCall;
  if (!relay) throw new Error("Missing remote relay");
  await expect(relay("whoami", {})).resolves.toMatchObject({ error: "unauthorized" });
  grant.bind("remote-orchestrator", true);
  const identity = await relay("mcp_connected", {});
  if (identity.type !== "identity") throw new Error("Missing relay identity");
  expect(identity.role).toBe("orchestrator");
  expect(identity.capabilities).toContain("sessions");
  const result = await relay("sessions", {});
  if (result.type !== "orchestrator-result") throw new Error("Missing relay result");
  expect(result.payload).toContain("primary-orchestrator");
  await expect(relay("sessions", { repository: other })).resolves.toMatchObject({
    error: "invalid_request",
  });
  for (const method of ["repos", "elevate_dispatcher", "open_preview", "board_answer"])
    await expect(relay(method, {})).resolves.toMatchObject({ error: "forbidden" });
  grant.dispose();
  await expect(relay("sessions", {})).resolves.toMatchObject({ error: "unauthorized" });
});
test("remote board reads return complete local pages that exceed 64 KiB", async () => {
  const { service } = harness({ call: vi.fn(), authorizeBoard: () => {} });
  const grant = service.prepare(repository, repository, "orchestrator");
  grant.bind("primary-orchestrator");
  const relay = grant.remoteCall;
  if (!relay) throw new Error("Missing remote relay");
  const actor = service.authenticate(grant.env["FOOM_CONTROL_TOKEN"] ?? "");
  const call = (method: string, params: unknown) =>
    service.call(actor, { version: 1, instanceId: service.instanceId, method, params });
  const first = await call("board_post", {
    title: "Large page",
    to: [locationId(repository)],
    kind: "fyi",
    text: "x".repeat(8120),
    idempotencyKey: "first",
  });
  if (typeof first !== "object" || !first || !("resultId" in first))
    throw new Error("Missing thread");
  for (let i = 1; i < 8; i++)
    await call("board_post", {
      thread: first.resultId,
      kind: "fyi",
      text: "x".repeat(8120),
      idempotencyKey: `post-${String(i)}`,
    });
  const params = { thread: first.resultId };
  const local = await call("board_read", params);
  expect(local).toMatchObject({ posts: Array(8).fill(expect.any(Object)), next: null });
  expect(Buffer.byteLength(JSON.stringify(local))).toBeGreaterThan(65536);
  const result = await relay("board_read", params);
  expect(result.type).toBe("orchestrator-result");
  if (result.type === "orchestrator-result") expect(result.payload).toBe(JSON.stringify(local));
});

function setup(tool: ReturnType<typeof harness>) {
  return tool.dispatcher.decisions(
    { repository: Dispatcher.decisionScope("dispatcher"), watch: [] },
    { counts: {}, questions: [] },
  );
}

test("dispatcher grants are scoped to source agents and trusted elevation adopts existing orchestrators", async () => {
  const { dispatcher, service, rows, call, elevate, host, save } = harness();
  expect(() => {
    service.setRole("ordinary", "dispatcher");
  }).toThrow("forbidden");
  expect(() => {
    service.setRole("dispatcher", "orchestrator");
  }).toThrow("forbidden");
  await expect(call("elevate_dispatcher")).rejects.toThrow("forbidden");
  await expect(call("repos")).rejects.toThrow("forbidden");
  const select = vi.fn(() => Promise.resolve([repository]));
  await dispatcher.elevate("dispatcher", select, service.setRole.bind(service));
  expect(select).toHaveBeenCalledWith(directory, [
    { name: "primary", path: repository, running: true },
    { name: "secondary", path: other, running: false },
  ]);
  expect(dispatcher.view("dispatcher", rows)).toEqual({ orchestrators: 1, repositories: 1 });
  expect(save).toHaveBeenCalledOnce();
  await expect(
    dispatcher.elevate("second", () => Promise.resolve([]), service.setRole.bind(service)),
  ).rejects.toThrow("conflict");
  await expect(call("session_state", { id: "primary-orchestrator" })).resolves.toMatchObject({
    id: "primary-orchestrator",
    untrusted: true,
  });
  await expect(call("session_state", { id: "someone-else" })).rejects.toThrow("not_found");
  await expect(
    call("prompt", { id: "primary-orchestrator", text: "What changed?", idempotencyKey: "prompt" }),
  ).resolves.toMatchObject({ status: "succeeded" });
  expect(host.prompt).toHaveBeenCalledWith("primary-orchestrator", {
    kind: "prompt",
    text: "What changed?",
  });
  await dispatcher.demote("dispatcher", service.setRole.bind(service));
  expect(dispatcher.view("dispatcher", rows)).toBeUndefined();
  await expect(call("prompt", { id: "primary-orchestrator" })).rejects.toThrow("forbidden");
  await expect(call("repos")).rejects.toThrow("forbidden");
  expect(rows.some((entry) => entry.orchestration?.role === "orchestrator")).toBe(true);
  await elevate([]);
  expect(dispatcher.view("dispatcher", rows)).toEqual({ orchestrators: 0, repositories: 0 });
});

test.each([
  ["once", "succeeded", false],
  ["add", "succeeded", true],
  ["decline", "declined", false],
] as const)(
  "dispatcher grant %s is resolved once and only from the human decision",
  async (option, expected, persistent) => {
    const tool = harness();
    const { dispatcher, call, host, elevate } = tool;
    await elevate();
    await expect(call("launch_orchestrator", launch)).resolves.toMatchObject({
      status: "pending_confirmation",
    });
    await expect(call("launch_orchestrator", launch)).resolves.toMatchObject({
      status: "pending_confirmation",
    });
    const [question] = setup(tool).questions;
    if (!question) throw new Error("Expected a grant question");
    expect(question).toMatchObject({ grant: true, question: { detail: launch.reason } });
    expect(host.launch).not.toHaveBeenCalled();
    await expect(call("board_answer", { id: question.post, option })).rejects.toThrow("forbidden");
    for (const method of ["create_worktree", "launch", "tail", "open_preview", "board_post"])
      await expect(call(method)).rejects.toThrow("forbidden");
    expect(() =>
      dispatcher.answer({
        answers: [{ post: question.post, index: 0, other: "allow" }],
        idempotencyKey: "human",
      }),
    ).toThrow("invalid_request");
    const answer = {
      answers: [{ post: question.post, index: 0, option }],
      idempotencyKey: "human",
    };
    await expect(dispatcher.answer(answer)).resolves.toMatchObject({ post: question.post });
    await expect(dispatcher.answer(answer)).resolves.toMatchObject({ post: question.post });
    expect(() =>
      dispatcher.answer({
        ...answer,
        answers: [{ post: question.post, index: 0, option: option === "add" ? "once" : "add" }],
      }),
    ).toThrow("conflict");
    await expect(
      call("operation_status", { idempotencyKey: launch.idempotencyKey }),
    ).resolves.toMatchObject({ status: expected });
    expect(host.launch).toHaveBeenCalledTimes(option === "decline" ? 0 : 1);
    expect(setup(tool).questions).toEqual([]);
    await expect(call("repos")).resolves.toMatchObject({
      repos: [
        expect.objectContaining({ preApproved: true }),
        expect.objectContaining({ preApproved: persistent }),
      ],
      untrusted: true,
    });
  },
);

test("dispatcher eligibility expires on source exit and a changed repository invalidates grants and adoption", async () => {
  const tool = harness();
  const { dispatcher, call, host, repos, elevate, source } = tool;
  await elevate();
  await call("launch_orchestrator", launch);
  const [question] = setup(tool).questions;
  if (!question || !repos[1]) throw new Error("Expected a launch grant");
  repos[1] = { ...repos[1], identity: "replaced" };
  await dispatcher.answer({
    answers: [{ post: question.post, index: 0, option: "once" }],
    idempotencyKey: "human",
  });
  expect(host.launch).not.toHaveBeenCalled();
  await expect(
    call("operation_status", { idempotencyKey: launch.idempotencyKey }),
  ).resolves.toMatchObject({ status: "failed" });
  source.dispose();
  expect(setup(tool).counts).toEqual({});
});

test("dispatcher stop replay returns the original receipt after the orchestrator exits", async () => {
  const { call, elevate, host, rows } = harness();
  await elevate();
  const stop = { id: "primary-orchestrator", idempotencyKey: "stop-replay" };
  const stopped = await call("stop", stop);
  expect(stopped).toMatchObject({ status: "succeeded" });
  const row = rows.find(({ id }) => id === stop.id);
  if (!row) throw new Error("Missing fixture orchestrator");
  row.exited = true;
  await expect(call("stop", stop)).resolves.toEqual(stopped);
  await expect(call("stop", { ...stop, id: "another" })).rejects.toThrow("conflict");
  expect(host.stop).toHaveBeenCalledOnce();
});

test("dispatcher launch replay returns the original receipt after the repository is renamed", async () => {
  const { call, elevate, host, repos } = harness();
  await elevate();
  const start = { ...launch, repo: repository };
  const started = await call("launch_orchestrator", start);
  expect(started).toMatchObject({ status: "succeeded" });
  const target = repos.find(({ path }) => path === start.repo);
  if (!target) throw new Error("Missing fixture repository");
  target.path = resolve(directory, "renamed");
  await expect(call("launch_orchestrator", start)).resolves.toEqual(started);
  await expect(
    call("launch_orchestrator", { ...start, prompt: "Different prompt" }),
  ).rejects.toThrow("conflict");
  expect(host.launch).toHaveBeenCalledOnce();
});

test("an exited source cannot recover an old scope through the same terminal ID", async () => {
  const { dispatcher, elevate, service, rows, save, source } = harness();
  await elevate();
  const row = rows.find(({ id }) => id === "dispatcher");
  if (!row) throw new Error("Missing source");
  row.conversationId = "same-conversation";
  source.dispose();
  const resumed = service.prepare(directory, directory, "agent", null, undefined, true);
  resumed.bind(row.id);
  dispatcher.prepareQuit();
  await dispatcher.finishQuit();
  expect(save).toHaveBeenCalledOnce();
  expect(dispatcher.view(row.id, rows)).toBeUndefined();
  expect(service.authenticate(resumed.env["FOOM_CONTROL_TOKEN"] ?? "").role).toBe("agent");
});

test("dispatcher persists only validated scope data and reopens it from the private profile", async () => {
  const { host, rows } = harness();
  const profile = await mkdtemp(join(tmpdir(), "foom-dispatcher-store-"));
  try {
    const privatePath = await privateDirectory(profile);
    const dispatcher = await Dispatcher.open(
      privatePath,
      host,
      () => rows,
      () => {},
    );
    const setRole = vi.fn();
    await dispatcher.elevate("dispatcher", () => Promise.resolve(undefined), setRole);
    expect(setRole).not.toHaveBeenCalled();
    await expect(
      dispatcher.elevate("dispatcher", () => Promise.resolve(["absent"]), setRole),
    ).rejects.toThrow("invalid_request");
    await dispatcher.elevate("dispatcher", () => Promise.resolve([repository]), setRole);
    const row = rows.find(({ id }) => id === "dispatcher");
    if (!row) throw new Error("Missing source");
    row.conversationId = "same-conversation";
    dispatcher.prepareQuit();
    await expect(dispatcher.elevate("second", () => Promise.resolve([]), setRole)).rejects.toThrow(
      "unavailable",
    );
    dispatcher.cancelQuit();
    await dispatcher.finishQuit();
    const interrupted = await Dispatcher.open(
      privatePath,
      host,
      () => rows,
      () => {},
    );
    await expect(interrupted.revive(row.id, row.conversationId, setRole)).resolves.toBe(false);
    dispatcher.prepareQuit();
    dispatcher.exited(row.id);
    await dispatcher.finishQuit();
    const reopened = await Dispatcher.open(
      privatePath,
      host,
      () => rows,
      () => {},
    );
    const next = await Dispatcher.open(
      privatePath,
      host,
      () => rows,
      () => {},
    );
    await expect(next.revive(row.id, row.conversationId, setRole)).resolves.toBe(false);
    expect(reopened.view("dispatcher", rows)).toBeUndefined();
    await expect(reopened.revive(row.id, row.conversationId, setRole)).resolves.toBe(true);
    await expect(reopened.revive(row.id, row.conversationId, setRole)).resolves.toBe(false);
    expect(reopened.view("dispatcher", rows)).toEqual({ orchestrators: 1, repositories: 1 });
    await reopened.demote("dispatcher", setRole);
    await expect(reopened.demote("dispatcher", setRole)).rejects.toThrow("not_found");
    await atomicPrivate(privatePath, "dispatchers.json", { version: 2, scopes: [] });
    await expect(
      Dispatcher.open(
        privatePath,
        host,
        () => rows,
        () => {},
      ),
    ).rejects.toThrow("unavailable");
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test.each(["conversation", "directory", "launch"] as const)(
  "dispatcher recovery refuses a changed %s",
  async (change) => {
    const { host, rows, save } = harness();
    const source = rows.find(({ id }) => id === "dispatcher");
    if (!source) throw new Error("Missing source");
    source.conversationId = "saved-conversation";
    if (change === "directory") host.directoryIdentity.mockResolvedValueOnce("moved");
    if (change === "launch")
      host.directoryIdentity.mockImplementationOnce(() => {
        rows[0] = { ...source, launchVersion: 2 };
        return Promise.resolve("source-proof");
      });
    const dispatcher = new Dispatcher(
      host,
      () => rows,
      save,
      () => {},
      [
        {
          id: source.id,
          directory,
          identity: "source-proof",
          restoreConversation: source.conversationId,
          approved: [],
          adopted: [],
        },
      ],
    );
    const setRole = vi.fn();
    await expect(
      dispatcher.revive(
        source.id,
        change === "conversation" ? "new-conversation" : source.conversationId,
        setRole,
      ),
    ).resolves.toBe(false);
    expect(setRole).not.toHaveBeenCalled();
  },
);

test("legacy trusted approval and adoption recover by resolving the prior direct child", async () => {
  const { host, rows, repos } = harness();
  const legacyPath = join(directory, "legacy-project");
  repos.push({ name: "legacy-project", path: legacyPath, identity: "legacy-proof" });
  rows.push(row("legacy-orchestrator", legacyPath, "orchestrator"));
  const source = rows[0];
  if (!source) throw new Error("Missing source");
  source.conversationId = "same-conversation";
  const profile = await mkdtemp(join(tmpdir(), "foom-dispatcher-legacy-"));
  try {
    const privatePath = await privateDirectory(profile);
    const legacy = { name: "legacy-project", identity: "legacy-proof" };
    const scope = {
      id: source.id,
      directory,
      identity: "source-proof",
      approved: [legacy],
      adopted: [{ id: "legacy-orchestrator", ...legacy }],
      restoreConversation: source.conversationId,
    };
    await atomicPrivate(privatePath, "dispatchers.json", { version: 1, scopes: [scope] });
    const open = () =>
      Dispatcher.open(
        privatePath,
        host,
        () => rows,
        () => {},
      );
    const dispatcher = await open();
    await expect(dispatcher.revive(source.id, source.conversationId, vi.fn())).resolves.toBe(true);
    expect(dispatcher.view(source.id, rows)).toEqual({ orchestrators: 1, repositories: 1 });
    await atomicPrivate(privatePath, "dispatchers.json", {
      version: 1,
      scopes: [{ ...scope, approved: [{ ...legacy, name: "../legacy-project" }] }],
    });
    await expect(open()).rejects.toThrow("invalid_request");
  } finally {
    await rm(profile, { force: true, recursive: true });
  }
});

test("a grant cannot launch after repository deregistration and an unknown host cannot request a grant", async () => {
  const tool = harness();
  await tool.elevate();
  tool.host.validateHost.mockImplementationOnce(() => {
    throw new Error("unknown host");
  });
  await expect(tool.call("launch_orchestrator", { ...launch, host: "unknown" })).rejects.toThrow(
    "unknown host",
  );
  expect(setup(tool).questions).toEqual([]);
  await expect(tool.call("launch_orchestrator", launch)).resolves.toMatchObject({
    status: "pending_confirmation",
  });
  const [question] = setup(tool).questions;
  if (!question) throw new Error("Missing grant question");
  tool.repos.splice(1, 1);
  await tool.dispatcher.answer({
    answers: [{ post: question.post, index: question.index, option: "add" }],
    idempotencyKey: "unregistered",
  });
  await expect(
    tool.call("operation_status", { idempotencyKey: launch.idempotencyKey }),
  ).resolves.toMatchObject({
    status: "failed",
  });
  expect(tool.host.launch).not.toHaveBeenCalled();
});

test("dispatcher validates launch, state, wait and input arguments before effects", async () => {
  const { host, call, elevate, rows, dispatcher, service } = harness();
  await elevate();
  for (const patch of [
    { repo: ".hidden" },
    { reason: "\u001b" },
    { host: "-localhost" },
    { title: "Forged title" },
    { agent: "shell" },
  ]) {
    await expect(call("launch_orchestrator", { ...launch, ...patch })).rejects.toThrow(
      "invalid_request",
    );
  }
  await expect(
    call("launch_orchestrator", { ...launch, repo: resolve("unregistered") }),
  ).rejects.toThrow("repository refused");
  await expect(
    call("launch_orchestrator", { ...launch, agent: "missing", idempotencyKey: "unknown-agent" }),
  ).resolves.toMatchObject({ status: "failed" });
  expect(
    service.humanDecisions({ repository: Dispatcher.decisionScope("dispatcher"), watch: [] })
      .questions,
  ).toEqual([]);
  await expect(
    call("prompt", {
      id: "primary-orchestrator",
      text: "\u001b",
      idempotencyKey: "invalid",
    }),
  ).rejects.toThrow("invalid_request");
  await expect(call("wait_for", { ids: [] })).rejects.toThrow("invalid_request");
  await expect(
    call("wait_for", { ids: ["primary-orchestrator", "primary-orchestrator"] }),
  ).rejects.toThrow("invalid_request");
  const id = "primary-orchestrator";
  await expect(call("wait_for", { ids: [id] })).resolves.toMatchObject({
    changed: [id],
    timedOut: false,
  });
  await expect(call("read_handoff", { id })).rejects.toThrow("not_found");
  const primary = rows.find((candidate) => candidate.id === id);
  if (!primary) throw new Error("Fixture orchestrator missing");
  primary.handoff = {
    status: "done",
    seq: 1,
    timestamp: new Date().toISOString(),
    summary: "Reviewed fixture",
    links: ["https://example.test/report"],
  };
  await expect(call("read_handoff", { id, seq: 1 })).resolves.toMatchObject({
    summary: "Reviewed fixture",
    untrusted: true,
  });
  await expect(call("read_handoff", { id, seq: 2 })).rejects.toThrow("not_found");
  await expect(call("stop", { id, idempotencyKey: "stop" })).resolves.toMatchObject({
    status: "succeeded",
  });
  expect(host.stop).toHaveBeenCalledExactlyOnceWith(id);
  host.prompt.mockRejectedValueOnce(new Error("delivery uncertain"));
  await expect(
    call("prompt", { id, text: "Status?", idempotencyKey: "prompt" }),
  ).resolves.toMatchObject({ status: "indeterminate" });
  expect(host.launch).not.toHaveBeenCalled();
  host.directoryIdentity.mockResolvedValueOnce("redirected");
  await expect(call("repos")).rejects.toThrow("conflict");
  const parent = service.prepare(repository, repository, "orchestrator");
  parent.bind(id);
  expect(dispatcher.canReport(service.authenticate(parent.env["FOOM_CONTROL_TOKEN"] ?? ""))).toBe(
    false,
  );
});

test("inventory searches one page, scopes decisions, and refuses stale directories and cursors", async () => {
  const { call, elevate, host, source, service } = harness();
  const token = source.env["FOOM_CONTROL_TOKEN"] ?? "";
  expect(service.listed(service.authenticate(token))).not.toContain("repos");
  await elevate();
  expect(service.listed(service.authenticate(token))).toContain("repos");
  for (const limit of [0, 0.5, 17, "2"]) {
    await expect(call("repos", { limit })).rejects.toThrow("invalid_request");
  }
  await expect(call("repos", { after: resolve(directory, "missing") })).rejects.toThrow(
    "not_found",
  );
  await expect(call("repos", { limit: 1 })).resolves.toMatchObject({
    repos: [
      {
        repo: repository,
        preApproved: true,
        pullRequests: [],
        orchestrators: [
          {
            id: "primary-orchestrator",
            adopted: true,
            host: null,
            state: "quiet_ok",
            decisionCount: 0,
          },
        ],
      },
    ],
    nextCursor: repository,
  });
  await expect(call("repos", { after: repository, limit: 1 })).resolves.toMatchObject({
    repos: [{ repo: other, preApproved: false, orchestrators: [] }],
    nextCursor: null,
  });
  host.directoryIdentity.mockResolvedValueOnce("source-proof").mockResolvedValueOnce("changed");
  await expect(call("repos")).rejects.toThrow("conflict");
  await expect(
    service.call(service.authenticate(token), {
      method: "repos",
      params: {},
      version: 1,
      instanceId: "foreign",
    }),
  ).rejects.toThrow("invalid_request");
});

test("failed elevation and demotion never leave a half-written role grant", async () => {
  const { dispatcher, call, save, elevate, host, service } = harness();
  save.mockRejectedValueOnce(new Error("Disk unavailable"));
  await expect(elevate()).rejects.toThrow("Disk unavailable");
  await expect(call("repos")).rejects.toThrow("forbidden");
  host.directoryIdentity.mockResolvedValueOnce("source-proof").mockResolvedValueOnce("changed");
  await expect(elevate()).rejects.toThrow("conflict");
  await elevate();
  save.mockRejectedValueOnce(new Error("Disk unavailable"));
  await expect(dispatcher.demote("dispatcher", service.setRole.bind(service))).rejects.toThrow(
    "Disk unavailable",
  );
  await expect(call("repos")).resolves.toMatchObject({ untrusted: true });
  await dispatcher.demote("dispatcher", service.setRole.bind(service));
  await expect(call("repos")).rejects.toThrow("forbidden");
});

test("repository inventory pages fit the complete MCP response and retain every repository", async () => {
  const tool = harness({
    call: vi.fn(),
    pullRequest: () => ({
      number: 1,
      headSha: "a".repeat(40),
      state: "OPEN",
      requiredChecks: "pending",
      title: '"'.repeat(1024),
      sourceName: "界".repeat(1024),
      url: "https://example.test/" + "界".repeat(4000),
    }),
  });
  const names = Array.from({ length: 16 }, (_, i) => `project-${i.toString().padStart(2, "0")}`);
  const projects = names.map((name) => ({ name, path: join(directory, name), identity: name }));
  tool.host.repositories.mockResolvedValue(projects);
  for (const project of projects) tool.rows.push(row(project.name, project.path, "orchestrator"));
  await tool.elevate([]);
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page = object(await tool.call("repos", cursor ? { after: cursor } : {}));
    expect(
      Buffer.byteLength(JSON.stringify(mcpToolResponse("\u0000".repeat(MCP_ID_LIMIT), page))),
    ).toBeLessThanOrEqual(MCP_RESPONSE_LIMIT);
    const repos = page["repos"];
    if (!Array.isArray(repos) || !repos.length) throw new Error("Missing repository page");
    for (const repo of repos) seen.push(dispatcherRepositoryPath(object(repo)["repo"]));
    const next = page["nextCursor"];
    cursor = next === null ? null : dispatcherRepositoryPath(next);
    if (cursor) expect(cursor).toBe(seen.at(-1));
  } while (cursor && seen.length < names.length);
  expect(cursor).toBeNull();
  expect(seen).toEqual(projects.map(({ path }) => path));
});

test("failed grant settlement leaves the unattempted suffix open and retryable by the same batch", async () => {
  const tool = harness();
  await tool.elevate([]);
  const second = { ...launch, repo: repository, idempotencyKey: "second-key" };
  await tool.call("launch_orchestrator", launch);
  await tool.call("launch_orchestrator", second);
  const [firstQuestion, secondQuestion] = setup(tool).questions;
  if (!firstQuestion || !secondQuestion) throw new Error("Missing grant questions");
  const batch = {
    idempotencyKey: "declines",
    answers: [firstQuestion, secondQuestion].map(({ post }) => ({
      post,
      index: 0,
      option: "decline",
    })),
  };
  const writing = Promise.withResolvers<undefined>();
  tool.persist.mockReturnValueOnce(writing.promise);
  const pending = tool.dispatcher.answer(batch);
  const failed = expect(pending).rejects.toThrow("unavailable");
  expect(tool.dispatcher.answer(batch)).toBe(pending);
  expect(() =>
    tool.dispatcher.answer({
      idempotencyKey: "overlapping-decline",
      answers: [{ post: secondQuestion.post, index: 0, option: "decline" }],
    }),
  ).toThrow("conflict");
  writing.reject(new Error("Disk unavailable"));
  await failed;
  expect(setup(tool).questions.map(({ post }) => post)).toEqual([secondQuestion.post]);
  await expect(tool.call("launch_orchestrator", launch)).resolves.toMatchObject({
    status: "indeterminate",
  });
  await expect(tool.call("launch_orchestrator", second)).resolves.toMatchObject({
    status: "pending_confirmation",
  });
  await expect(tool.dispatcher.answer(batch)).resolves.toMatchObject({ post: firstQuestion.post });
  await expect(tool.call("launch_orchestrator", second)).resolves.toMatchObject({
    status: "declined",
  });
  expect(setup(tool).questions).toEqual([]);
  expect(tool.host.launch).not.toHaveBeenCalled();
});

test("source exit during the directory check prevents opening the elevation dialog", async () => {
  const { dispatcher, host, save, service, source } = harness();
  const identity = Promise.withResolvers<string>();
  host.directoryIdentity.mockReturnValueOnce(identity.promise);
  const select = vi.fn(() => Promise.resolve([repository]));
  const elevation = dispatcher.elevate("dispatcher", select, service.setRole.bind(service));
  source.dispose();
  identity.resolve("source-proof");
  await expect(elevation).rejects.toThrow("not_found");
  expect(select).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});

test("source exit after elevation commit validation rolls back the saved scope and frees the slot", async () => {
  const { dispatcher, elevate, save, rows, service, source } = harness();
  const entered = Promise.withResolvers<undefined>();
  const saved = Promise.withResolvers<undefined>();
  save.mockImplementationOnce((_state, validate) => {
    validate();
    entered.resolve(undefined);
    return saved.promise;
  });
  const elevation = elevate();
  const rejected = expect(elevation).rejects.toThrow("not_found");
  await entered.promise;
  source.dispose();
  saved.resolve(undefined);
  await rejected;
  expect(dispatcher.view("dispatcher", rows)).toBeUndefined();
  expect(save).toHaveBeenLastCalledWith({ version: 1, scopes: [] }, expect.any(Function));
  await expect(
    dispatcher.elevate("second", () => Promise.resolve([]), service.setRole.bind(service)),
  ).resolves.toBeUndefined();
});

test("a replacement preserves dispatcher read access to the retained previous launch", async () => {
  const { call, elevate, rows } = harness();
  await elevate([other]);
  const started = object(await call("launch_orchestrator", launch));
  expect(started).toMatchObject({ status: "succeeded" });
  const previous = row(identifier(started["resultId"]), other, "orchestrator");
  rows.push(previous);
  previous.exited = true;
  if (previous.orchestration?.role !== "orchestrator")
    throw new Error("Missing orchestration state");
  previous.orchestration.active = false;
  previous.handoff = {
    seq: 1,
    status: "done",
    summary: "Finished",
    links: [],
    timestamp: "2025-01-01T00:00:00.000Z",
  };
  const replaced = object(
    await call("launch_orchestrator", { ...launch, idempotencyKey: "replacement" }),
  );
  expect(replaced).toMatchObject({ status: "succeeded" });
  const replacement = row(identifier(replaced["resultId"]), other, "orchestrator");
  rows.push(replacement);
  await expect(call("session_state", { id: previous.id })).resolves.toMatchObject({
    id: previous.id,
    state: "exited",
  });
  await expect(call("read_handoff", { id: previous.id })).resolves.toMatchObject(previous.handoff);
  // Restored exited rows have saved handoffs but no live orchestration projection.
  delete previous.orchestration;
  previous.dormant = true;
  await expect(call("read_handoff", { id: previous.id })).resolves.toMatchObject(previous.handoff);
  await expect(call("wait_for", { ids: [previous.id] })).resolves.toMatchObject({
    sessions: [{ id: previous.id, state: "exited" }],
    changed: [previous.id],
  });
  await expect(call("session_state", { id: replacement.id })).resolves.toMatchObject({
    id: replacement.id,
  });
  await expect(
    call("prompt", { id: previous.id, text: "Continue", idempotencyKey: "old-prompt" }),
  ).rejects.toThrow("not_found");
  previous.exited = false;
  previous.dormant = false;
  await expect(call("session_state", { id: previous.id })).rejects.toThrow("not_found");
});

test("a failed demotion does not restore an exited dispatcher", async () => {
  const { dispatcher, elevate, rows, save, service, source } = harness();
  await elevate();
  const row = rows.find(({ id }) => id === "dispatcher");
  if (!row) throw new Error("Missing source");
  row.conversationId = "same-conversation";
  dispatcher.prepareQuit();
  const entered = Promise.withResolvers<undefined>();
  const saved = Promise.withResolvers<undefined>();
  save.mockImplementationOnce(() => {
    entered.resolve(undefined);
    return saved.promise;
  });
  const demotion = dispatcher.demote("dispatcher", service.setRole.bind(service));
  const rejected = expect(demotion).rejects.toThrow("Disk unavailable");
  await entered.promise;
  source.dispose();
  saved.reject(new Error("Disk unavailable"));
  await rejected;
  await dispatcher.finishQuit();
  expect(save).toHaveBeenCalledTimes(2);
  dispatcher.cancelQuit();
  await expect(
    dispatcher.elevate("second", () => Promise.resolve([]), service.setRole.bind(service)),
  ).resolves.toBeUndefined();
});

test("distinct repository selectors remain visible in launch approvals", async () => {
  const tool = harness();
  await tool.elevate();
  const names = ["a", "b"].map((suffix) => `${"x".repeat(160)}${suffix}`);
  for (const name of names) {
    tool.repos.push({ name, path: resolve(directory, name), identity: name });
    await expect(
      tool.call("launch_orchestrator", {
        ...launch,
        repo: resolve(directory, name),
        idempotencyKey: name,
      }),
    ).resolves.toMatchObject({ status: "pending_confirmation" });
  }
  expect(setup(tool).questions.map(({ question }) => question.title)).toEqual(
    names.map((name) => `Launch Claude Code orchestrator in ${name}`),
  );
});

test("a full dispatcher refuses a launch before dispatching a spawn and retains its existing handles", async () => {
  const { call, elevate, rows, host } = harness();
  for (let index = 1; index < 128; index++)
    rows.push(row(`retained-${String(index)}`, repository, "orchestrator"));
  await elevate([repository, other]);
  for (const retained of rows.slice(2)) {
    retained.exited = true;
    if (retained.orchestration?.role === "orchestrator") retained.orchestration.active = false;
  }
  const spawn = vi.fn();
  host.launch.mockImplementationOnce(
    (_input, _repository, _dispatcher, _verify, _active, lifecycle) => {
      lifecycle.spawning();
      spawn();
      return Promise.resolve("overflow");
    },
  );
  await expect(call("launch_orchestrator", launch)).resolves.toMatchObject({
    status: "failed",
    reason: "dispatcher_capacity",
    resultId: null,
    detail: "The dispatcher has reached its limit of 128 retained orchestrators.",
  });
  expect(host.launch).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
  await expect(call("session_state", { id: "retained-127" })).resolves.toMatchObject({
    id: "retained-127",
    state: "exited",
  });
});

test("concurrent launches cannot share the final adoption slot before a terminal row exists", async () => {
  const { call, elevate, rows, host, save } = harness();
  for (let index = 1; index < 127; index++)
    rows.push(row(`retained-${String(index)}`, repository, "orchestrator"));
  await elevate([repository, other]);
  const started = Promise.withResolvers<string>();
  const finished = Promise.withResolvers<string>();
  host.launch.mockImplementationOnce((_input, _repo, _id, _verify, _active, lifecycle) => {
    started.resolve(lifecycle.terminalId);
    lifecycle.spawning();
    return finished.promise;
  });
  const first = call("launch_orchestrator", launch);
  const id = await started.promise;
  try {
    const scopes = object(save.mock.lastCall?.[0])["scopes"];
    if (!Array.isArray(scopes)) throw new Error("Missing saved dispatcher scope");
    expect(object(scopes[0])["adopted"]).toContainEqual({
      id,
      path: other,
      identity: "secondary-proof",
      launched: true,
    });
    await expect(
      call("launch_orchestrator", { ...launch, idempotencyKey: "last-slot" }),
    ).resolves.toMatchObject({ status: "failed", reason: "dispatcher_capacity" });
    expect(host.launch).toHaveBeenCalledOnce();
  } finally {
    finished.resolve(id);
    await expect(first).resolves.toMatchObject({ status: "succeeded", resultId: id });
  }
});

test("a launch refused before the spawn boundary records a definitive failure", async () => {
  const { call, elevate, host } = harness();
  await elevate();
  host.launch.mockRejectedValueOnce(new Error("Orchestrator slot occupied"));
  await expect(call("launch_orchestrator", { ...launch, repo: repository })).resolves.toMatchObject(
    {
      status: "failed",
      reason: "refused",
    },
  );
  host.launch.mockImplementationOnce(
    (_input, _repository, _dispatcher, _verify, _active, lifecycle) => {
      lifecycle.spawning();
      return Promise.reject(new Error("Spawn acknowledgment lost"));
    },
  );
  const uncertain = await call("launch_orchestrator", {
    ...launch,
    repo: repository,
    idempotencyKey: "spawn-uncertain",
  });
  expect(uncertain).toMatchObject({
    status: "indeterminate",
    reason: "uncertain",
    resultId: host.launch.mock.lastCall?.[5].terminalId,
  });
});

test("dispatcher wait deduplicates targets, handles an unchanged revision, and honors cancellation", async () => {
  const { call, elevate } = harness();
  await elevate();
  const id = "primary-orchestrator";
  const session: unknown = await call("session_state", { id });
  if (!session || typeof session !== "object" || !("revision" in session)) {
    throw new Error("Expected a session revision");
  }
  const after = { [id]: session.revision };
  await expect(call("wait_for", { ids: [id], after, timeoutMs: 1 })).resolves.toMatchObject({
    changed: [],
    timedOut: true,
  });
  const abort = new AbortController();
  abort.abort();
  await expect(call("wait_for", { ids: [id], after, timeoutMs: 10 }, abort.signal)).rejects.toThrow(
    "unavailable",
  );
});

test("trusted grant projections keep host and reason separate and handoff requires dispatcher launch ownership", async () => {
  const dispatcherHandoff = vi.fn((_actor, _params, authorize: () => void) => {
    authorize();
    return Promise.resolve({ seq: 1 });
  });
  const tool = harness({ call: vi.fn(), dispatcherHandoff });
  const { call, elevate, service, dispatcher, host } = tool;
  await elevate();
  await call("launch_orchestrator", { ...launch, reason: undefined, host: "worker" });
  const scope = Dispatcher.decisionScope("dispatcher");
  const grant = service.humanDecisions({ repository: scope, watch: [] });
  const [question] = grant.questions;
  if (!question) throw new Error("Expected grant");
  expect(question.question.title).toBe("Launch Claude Code orchestrator on worker in secondary");
  expect(question.question.detail).toBeUndefined();
  expect(service.humanDecisions({ repository: "unrelated", watch: [] }).questions).toEqual([]);
  expect(
    service.humanDecisions({ repository: "unrelated", watch: [{ post: question.post, index: 0 }] })
      .questions,
  ).toContainEqual(question);
  const parent = service.prepare(other, other, "orchestrator");
  const report = {
    method: "handoff",
    params: { status: "done", summary: "Finished", idempotencyKey: "report" },
    version: 1,
    instanceId: service.instanceId,
  };
  const relay = parent.remoteCall;
  if (!relay) throw new Error("Missing relay");
  host.launch.mockImplementationOnce(
    async (_request, _repository, _dispatcher, _verify, _active, lifecycle) => {
      lifecycle.spawning();
      lifecycle.binding(lifecycle.terminalId);
      parent.bind(lifecycle.terminalId);
      const identity = await relay("whoami", {});
      if (identity.type !== "identity") throw new Error("Missing relay identity");
      expect(identity.capabilities).toContain("handoff");
      await expect(relay("handoff", report.params)).resolves.toEqual({
        type: "orchestrator-result",
        payload: '{"seq":1}',
      });
      return lifecycle.terminalId;
    },
  );
  await dispatcher.answer({
    answers: [{ post: question.post, index: 0, option: "once" }],
    idempotencyKey: "allow",
  });
  expect(host.launch).toHaveBeenCalledOnce();
  expect(dispatcherHandoff).toHaveBeenCalledOnce();
  const actor = service.authenticate(parent.env["FOOM_CONTROL_TOKEN"] ?? "");
  expect(dispatcher.canReport(actor)).toBe(true);
  await dispatcher.demote("dispatcher", service.setRole.bind(service));
  expect(dispatcher.canReport(actor)).toBe(false);
});
