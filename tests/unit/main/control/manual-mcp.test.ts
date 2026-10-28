import { connect } from "node:net";
import * as limits from "../../../../src/main/control/http-limits";
import { request } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ManualMcp } from "../../../../src/main/control/manual-mcp";
import { Manual } from "../../../../src/main/control/manual";
import * as manual from "../../../../src/main/control/manual";
import { mcpTools, manualTools } from "../../../../src/shared/control-tools";

let mcp: ManualMcp;
let session = "";
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
beforeEach(async () => {
  mcp = await ManualMcp.listen();
  session = "";
  vi.spyOn(manual, "bundledManual").mockReturnValue(
    new Manual([{ id: "intro", heading: "Intro", text: "Foom reference." }]),
  );
});
afterEach(() => {
  mcp.dispose();
  vi.restoreAllMocks();
});
function send(
  body: unknown,
  headers: Record<string, string> = {},
  method = "POST",
  url = mcp.url.replace("/control/v1", "/mcp"),
) {
  return fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${mcp.token}`,
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
  expect(await response.json()).toMatchObject({
    result: { instructions: "For questions about using Foom, call manual." },
  });
  expect((await send({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
}
const call = (name: string, args: unknown = {}) =>
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } });
it("registers exactly manual and refuses every control tool and arbitrary names as unknown", async () => {
  await init();
  const listed: unknown = await (
    await send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: {} } })
  ).json();
  expect(listed).toMatchObject({ result: { tools: [{ name: "manual" }] } });
  expect(manualTools).toHaveLength(1);
  expect(listed).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: manualTools } });
  for (const name of [...mcpTools(4, ["codex"]).map((tool) => tool.name), "unknown", "__proto__"]) {
    if (name === "manual") continue;
    const refused = await call(name);
    expect(refused.status).toBe(200);
    expect(await refused.json()).toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32602, message: "Unknown tool" },
    });
  }
  expect(await (await call("manual")).json()).toMatchObject({
    result: { isError: false, structuredContent: { sections: [{ id: "intro" }] } },
  });
  expect(await (await call("manual", { section: "intro" })).json()).toMatchObject({
    result: { structuredContent: { text: "Foom reference." } },
  });
  expect(await (await call("manual", { section: "../secret" })).json()).toMatchObject({
    result: { isError: true, content: [{ text: "invalid_request: valid section ids: intro" }] },
  });
  expect(await (await call("manual", { path: "/secret" })).json()).toMatchObject({
    result: { isError: true },
  });
  vi.mocked(manual.bundledManual).mockImplementation(() => {
    throw Error("Unavailable");
  });
  expect(await (await call("manual")).json()).toMatchObject({ result: { isError: true } });
});
it("isolates credentials and protocol sessions, closes its listener and never serves control", async () => {
  const other = await ManualMcp.listen();
  try {
    expect(other.token).not.toBe(mcp.token);
    expect(mcp.env).toEqual({ FOOM_CONTROL_URL: mcp.url, FOOM_CONTROL_TOKEN: mcp.token });
    expect(mcp.toolNames).toEqual(["manual"]);
    expect((await send(initialize, { Authorization: `Bearer ${other.token}` })).status).toBe(401);
    expect((await send(initialize, {}, "POST", mcp.url)).status).toBe(403);
    await init();
    const url = mcp.url;
    mcp.dispose();
    mcp.dispose();
    await expect(send(initialize, {}, "POST", url)).rejects.toThrow();
  } finally {
    other.dispose();
  }
});
it("rejects invalid transport and protocol input and supports deletion and reinitialization", async () => {
  for (const [headers, status] of [
    [{ Authorization: "Bearer wrong" }, 401],
    [{ Origin: "https://example.com" }, 403],
    [{ "Mcp-Session-Id": "wrong" }, 400],
    [{ "Mcp-Protocol-Version": "old" }, 400],
    [{ "Content-Type": "text/plain" }, 415],
  ] as const)
    expect((await send(initialize, headers)).status).toBe(status);
  expect((await send({}, {}, "GET")).status).toBe(405);
  for (const body of [
    null,
    {},
    { ...initialize, id: null },
    { ...initialize, id: true },
    { ...initialize, id: "x".repeat(201) },
    { ...initialize, id: 0.5 },
    { ...initialize, jsonrpc: "1" },
    { ...initialize, method: 1 },
    { ...initialize, extra: true },
    { ...initialize, params: { ...initialize.params, protocolVersion: 1 } },
    { ...initialize, params: { ...initialize.params, protocolVersion: "old" } },
    { ...initialize, params: { ...initialize.params, clientInfo: { name: 1, version: "1" } } },
    { ...initialize, params: { ...initialize.params, clientInfo: { name: "x", version: 1 } } },
    { ...initialize, id: undefined },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ])
    expect((await send(body)).status).toBe(400);
  const response = await send(initialize);
  session = response.headers.get("mcp-session-id") ?? "";
  expect((await send({ jsonrpc: "2.0", id: 2, method: "tools/list" })).status).toBe(400);
  expect((await send(initialize)).status).toBe(400);
  await send({ jsonrpc: "2.0", method: "notifications/initialized" });
  expect(
    (
      await send(
        { jsonrpc: "2.0", id: 2, method: "ping" },
        { "Mcp-Protocol-Version": "2025-03-26" },
      )
    ).status,
  ).toBe(400);
  expect((await send({ jsonrpc: "2.0", id: "ping", method: "ping" })).status).toBe(200);
  expect((await send({ jsonrpc: "2.0", method: "notifications/other" })).status).toBe(400);
  expect(await (await send({ jsonrpc: "2.0", id: 2, method: "unknown" })).json()).toMatchObject({
    error: { code: -32601 },
  });
  expect(
    (
      await send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "manual", force: true },
      })
    ).status,
  ).toBe(400);
  expect((await send({}, {}, "DELETE")).status).toBe(204);
  expect((await call("manual")).status).toBe(400);
  session = "";
  await init();
});
it("bounds request bodies, rejects invalid UTF-8 and discards aborted requests", async () => {
  expect((await send("x".repeat(65537))).status).toBe(413);
  const sendRaw = (body: Buffer) =>
    new Promise<number>((resolve, reject) => {
      const req = request(
        mcp.url.replace("/control/v1", "/mcp"),
        {
          method: "POST",
          headers: { Authorization: `Bearer ${mcp.token}`, "Content-Type": "application/json" },
        },
        (res) => {
          res.resume();
          res.on("end", () => {
            resolve(res.statusCode ?? 0);
          });
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  expect(await sendRaw(Buffer.from([0xff]))).toBe(400);
  await new Promise<void>((resolve) => {
    const req = request(mcp.url.replace("/control/v1", "/mcp"), {
      method: "POST",
      headers: { Authorization: `Bearer ${mcp.token}`, "Content-Type": "application/json" },
    });
    req.on("error", () => {
      resolve();
    });
    req.on("socket", (socket) => {
      socket.on("connect", () => {
        req.write("{");
        req.destroy();
      });
    });
  });
});

it("reserves at most four bodies before reading them and releases aborted uploads", async () => {
  await init();
  const reserved = vi.spyOn(limits, "reserveRequest");
  const uploads = Array.from({ length: 4 }, () => {
    const req = request(mcp.url.replace("/control/v1", "/mcp"), {
      method: "POST",
      headers: { Authorization: `Bearer ${mcp.token}`, "Content-Type": "application/json" },
    });
    req.on("error", () => {});
    req.write("{");
    return req;
  });
  try {
    await vi.waitFor(() => {
      expect(reserved).toHaveBeenCalledTimes(4);
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      const refused = await send({ jsonrpc: "2.0", id: 10, method: "ping" });
      expect(refused.status).toBe(429);
      expect(await refused.json()).toEqual({ error: "capacity" });
    }
    expect((await send({}, { Authorization: "Bearer wrong" })).status).toBe(401);
    const first = uploads[0];
    if (!first) throw Error("Missing upload");
    first.destroy();
    await vi.waitFor(async () => {
      expect((await send({ jsonrpc: "2.0", id: 11, method: "ping" })).status).toBe(200);
    });
  } finally {
    for (const req of uploads) req.destroy();
  }
});

it.each(["headers", "body"])(
  "cuts off a continuously trickling %s at the transport deadline",
  async (phase) => {
    await init();
    const url = new URL(mcp.url);
    const socket = connect(Number(url.port), url.hostname);
    let chunks = "";
    let trickle: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const response = new Promise<string>((resolve, reject) => {
      deadline = setTimeout(() => {
        reject(Error("Transport deadline did not close the socket"));
      }, 8000);
      socket.on("data", (data: Buffer) => {
        chunks += data.toString("utf8");
      });
      socket.once("error", reject);
      socket.once("close", () => {
        resolve(chunks);
      });
      socket.once("connect", () => {
        const headers = `POST /mcp HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${mcp.token}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n`;
        socket.write(headers + (phase === "headers" ? "X-Trickle: " : "\r\n1\r\n{\r\n"));
        trickle = setInterval(() => {
          socket.write(phase === "headers" ? " " : "1\r\n \r\n");
        }, 250);
      });
    });
    try {
      expect(await response).toMatch(/^HTTP\/1\.1 408 Request Timeout/u);
      expect((await send({ jsonrpc: "2.0", id: 12, method: "ping" })).status).toBe(200);
    } finally {
      clearInterval(trickle);
      clearTimeout(deadline);
      socket.destroy();
    }
  },
  10000,
);
