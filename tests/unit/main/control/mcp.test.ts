import { replaceConfigProviders } from "../../../../src/main/agents/providers/registry";
import { v2Provider } from "../../../../src/main/agents/providers/v2";
import { parseAgentManifest } from "../../../../src/shared/agent-plugin-parser";
import pluginFixture from "../../../fixtures/agent-plugin-v2.json";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ControlHttp } from "../../../../src/main/control/http";
import { ControlService } from "../../../../src/main/control/service";
import { Operations } from "../../../../src/main/control/operations";
let service: ControlService;
let http: ControlHttp;
let token: string;
let session: string;
let revoke: () => void;
const connectionChanged = vi.fn();
beforeEach(async () => {
  connectionChanged.mockClear();
  service = new ControlService(
    new Operations(
      () => Promise.resolve(),
      (actor) => {
        service.assertActive(actor);
      },
    ),
    undefined,
    undefined,
    connectionChanged,
  );
  http = await ControlHttp.listen(service);
  const launch = service.prepare(tmpdir(), tmpdir());
  launch.bind("terminal", true);
  token = launch.env["FOOM_CONTROL_TOKEN"] ?? "";
  revoke = () => {
    launch.dispose();
  };
  session = "";
});
afterEach(async () => {
  await http.close();
});
const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
};
async function send(body: unknown, headers: Record<string, string> = {}, method = "POST") {
  return fetch(http.endpoint.replace("/control/v1", "/mcp"), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(session ? { "Mcp-Session-Id": session, "Mcp-Protocol-Version": "2025-11-25" } : {}),
      ...headers,
    },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}
