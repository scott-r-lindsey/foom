import { join, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { Dispatcher } from "../../../../src/main/control/dispatcher";
import { ControlService } from "../../../../src/main/control/service";
import { MessageBoard } from "../../../../src/main/control/message-board";
import { Operations } from "../../../../src/main/control/operations";
import { atomicPrivate, privateDirectory } from "../../../../src/node-common/private-files";
import type { WorkspaceTerminal } from "../../../../src/shared/workspace";

const directory = resolve("fixture-source");
const repository = resolve(directory, "primary");
const other = resolve(directory, "secondary");

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
    repository: vi.fn((_directory: string, name: string) => {
      const repo = repos.find((candidate) => candidate.name === name);
      return repo ? Promise.resolve(repo) : Promise.reject(new Error("repository refused"));
    }),
    repositories: vi.fn(() => Promise.resolve(repos)),
    agentName: vi.fn((id: string) => (id === "claude" ? "Claude Code" : undefined)),
    launch: vi.fn(() => Promise.resolve("secondary-orchestrator")),
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
  const service: ControlService = new ControlService(
    new Operations(
      () => Promise.resolve(),
      (actor) => {
        service.assertActive(actor);
      },
    ),
    () => rows,
    orchestration,
    undefined,
    undefined,
    undefined,
    new MessageBoard(
      async () => {},
      () => [],
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
  const elevate = async (selection = ["primary"]) => {
    await dispatcher.elevate(
      "dispatcher",
      () => Promise.resolve(selection),
      service.setRole.bind(service),
    );
  };
  return { host, dispatcher, service, rows, repos, save, call, elevate, source };
}

const launch = {
  repo: "secondary",
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
  const select = vi.fn(() => Promise.resolve(["primary"]));
  await dispatcher.elevate("dispatcher", select, service.setRole.bind(service));
  expect(select).toHaveBeenCalledWith(directory, [
    { name: "primary", running: true },
    { name: "secondary", running: false },
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
  const start = { ...launch, repo: "primary" };
  const started = await call("launch_orchestrator", start);
  expect(started).toMatchObject({ status: "succeeded" });
  const target = repos.find(({ name }) => name === start.repo);
  if (!target) throw new Error("Missing fixture repository");
  target.name = "renamed";
  await expect(call("launch_orchestrator", start)).resolves.toEqual(started);
  await expect(
    call("launch_orchestrator", { ...start, prompt: "Different prompt" }),
  ).rejects.toThrow("conflict");
  expect(host.launch).toHaveBeenCalledOnce();
});

test("dispatcher restores a verified scope and rejects a replaced source directory", async () => {
  const { dispatcher, host, elevate, service, rows } = harness();
  await elevate();
  dispatcher.exited("dispatcher");
  host.directoryIdentity.mockResolvedValueOnce("moved");
  await expect(dispatcher.revive("dispatcher", service.setRole.bind(service))).resolves.toBe(false);
  await expect(dispatcher.revive("missing", service.setRole.bind(service))).resolves.toBe(false);
  await expect(dispatcher.revive("dispatcher", service.setRole.bind(service))).resolves.toBe(true);
  expect(dispatcher.view("dispatcher", rows)).toEqual({ orchestrators: 1, repositories: 1 });
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
    await dispatcher.elevate("dispatcher", () => Promise.resolve(["primary"]), setRole);
    const reopened = await Dispatcher.open(
      privatePath,
      host,
      () => rows,
      () => {},
    );
    expect(reopened.view("dispatcher", rows)).toBeUndefined();
    await expect(reopened.revive("dispatcher", setRole)).resolves.toBe(true);
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

test("dispatcher validates launch, state, wait and input arguments before effects", async () => {
  const { host, call, elevate, rows, dispatcher, service } = harness();
  await elevate();
  for (const patch of [
    { repo: "/outside" },
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
  await expect(call("repos", { after: "missing" })).rejects.toThrow("not_found");
  await expect(call("repos", { limit: 1 })).resolves.toMatchObject({
    repos: [
      {
        repo: "primary",
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
    nextCursor: "primary",
  });
  await expect(call("repos", { after: "primary", limit: 1 })).resolves.toMatchObject({
    repos: [{ repo: "secondary", preApproved: false, orchestrators: [] }],
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
  expect(question.question.title).toBe("Launch Claude Code orchestrator in secondary on worker");
  expect(question.question.detail).toBeUndefined();
  expect(service.humanDecisions({ repository: "unrelated", watch: [] }).questions).toEqual([]);
  expect(
    service.humanDecisions({ repository: "unrelated", watch: [{ post: question.post, index: 0 }] })
      .questions,
  ).toContainEqual(question);
  await dispatcher.answer({
    answers: [{ post: question.post, index: 0, option: "once" }],
    idempotencyKey: "allow",
  });
  expect(host.launch).toHaveBeenCalledOnce();
  const parent = service.prepare(other, other, "orchestrator");
  parent.bind("secondary-orchestrator");
  const actor = service.authenticate(parent.env["FOOM_CONTROL_TOKEN"] ?? "");
  const report = {
    method: "handoff",
    params: { status: "done", summary: "Finished", idempotencyKey: "report" },
    version: 1,
    instanceId: service.instanceId,
  };
  await expect(service.call(actor, report)).resolves.toEqual({ seq: 1 });
  expect(dispatcherHandoff).toHaveBeenCalledOnce();
  await dispatcher.demote("dispatcher", service.setRole.bind(service));
  expect(dispatcher.canReport(actor)).toBe(false);
});
