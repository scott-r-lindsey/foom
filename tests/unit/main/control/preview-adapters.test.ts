import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ControlHttp } from "../../../../src/main/control/http";
import { ControlService } from "../../../../src/main/control/service";
import { Operations } from "../../../../src/main/control/operations";
import { PREVIEW_METHODS, PreviewBroker } from "../../../../src/main/control/previews";
import type { Principal, Role } from "../../../../src/main/control/types";
import { ControlError, identifier, object } from "../../../../src/node-common/control-validation";
let root: string;
let service: ControlService;
let http: ControlHttp;
let records: Set<string>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "foom-preview-adapters-"));
  await writeFile(join(root, "plan.md"), "# plan");
  records = new Set();
  service = new ControlService(
    new Operations(
      () => Promise.resolve(),
      () => {},
    ),
    undefined,
    undefined,
    undefined,
    undefined,
    new PreviewBroker(
      {
        open: (_actor, preview) => {
          records.add(preview.previewId);
          return Promise.resolve("sidebar" as const);
        },
        close: (id) => {
          records.delete(id);
          return Promise.resolve();
        },
        visible: () => false,
        has: (id) => records.has(id),
      },
      () => Promise.resolve(),
      (actor) => {
        service.assertActive(actor);
      },
    ),
  );
  http = await ControlHttp.listen(service);
});
afterEach(async () => {
  await http.close();
  await rm(root, { recursive: true, force: true });
});
function launch(role: Role = "agent") {
  const grant = service.prepare(root, root, role);
  grant.bind(role);
  const token = grant.env["FOOM_CONTROL_TOKEN"] ?? "";
  return { grant, token, actor: service.authenticate(token) };
}
const envelope = (method: string, params: unknown = {}) => ({
  version: 1,
  instanceId: service.instanceId,
  method,
  params,
});
async function consoleCall(token: string, method: string, params: unknown = {}) {
  const result = await fetch(http.endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(envelope(method, params)),
  });
  return { status: result.status, body: (await result.json()) as unknown };
}
async function mcpClient(token: string) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  const endpoint = http.endpoint.replace("/control/v1", "/mcp");
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "fixture", version: "1" },
      },
    }),
  });
  expect(JSON.stringify(await response.json())).toContain("call open_preview");
  const session = response.headers.get("mcp-session-id") ?? "";
  const send = async (method: string, params: unknown = {}, notification = false) => {
    const result = await fetch(endpoint, {
      method: "POST",
      headers: { ...headers, "Mcp-Session-Id": session },
      body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: 2 }), method, params }),
    });
    return notification ? undefined : ((await result.json()) as unknown);
  };
  await send("notifications/initialized", {}, true);
  return {
    send,
    call: (name: string, args: unknown = {}) => send("tools/call", { name, arguments: args }),
  };
}
it("lists preview tools for both agent roles across swaps, never CLI, with accurate annotations", async () => {
  for (const role of ["agent", "orchestrator", "cli"] as const) {
    const { actor, token } = launch(role);
    const client = await mcpClient(token);
    const listed = JSON.stringify(await client.send("tools/list"));
    for (const method of PREVIEW_METHODS) {
      expect(service.capabilities(actor).includes(method)).toBe(role !== "cli");
      expect(listed.includes(`"name":"${method}"`)).toBe(role !== "cli");
    }
    if (role !== "cli") {
      const tools = object(object(await client.send("tools/list"))["result"])["tools"];
      if (!Array.isArray(tools)) throw new Error("Missing tool list");
      for (const name of PREVIEW_METHODS) {
        const tool: unknown = tools.find((value: unknown) => object(value)["name"] === name);
        expect(tool).toMatchObject({
          name,
          annotations: {
            readOnlyHint: name === "list_previews",
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
          inputSchema: { additionalProperties: false },
        });
      }
      service.setRole(actor.terminalId, role === "agent" ? "orchestrator" : "agent");
      expect(await client.call("list_previews")).toMatchObject({
        result: { isError: false, structuredContent: { previews: [] } },
      });
    } else
      for (const method of PREVIEW_METHODS) {
        expect(await consoleCall(token, method)).toMatchObject({
          status: 403,
          body: { error: "forbidden" },
        });
        expect(await client.call(method)).toMatchObject({
          result: { isError: true, content: [{ text: "forbidden" }] },
        });
      }
  }
});
it("returns canonical reuse, ownership and fixed errors through both adapters", async () => {
  const { token } = launch();
  const client = await mcpClient(token);
  const opened = await consoleCall(token, "open_preview", { path: "plan.md" });
  expect(opened.status).toBe(200);
  const previewId = identifier(object(object(opened.body)["result"])["previewId"]);
  expect(await client.call("open_preview", { path: join(root, "plan.md") })).toMatchObject({
    result: {
      structuredContent: { previewId, reused: true, placement: "sidebar" },
      isError: false,
    },
  });
  const foreign = launch("orchestrator");
  expect(await consoleCall(foreign.token, "close_preview", { previewId })).toMatchObject({
    status: 404,
    body: { error: "not_found" },
  });
  for (const [method, args, code, status] of [
    ["open_preview", { path: "missing.md" }, "not_found", 404],
    ["open_preview", { path: "../escape.md" }, "forbidden", 403],
    ["open_preview", { path: "plan.md", worktree: "/" }, "invalid_request", 400],
    ["list_previews", { extra: true }, "invalid_request", 400],
    ["close_preview", { previewId: "unknown" }, "not_found", 404],
  ] as const) {
    expect(await consoleCall(token, method, args)).toMatchObject({ status, body: { error: code } });
    expect(await client.call(method, args)).toMatchObject({
      result: { isError: true, content: [{ text: code }] },
    });
  }
  expect(await client.call("close_preview", { previewId })).toMatchObject({
    result: { structuredContent: { closed: true } },
  });
  expect(await consoleCall(token, "open_preview", { path: "plan.md" })).toMatchObject({
    status: 400,
    body: { error: "capacity" },
  });
  expect(await client.call("open_preview", { path: "plan.md" })).toMatchObject({
    result: { isError: true, content: [{ text: "capacity" }] },
  });
  const broker = service.previews;
  if (!broker) throw new Error("Missing broker");
  const failing = vi.spyOn(broker, "call").mockRejectedValue(new ControlError("unavailable"));
  expect(await consoleCall(token, "list_previews")).toMatchObject({
    status: 400,
    body: { error: "unavailable" },
  });
  expect(await client.call("list_previews")).toMatchObject({
    result: { isError: true, content: [{ text: "unavailable" }] },
  });
  failing.mockRestore();
});
it("rechecks envelope, availability and revocation, transferring previews on exit and takeover", async () => {
  const { actor, grant } = launch();
  const request = envelope("open_preview", { path: "plan.md" });
  await expect(service.call(actor, { ...request, extra: true })).rejects.toMatchObject({
    code: "invalid_request",
  });
  await expect(service.call(actor, { ...request, version: 2 })).rejects.toMatchObject({
    code: "invalid_request",
  });
  const opened = await service.call(actor, request);
  const previewId = identifier(object(opened)["previewId"]);
  service.takeOver(actor.terminalId);
  expect(await service.call(actor, envelope("list_previews"))).toEqual({ previews: [] });
  expect(records.has(previewId)).toBe(true);
  await service.call(actor, request);
  grant.dispose();
  expect(records.size).toBe(2);
  await expect(service.call(actor, envelope("list_previews"))).rejects.toMatchObject({
    code: "unauthorized",
  });
  const bare = new ControlService(
    new Operations(
      () => Promise.resolve(),
      () => {},
    ),
  );
  const launchBare = bare.prepare(root, root);
  launchBare.bind("bare");
  const principal: Principal = bare.authenticate(launchBare.env["FOOM_CONTROL_TOKEN"] ?? "");
  await expect(
    bare.call(principal, { ...envelope("list_previews"), instanceId: bare.instanceId }),
  ).rejects.toMatchObject({ code: "unavailable" });
  bare.close();
});
