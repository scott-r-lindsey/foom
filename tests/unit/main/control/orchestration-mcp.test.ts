import { readFileSync } from "node:fs";
import { command } from "../../../../src/cli/commands";
import { object } from "../../../../src/node-common/control-validation";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ControlHttp } from "../../../../src/main/control/http";
import { ControlService } from "../../../../src/main/control/service";
import { Operations } from "../../../../src/main/control/operations";
import { Orchestration } from "../../../../src/main/control/orchestration";
import type { WorkspaceTerminal } from "../../../../src/shared/workspace";

const repo = tmpdir();
let service: ControlService;
let http: ControlHttp;
let tokens: { orchestrator: string; agent: string };
let orchestration: Orchestration;
const rows: WorkspaceTerminal[] = [];
let childLimit = 4;

beforeEach(async () => {
  rows.length = 0;
  childLimit = 4;
  const host = {
    terminals: () => rows,
    createWorktree: (_repository: string, branch: string) =>
      Promise.resolve({ path: join(repo, branch), branch, identity: branch }),
    launch: (_parent: string, _repository: string, worktree: string) => {
      rows.push({
        id: "child",
        kind: "agent",
        agent: "claude",
        repository: repo,
        worktree,
        branch: "feature",
        attention: "evaluator",
        state: null,
      });
      return Promise.resolve("child");
    },
    restoreWorktree: () => Promise.resolve(undefined),
    stop: () => Promise.resolve(),
    close: () => Promise.resolve(),
    reply: vi.fn(() => Promise.resolve()),
    tail: () => Promise.resolve(["ok"]),
    remove: () => Promise.resolve(false),
    dialog: () => Promise.resolve(false),
    changed: vi.fn(),
  };
  orchestration = new Orchestration(host, Date.now, () => childLimit);
  service = new ControlService(
    new Operations(
      () => Promise.resolve(),
      (actor) => {
        service.assertActive(actor);
      },
    ),
    () => rows,
    orchestration,
  );
  http = await ControlHttp.listen(service);
  const slot = orchestration.reserve(repo);
  if ("existing" in slot) throw new Error("unexpected");
  const parent = service.prepare(repo, repo, "orchestrator");
  parent.bind("parent");
  slot.bind("parent");
  const agent = service.prepare(repo, repo);
  agent.bind("agent");
  tokens = {
    orchestrator: parent.env["FOOM_CONTROL_TOKEN"] ?? "",
    agent: agent.env["FOOM_CONTROL_TOKEN"] ?? "",
  };
});
afterEach(async () => {
  await http.close();
});

function client(token: string) {
  let session = "";
  let id = 0;
  const send = async (method: string, params: unknown = {}) => {
    const response = await fetch(http.endpoint.replace("/control/v1", "/mcp"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(session ? { "Mcp-Session-Id": session, "Mcp-Protocol-Version": "2025-11-25" } : {}),
      },
      body: JSON.stringify(
        method.startsWith("notifications/")
          ? { jsonrpc: "2.0", method }
          : { jsonrpc: "2.0", id: ++id, method, params },
      ),
    });
    session ||= response.headers.get("mcp-session-id") ?? "";
    return response.status === 202 ? null : ((await response.json()) as { result: unknown });
  };
  return {
    send,
    async init() {
      const result = await send("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      });
      await send("notifications/initialized");
      return result;
    },
    async tool(name: string, args: unknown) {
      return (await send("tools/call", { name, arguments: args }))?.result as {
        isError: boolean;
        structuredContent?: Record<string, unknown>;
        content: { text: string }[];
      };
    },
  };
}

