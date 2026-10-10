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
const rows: WorkspaceTerminal[] = [];

beforeEach(async () => {
  rows.length = 0;
  const host = {
    terminals: () => rows,
    createWorktree: (_repository: string, branch: string) =>
      Promise.resolve({ path: join(repo, branch), branch }),
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
    stop: () => Promise.resolve(),
    tail: () => Promise.resolve(["ok"]),
    remove: () => Promise.resolve(false),
    dialog: () => Promise.resolve(false),
    changed: vi.fn(),
  };
  const orchestration = new Orchestration(host);
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

it("lists orchestration tools only to the orchestrator and runs them through the service", async () => {
  const orchestrator = client(tokens.orchestrator);
  const init = await orchestrator.init();
  expect(JSON.stringify(init)).toMatch(/Foom orchestrator/u);
  const listed = JSON.stringify(await orchestrator.send("tools/list"));
  for (const name of ["create_worktree", "launch", "stop", "remove_worktree", "tail", "wait_for"])
    expect(listed).toContain(`"name":"${name}"`);
  expect(listed).toContain(`"name":"operation_status"`);
  expect(listed).not.toContain(`"name":"reply"`);
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
  expect(await orchestrator.tool("reply", { id: "child", text: "y" })).toMatchObject({
    isError: true,
    content: [{ text: "forbidden" }],
  });
  expect(
    await orchestrator.tool("launch", {
      idempotencyKey: "three",
      worktreeId: created.structuredContent?.["resultId"],
      agent: "claude",
    }),
  ).toMatchObject({ isError: true, content: [{ text: "conflict" }] });

  const agent = client(tokens.agent);
  expect(JSON.stringify(await agent.init())).not.toMatch(/orchestrator/u);
  const agentTools = JSON.stringify(await agent.send("tools/list"));
  expect(agentTools).not.toContain("create_worktree");
  expect(await agent.tool("stop", { idempotencyKey: "x", id: "child" })).toMatchObject({
    isError: true,
    content: [{ text: "forbidden" }],
  });
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
