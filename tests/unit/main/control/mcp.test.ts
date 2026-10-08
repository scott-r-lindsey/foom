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
beforeEach(async () => {
  service = new ControlService(
    new Operations(
      () => Promise.resolve(),
      (actor) => {
        service.assertActive(actor);
      },
    ),
  );
  http = await ControlHttp.listen(service);
  const launch = service.prepare(tmpdir(), tmpdir());
  launch.bind("terminal");
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
  for (const name of [
    "tail",
    "launch",
    "reply",
    "stop",
    "operation_status",
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
    { ...initialize, params: { ...initialize.params, protocolVersion: "old" } },
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