it("lists orchestration tools to agents but runs them only for the orchestrator", async () => {
  const orchestrator = client(tokens.orchestrator);
  const init = await orchestrator.init();
  expect(JSON.stringify(init)).toMatch(/Foom orchestrator/u);
  const listed = JSON.stringify(await orchestrator.send("tools/list"));
  for (const name of [
    "create_worktree",
    "launch",
    "stop",
    "close",
    "remove_worktree",
    "tail",
    "wait_for",
  ])
    expect(listed).toContain(`"name":"${name}"`);
  expect(listed).toContain(`"name":"operation_status"`);
  expect(listed).toContain(`"name":"prompt"`);
  expect(listed).toContain('"pullRequest"');
  expect(listed).toContain('"oneOf"');
  expect(
    await orchestrator.tool("create_worktree", { pullRequest: 337, idempotencyKey: "no-provider" }),
  ).toMatchObject({ isError: true, content: [{ text: "forge_unavailable" }] });
  const created = await orchestrator.tool("create_worktree", {
    idempotencyKey: "one",
    branch: "feature",
  });
  expect(created.structuredContent).toMatchObject({ status: "succeeded" });
  const launched = await orchestrator.tool("launch", {
    idempotencyKey: "two",
    worktreeId: created.structuredContent?.["resultId"],
    agent: "claude",
  });
  expect(launched.structuredContent).toMatchObject({ status: "succeeded", resultId: "child" });
  expect(
    await orchestrator.tool("prompt", { id: "child", text: "Follow up", idempotencyKey: "prompt" }),
  ).toMatchObject({ structuredContent: { status: "succeeded" } });
  expect(
    await orchestrator.tool("send_keys", {
      id: "child",
      keys: ["y", "enter"],
      idempotencyKey: "keys",
    }),
  ).toMatchObject({ structuredContent: { status: "succeeded" } });
  expect(await orchestrator.tool("prompt", { id: "child", text: "y" })).toMatchObject({
    isError: true,
    content: [{ text: "invalid_request" }],
  });
  expect(
    await orchestrator.tool("launch", {
      idempotencyKey: "three",
      worktreeId: created.structuredContent?.["resultId"],
      agent: "claude",
    }),
  ).toMatchObject({ isError: true, content: [{ text: "conflict" }] });

  const agent = client(tokens.agent);
  expect(JSON.stringify(await agent.init())).toMatch(
    /may make you this repository's Foom orchestrator/u,
  );
  expect(JSON.stringify(await agent.send("tools/list"))).not.toContain('"name":"read_handoff"');
  expect(listed).toContain('"name":"read_handoff"');
  const refused = await agent.tool("stop", { idempotencyKey: "x", id: "child" });
  expect(refused.isError).toBe(true);
  expect(refused.content[0]?.text).toMatch(/^forbidden: you are not this repository's/u);
  const direct = await fetch(http.endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${tokens.agent}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      version: 1,
      instanceId: service.instanceId,
      method: "launch",
      params: { idempotencyKey: "x", worktreeId: "w", agent: "claude" },
    }),
  });
  expect(direct.status).toBe(403);
});

it("a human transfer takes effect on the next call over each client's existing MCP session", async () => {
  const parent = client(tokens.orchestrator);
  await parent.init();
  const agent = client(tokens.agent);
  await agent.init();
  expect(await agent.tool("whoami", {})).toMatchObject({
    structuredContent: {
      role: "agent",
      capabilities: [
        "whoami",
        "sessions",
        "session_state",
        "open_preview",
        "list_previews",
        "close_preview",
      ],
    },
  });
  service.setRole("parent", "agent");
  orchestration.revoke("parent");
  const slot = orchestration.reserve(repo);
  if ("existing" in slot) throw new Error("unexpected");
  service.setRole("agent", "orchestrator");
  slot.bind("agent");
  expect(await agent.tool("whoami", {})).toMatchObject({
    structuredContent: {
      role: "orchestrator",
      parentId: null,
      grantedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u) as unknown,
      tools: expect.arrayContaining([
        { name: "read_handoff", cli: "foom read-handoff" },
        { name: "prompt", cli: "foom prompt" },
        { name: "send_keys", cli: "foom send-keys" },
      ]) as unknown,
    },
  });
  expect(
    (await agent.tool("create_worktree", { idempotencyKey: "a", branch: "next" }))
      .structuredContent,
  ).toMatchObject({ status: "succeeded" });
  const revoked = await parent.tool("create_worktree", { idempotencyKey: "b", branch: "other" });
  expect(revoked.isError).toBe(true);
  expect(revoked.content[0]?.text).toMatch(/call whoami/u);
  // Revoking twice, or a session that has exited, is a no-op; granting one is not.
  service.setRole("parent", "agent");
  service.setRole("gone", "agent");
  expect(() => {
    service.setRole("gone", "orchestrator");
  }).toThrow(expect.objectContaining({ code: "not_found" }));
});

it("holds a bounded wait_for open past the five-second transport deadline", async () => {
  const orchestrator = client(tokens.orchestrator);
  await orchestrator.init();
  const created = await orchestrator.tool("create_worktree", { idempotencyKey: "a", branch: "b" });
  await orchestrator.tool("launch", {
    idempotencyKey: "c",
    worktreeId: created.structuredContent?.["resultId"],
    agent: "claude",
  });
  const first = await orchestrator.tool("wait_for", { ids: ["child"] });
  const revision = (first.structuredContent?.["sessions"] as { revision: string }[])[0]?.revision;
  const started = Date.now();
  const response = await fetch(http.endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${tokens.orchestrator}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      version: 1,
      instanceId: service.instanceId,
      method: "wait_for",
      params: { ids: ["child"], after: { child: revision }, timeoutMs: 5600 },
    }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ result: { timedOut: true, changed: [] } });
  expect(Date.now() - started).toBeGreaterThanOrEqual(5500);
}, 15_000);

