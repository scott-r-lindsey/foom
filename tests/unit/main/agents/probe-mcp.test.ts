import { request } from "node:http";
import { expect, test } from "vitest";
import { ProbeMcp } from "../../../../src/main/agents/probe-mcp";
import { CONTROL_TOOL_CLASSES } from "../../../../src/shared/control-tool-classes";

function post(
  url: string,
  token: string,
  body: unknown,
  headers: Record<string, string> = {},
  method = "POST",
) {
  return new Promise<{
    status: number | undefined;
    body: string;
    session: string | string[] | undefined;
  }>((resolve, reject) => {
    const req = request(
      url.replace("/control/v1", "/mcp"),
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...headers,
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode, body, session: res.headers["mcp-session-id"] });
        });
      },
    );
    req.on("error", reject);
    req.end(typeof body === "string" ? body : JSON.stringify(body));
  });
}
const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "fixture", version: "1" },
  },
};
test("probe-only MCP authenticates, negotiates, lists only ping and refuses every control tool", async () => {
  const mcp = await ProbeMcp.listen();
  const other = await ProbeMcp.listen();
  try {
    expect((await post(mcp.url, other.token, initialize)).status).toBe(401);
    expect((await post(mcp.url, "bad", initialize)).status).toBe(401);
    for (const headers of [{ origin: "http://evil" }, { host: "localhost" }])
      expect((await post(mcp.url, mcp.token, initialize, headers)).status).toBe(403);
    expect((await post(mcp.url + "/other", mcp.token, initialize)).status).toBe(403);
    expect((await post(mcp.url, mcp.token, initialize, {}, "GET")).status).toBe(405);
    expect(
      (await post(mcp.url, mcp.token, initialize, { "content-type": "text/plain" })).status,
    ).toBe(415);
    expect((await post(mcp.url, mcp.token, "x".repeat(65537))).status).toBe(413);
    for (const body of [
      "{",
      [],
      {},
      { ...initialize, id: {} },
      { ...initialize, jsonrpc: "1" },
      { ...initialize, params: { ...initialize.params, protocolVersion: "bad" } },
      { ...initialize, params: { ...initialize.params, clientInfo: {} } },
      { ...initialize, id: undefined },
    ])
      expect((await post(mcp.url, mcp.token, body)).status).toBe(400);
    const initialized = await post(mcp.url, mcp.token, initialize);
    expect(initialized.status).toBe(200);
    expect(typeof initialized.session).toBe("string");
    if (typeof initialized.session !== "string") throw Error("Missing session");
    const headers = { "mcp-session-id": initialized.session, "mcp-protocol-version": "2025-11-25" };
    const call = (method: string, params?: unknown, id: string | number | undefined = 2) =>
      post(
        mcp.url,
        mcp.token,
        { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) },
        headers,
      );
    expect(mcp.snapshot()).toEqual({ connected: true, listedTools: false, pinged: false });
    expect((await call("tools/list")).status).toBe(400);
    expect((await post(mcp.url, mcp.token, initialize, headers)).status).toBe(400);
    expect(
      (await post(mcp.url, mcp.token, initialize, { "mcp-session-id": "foreign" })).status,
    ).toBe(400);
    expect(
      (await post(mcp.url, mcp.token, initialize, { ...headers, "mcp-protocol-version": "bad" }))
        .status,
    ).toBe(400);
    expect(
      (
        await post(
          mcp.url,
          mcp.token,
          { jsonrpc: "2.0", method: "notifications/initialized" },
          headers,
        )
      ).status,
    ).toBe(202);
    const listed: unknown = JSON.parse((await call("tools/list")).body);
    expect(listed).toMatchObject({ result: { tools: [{ name: "ping" }] } });
    expect((await call("tools/list")).body.match(/"name":/gu)).toHaveLength(1);
    expect((await call("tools/call", { name: "ping", arguments: {} })).body).toContain("pong");
    expect((await call("tools/call", { name: "ping" }, "string-id")).status).toBe(200);
    for (const name of Object.keys(CONTROL_TOOL_CLASSES)) {
      const response = await call("tools/call", {
        name,
        arguments: { id: "foreign", role: "orchestrator" },
      });
      expect(response.status).toBe(200);
      expect(response.body).toContain('"isError":true');
      expect(response.body).toContain("forbidden");
    }
    expect((await call("ping", { _meta: {} })).body).toContain('"result":{}');
    expect((await call("launch", { role: "orchestrator" })).body).toContain("Method not found");
    expect(
      (await call("tools/call", { name: "ping", arguments: { unexpected: true } })).status,
    ).toBe(400);
    expect(
      (await post(mcp.url, mcp.token, { jsonrpc: "2.0", method: "other" }, headers)).status,
    ).toBe(400);
    expect(mcp.snapshot()).toEqual({ connected: true, listedTools: true, pinged: true });
    expect((await post(mcp.url, mcp.token, {}, headers, "DELETE")).status).toBe(204);
    expect((await call("tools/list")).status).toBe(400);
    expect(
      (await post(mcp.url, mcp.token, { jsonrpc: "2.0", id: 4, method: "tools/list" })).status,
    ).toBe(400);
  } finally {
    mcp.close();
    other.close();
  }
  await expect(post(mcp.url, mcp.token, initialize)).rejects.toThrow();
});