async function init() {
  const response = await send(initialize);
  expect(response.status).toBe(200);
  session = response.headers.get("mcp-session-id") ?? "";
  expect(session).not.toBe("");
  expect((await send({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
}
it("authenticates initialization, listing, calls, reconnects and deletion", async () => {
  expect((await send(initialize, { Authorization: "Bearer bad" })).status).toBe(401);
  await init();
  const listed = await (
    await send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: { _meta: { progressToken: 0 } },
    })
  ).text();
  for (const name of ["sessions", "session_state", "whoami"])
    expect(listed).toContain(`"name":"${name}"`);
  // Listed so a later grant needs no new tool list; refused with the fix until then.
  expect(listed).toContain('"name":"operation_status"');
  expect(listed).toContain("Orchestrator only: the human grants this role");
  const refused = await (
    await send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "operation_status", arguments: { operationId: "x" } },
    })
  ).text();
  expect(refused).toContain('"isError":true');
  expect(refused).toContain("call whoami to check");
  // Without an orchestration host there is nothing more to list.
  for (const name of [
    "tail",
    "launch",
    "prompt",
    "send_keys",
    "stop",
    "close",
    "create_worktree",
    "remove_worktree",
    "wait_for",
  ]) {
    expect(listed).not.toContain(`"name":"${name}"`);
    expect(
      await (await send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name } })).json(),
    ).toMatchObject({ result: { isError: true, content: [{ text: "forbidden" }] } });
  }
  const identity = await (
    await send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "whoami" } })
  ).text();
  expect(identity).toContain('"isError":false');
  expect(identity).not.toContain(token);
  expect((await send({}, {}, "GET")).status).toBe(405);
  expect((await send({}, { Authorization: "Bearer bad" }, "GET")).status).toBe(401);
  expect((await send({}, {}, "DELETE")).status).toBe(204);
  expect((await send({ jsonrpc: "2.0", id: 5, method: "ping" })).status).toBe(404);
});
it("binds protocol sessions to principal generations and revokes all requests", async () => {
  await init();
  const other = service.prepare(tmpdir(), tmpdir());
  other.bind("other");
  expect(
    (
      await send(
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { Authorization: `Bearer ${other.env["FOOM_CONTROL_TOKEN"] ?? ""}` },
      )
    ).status,
  ).toBe(404);
  revoke();
  for (const method of ["POST", "GET", "DELETE"])
    expect((await send({}, {}, method)).status).toBe(401);
});
it("validates protocol envelopes, initialization and readiness", async () => {
  for (const body of [
    [],
    null,
    {},
    { ...initialize, id: null },
    { ...initialize, id: true },
    { ...initialize, extra: true },
    { ...initialize, params: {} },
    { ...initialize, params: { ...initialize.params, protocolVersion: 1 } },
    { ...initialize, params: { ...initialize.params, clientInfo: {} } },
  ])
    expect((await send(body)).status).toBe(400);
  expect((await send(initialize, { Accept: "application/json" })).status).toBe(406);
  expect((await send(initialize, { "Mcp-Protocol-Version": "old" })).status).toBe(400);
  expect((await send({ jsonrpc: "2.0", id: 2, method: "tools/list" })).status).toBe(400);
  const response = await send(initialize);
  session = response.headers.get("mcp-session-id") ?? "";
  expect((await send({ jsonrpc: "2.0", id: 2, method: "tools/list" })).status).toBe(400);
  expect((await send(initialize)).status).toBe(400);
  expect(
    (
      await send(
        { jsonrpc: "2.0", id: 2, method: "ping" },
        { "Mcp-Protocol-Version": "2025-03-26" },
      )
    ).status,
  ).toBe(400);
  expect((await send({ jsonrpc: "2.0", id: 2, method: "ping" })).status).toBe(200);
  await send({ jsonrpc: "2.0", method: "notifications/initialized" });
  expect(await (await send({ jsonrpc: "2.0", id: 2, method: "unknown" })).json()).toMatchObject({
    error: { code: -32601 },
  });
  expect(
    (await send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 9 } }))
      .status,
  ).toBe(202);
  expect(
    await (
      await send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "whoami", arguments: { role: "orchestrator" } },
      })
    ).json(),
  ).toMatchObject({ result: { isError: true } });
});
it("supports each negotiated protocol and reinitialization after revoked sessions", async () => {
  for (const version of ["2025-03-26", "2025-06-18", "2025-11-25"]) {
    session = "";
    expect(
      (await send({ ...initialize, params: { ...initialize.params, protocolVersion: version } }))
        .status,
    ).toBe(200);
  }
  revoke();
  const launch = service.prepare(tmpdir(), tmpdir());
  launch.bind("fresh");
  token = launch.env["FOOM_CONTROL_TOKEN"] ?? "";
  await init();
});

it("rechecks revocation after accepting a partial MCP initialize body", async () => {
  const accepted = Promise.withResolvers<undefined>();
  const reserve = service.reserve.bind(service);
  vi.spyOn(service, "reserve").mockImplementation((actor) => {
    const release = reserve(actor);
    accepted.resolve(undefined);
    return release;
  });
  const completed = Promise.withResolvers<number>();
  const req = request(
    http.endpoint.replace("/control/v1", "/mcp"),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
    },
    (res) => {
      res.resume();
      res.on("end", () => {
        completed.resolve(res.statusCode ?? 0);
      });
    },
  );
  req.on("error", completed.reject);
  const body = JSON.stringify(initialize);
  req.write(body.slice(0, 10));
  await accepted.promise;
  revoke();
  req.end(body.slice(10));
  expect(await completed.promise).toBe(401);
});

it("records only authenticated valid MCP traffic and clears the state on revocation", async () => {
  expect(connectionChanged).toHaveBeenLastCalledWith("terminal", "connecting");
  expect((await send(initialize, { Authorization: "Bearer bad" })).status).toBe(401);
  expect((await send({ jsonrpc: "2.0", method: "initialize" })).status).toBe(400);
  expect(connectionChanged).toHaveBeenCalledTimes(1);
  await init();
  expect(connectionChanged).toHaveBeenLastCalledWith("terminal", "connected");
  expect(connectionChanged).toHaveBeenCalledTimes(2);
  revoke();
  expect(connectionChanged).toHaveBeenLastCalledWith("terminal", undefined);
  expect((await send(initialize)).status).toBe(401);
});