it("lists the current configured wait_for bound on each tools request", async () => {
  const agent = client(tokens.agent);
  await agent.init();
  for (const limit of [1, 16, 2]) {
    childLimit = limit;
    const listed = await agent.send("tools/list");
    expect(JSON.stringify(listed)).toContain(`"maxItems":${String(limit)}`);
  }
});

it("lists handoff only for owned children and refuses hidden direct calls", async () => {
  const parent = client(tokens.orchestrator);
  await parent.init();
  const tree = await parent.tool("create_worktree", { branch: "report", idempotencyKey: "tree" });
  await parent.tool("launch", {
    worktreeId: tree.structuredContent?.["resultId"],
    agent: "claude",
    idempotencyKey: "child",
  });
  const grant = service.prepare(repo, join(repo, "report"), "agent", "parent");
  grant.bind("child");
  const child = client(grant.env["FOOM_CONTROL_TOKEN"] ?? "");
  await child.init();
  expect(JSON.stringify(await child.send("tools/list"))).toContain('"name":"handoff"');
  expect((await child.tool("whoami", {})).structuredContent?.["tools"]).toContainEqual({
    name: "handoff",
    cli: "foom handoff",
  });
  expect(JSON.stringify(await child.send("tools/list"))).not.toContain('"name":"read_handoff"');
  expect(
    await child.tool("handoff", { status: "done", summary: "Completed", idempotencyKey: "report" }),
  ).toMatchObject({ isError: false, structuredContent: { seq: 1 } });
  expect(await parent.tool("read_handoff", { id: "child" })).toMatchObject({
    isError: false,
    structuredContent: { summary: "Completed", untrusted: true },
  });
  expect(await parent.tool("handoff", {})).toMatchObject({
    isError: true,
    content: [{ text: "no_parent" }],
  });
  orchestration.takeOver("child");
  expect((await child.tool("whoami", {})).structuredContent?.["tools"]).not.toContainEqual({
    name: "handoff",
    cli: "foom handoff",
  });
  expect(JSON.stringify(await child.send("tools/list"))).not.toContain('"name":"handoff"');
  expect(await child.tool("handoff", {})).toMatchObject({
    isError: true,
    content: [{ text: "no_parent" }],
  });
  expect(await child.tool("read_handoff", { id: "child" })).toMatchObject({ isError: true });
});

it("pins bounded server and discovery wording to the orchestration contract", async () => {
  const doc = readFileSync("docs/orchestration.md", "utf8");
  const parent = client(tokens.orchestrator);
  const initialized = object((await parent.init())?.result);
  const instructions = initialized["instructions"];
  expect(typeof instructions).toBe("string");
  expect(instructions).toBe(doc.match(/\*\*Server instructions\*\*\n\n> ([^\n]+)/u)?.[1]);
  expect(String(instructions).length).toBeLessThanOrEqual(1600);
  expect(instructions).toContain("Use prompt and send_keys");
  expect(instructions).toContain("without human review");
  expect(instructions).not.toContain("Replies to children are unavailable");
  const descriptions = new Map(
    [...doc.matchAll(/^\| `([^`]+)` \| (.+) \|$/gmu)].map((match) => [match[1], match[2]]),
  );
  const listed = object((await parent.send("tools/list"))?.result)["tools"];
  if (!Array.isArray(listed)) throw new Error("missing tools");
  for (const name of [
    "whoami",
    "launch",
    "prompt",
    "send_keys",
    "wait_for",
    "operation_status",
    "read_handoff",
  ]) {
    const tool = listed
      .map((entry: unknown) => object(entry))
      .find((entry) => entry["name"] === name);
    expect(tool?.["description"]).toBe(descriptions.get(name));
    expect(descriptions.get(name)).toBeDefined();
    expect(String(tool?.["description"]).length).toBeLessThanOrEqual(650);
  }
  expect(descriptions.get("whoami")).toMatch(/^Call first:/u);
  expect(descriptions.get("launch")).toContain("one task, acceptance criteria and limits");
  expect(descriptions.get("wait_for")).toContain("quiet is not proof of completion");
  expect(descriptions.get("read_handoff")).toContain(
    "you own integration and reporting to the human",
  );
  expect(descriptions.get("send_keys")).toContain(
    "including answering permission, credential and provider prompts",
  );
  expect(descriptions.get("operation_status")).toContain("never retry with a new key");
});

it("advertises only current capabilities with CLI fallbacks accepted by the real parser", async () => {
  const parent = client(tokens.orchestrator);
  await parent.init();
  const identity = object((await parent.tool("whoami", {})).structuredContent);
  // These are parser inputs, never process launches. Each command gets its required arguments.
  const examples = [
    ["whoami"],
    ["sessions"],
    ["session-state", "child"],
    ["open-preview", "report.md"],
    ["previews"],
    ["close-preview", "preview"],
    ["create-worktree", "branch", "--idempotency-key", "key"],
    ["launch", "tree", "--agent", "claude", "--idempotency-key", "key"],
    ["stop", "child", "--idempotency-key", "key"],
    ["close", "child", "--idempotency-key", "key"],
    ["remove-worktree", "tree", "--idempotency-key", "key"],
    ["tail", "child"],
    ["wait-for", "child"],
    ["prompt", "child", "--text", "Answer", "--idempotency-key", "key"],
    ["send-keys", "child", "--keys", "y,enter", "--idempotency-key", "keys"],
    ["read-handoff", "child"],
    ["operation-status", "--idempotency-key", "key"],
  ];
  const expected = examples.map((args) => ({
    name: command(args).method,
    cli: `foom ${String(args[0])}`,
    ...(args[0] === "wait-for"
      ? {
          longWait:
            "foom wait-for [ID...] --until-event [--after JSON_ID_TO_EVENT] [--timeout SECONDS]",
        }
      : {}),
  }));
  expect(identity["tools"]).toEqual(expected);
  expect(identity["capabilities"]).toEqual(expected.map((tool) => tool.name));
  service.setRole("parent", "agent");
  const revoked = object((await parent.tool("whoami", {})).structuredContent);
  expect(revoked["tools"]).toEqual(expected.slice(0, 6));
  expect(revoked["capabilities"]).toEqual(expected.slice(0, 6).map((tool) => tool.name));
});

it("keeps a blocking CLI request open beyond normal transport deadlines and wakes with metadata", async () => {
  const { call } = await import("../../../../src/cli/client");
  const parent = client(tokens.orchestrator);
  await parent.init();
  const created = await parent.tool("create_worktree", { idempotencyKey: "a", branch: "b" });
  await parent.tool("launch", {
    idempotencyKey: "c",
    worktreeId: created.structuredContent?.["resultId"],
    agent: "claude",
  });
  const subscribe = vi.spyOn(orchestration.childEvents, "subscribe");
  const pending = call(
    { endpoint: http.endpoint, instanceId: service.instanceId, token: tokens.orchestrator },
    command(["wait-for", "--until-event"]),
  );
  await vi.waitFor(() => {
    expect(subscribe).toHaveBeenCalledTimes(1);
  });
  await new Promise((resolve) => setTimeout(resolve, 5600));
  const child = rows[0];
  if (!child) throw new Error("missing child");
  child.exited = true;
  orchestration.childEvents.publish();
  expect(await pending).toMatchObject({
    changed: ["child"],
    timedOut: false,
    sessions: [{ state: "exited" }],
  });
  const refused = await parent.tool("wait_for", { ids: ["child"], untilEvent: true });
  expect(refused.isError).toBe(true);
}, 15000);

it.each(["disconnect", "revoke"])(
  "cleans up an HTTP blocking subscription on %s",
  async (action) => {
    const parent = client(tokens.orchestrator);
    await parent.init();
    const created = await parent.tool("create_worktree", { idempotencyKey: "a", branch: "b" });
    await parent.tool("launch", {
      idempotencyKey: "c",
      worktreeId: created.structuredContent?.["resultId"],
      agent: "claude",
    });
    const subscribe = orchestration.childEvents.subscribe.bind(orchestration.childEvents);
    const off = vi.fn();
    const registered = vi
      .spyOn(orchestration.childEvents, "subscribe")
      .mockImplementation((listener, deadline) => {
        const dispose = subscribe(listener, deadline);
        return () => {
          off();
          dispose();
        };
      });
    const abort = new AbortController();
    const pending = fetch(http.endpoint, {
      method: "POST",
      signal: abort.signal,
      headers: {
        Authorization: `Bearer ${tokens.orchestrator}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: 1,
        instanceId: service.instanceId,
        method: "wait_for",
        params: { untilEvent: true },
      }),
    });
    const outcome = pending.catch(() => undefined);
    await vi.waitFor(() => {
      expect(registered).toHaveBeenCalledTimes(1);
    });
    if (action === "disconnect") abort.abort();
    else service.setRole("parent", "agent");
    const response = await outcome;
    if (action === "revoke") {
      expect(response?.status).toBe(401);
      expect(await response?.json()).toEqual({ error: "unauthorized" });
    }
    await vi.waitFor(() => {
      expect(off).toHaveBeenCalledTimes(1);
    });
  },
);