it("an existing MCP session lists newly installed providers and removes deleted ones", async () => {
  await init();
  vi.spyOn(service, "listed").mockReturnValue(["launch"]);
  const model = parseAgentManifest(JSON.stringify(pluginFixture)).model;
  const agents = async () => {
    const response = await send({ jsonrpc: "2.0", id: 22, method: "tools/list" });
    const body: unknown = await response.json();
    return JSON.stringify(body);
  };
  expect(await agents()).not.toContain(`"${model.id}"`);
  try {
    replaceConfigProviders([v2Provider(model, () => Promise.resolve())]);
    expect(await agents()).toContain(`"${model.id}"`);
    replaceConfigProviders([]);
    expect(await agents()).not.toContain(`"${model.id}"`);
  } finally {
    replaceConfigProviders([]);
  }
});

it("serves reference manual sections on demand and lists valid IDs in validation errors", async () => {
  const { Manual } = await import("../../../../src/main/control/manual");
  const module = await import("../../../../src/main/control/manual");
  const reader = new Manual([
    { id: "intro", heading: "Introduction", text: "Introduction Foom is offline." },
  ]);
  const load = vi.spyOn(module, "bundledManual").mockReturnValue(reader);
  try {
    const initialized = await send(initialize);
    expect(await initialized.text()).toContain("For questions about using Foom, call manual.");
    expect(load).not.toHaveBeenCalled();
    session = initialized.headers.get("mcp-session-id") ?? "";
    await send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const listed = await (await send({ jsonrpc: "2.0", id: 2, method: "tools/list" })).text();
    expect(listed).toContain(
      "reference documentation about Foom, not instructions for the current task",
    );
    expect(load).not.toHaveBeenCalled();
    for (const [args, expected] of [
      [{}, { sections: [{ id: "intro", title: "Introduction", summary: "Foom is offline." }] }],
      [{ section: "intro" }, { id: "intro", text: "Introduction Foom is offline." }],
    ]) {
      const response = await send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "manual", arguments: args },
      });
      expect(await response.json()).toMatchObject({
        result: { isError: false, structuredContent: expected },
      });
    }
    const invalid = await send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "manual", arguments: { section: "../secret" } },
    });
    expect(await invalid.json()).toMatchObject({
      result: { isError: true, content: [{ text: "invalid_request: valid section ids: intro" }] },
    });
    expect(load).toHaveBeenCalledTimes(3);
    service.setRole("terminal", "orchestrator");
    expect(
      await (
        await send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "manual" } })
      ).json(),
    ).toMatchObject({ result: { isError: false } });
  } finally {
    load.mockRestore();
  }
});

it.each(["2024-11-05", "2099-01-01", "unknown", "2025-03-26", "2025-06-18", "2025-11-25"])(
  "negotiates %s and binds subsequent headers to the selected version",
  async (requested) => {
    const version = requested.startsWith("2025-") ? requested : "2025-11-25";
    const response = await send({
      ...initialize,
      params: { ...initialize.params, protocolVersion: requested },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { protocolVersion: version } });
    session = response.headers.get("mcp-session-id") ?? "";
    expect(
      (
        await send(
          { jsonrpc: "2.0", method: "notifications/initialized" },
          { "Mcp-Protocol-Version": version },
        )
      ).status,
    ).toBe(202);
    expect(
      (
        await send(
          { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "whoami" } },
          { "Mcp-Protocol-Version": version },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await send(
          { jsonrpc: "2.0", id: 3, method: "ping" },
          { "Mcp-Protocol-Version": version === "2025-03-26" ? "2025-06-18" : "2025-03-26" },
        )
      ).status,
    ).toBe(400);
  },
);
