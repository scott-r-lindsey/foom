import { controlInstructions } from "../../shared/control-guidance";
import { ManualSectionError } from "./manual";
import { mcpTools } from "../../shared/control-tools";
import { agentProviders } from "../agents/providers/registry";
import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { ControlService } from "./service";
import type { Principal } from "./types";
import { ControlError, exact, object } from "../../shared/control-validation";
import { MCP_ID_LIMIT, mcpToolResponse } from "../../node-common/mcp-response";

import {
  type MCP_ERROR_FIELDS,
  MCP_VERSIONS as versions,
  negotiateMcpVersion,
} from "../../shared/mcp-protocol";
/** Only fixed schema paths cross the HTTP diagnostic boundary; never payload values. */
export class McpValidationError extends ControlError {
  constructor(readonly field: (typeof MCP_ERROR_FIELDS)[number]) {
    super("invalid_request");
  }
}
function record(value: unknown, field: (typeof MCP_ERROR_FIELDS)[number]): Record<string, unknown> {
  try {
    return object(value);
  } catch {
    throw new McpValidationError(field);
  }
}
function requireField(valid: boolean, field: (typeof MCP_ERROR_FIELDS)[number]): void {
  if (!valid) throw new McpValidationError(field);
}
const REFUSED =
  "forbidden: you are not this repository's Foom orchestrator. Only the human can grant that role; call whoami to check.";

/**
 * Protocol state is bound to the grant generation, never a replacement grant. It survives
 * the human changing that grant's role.
 */
export class ControlMcp {
  private readonly sessions = new Map<string, { id: string; version: string; ready: boolean }>();
  constructor(private readonly service: ControlService) {}

  transport(actor: Principal, headers: IncomingHttpHeaders, method: string): void {
    this.service.assertActive(actor);
    const version = headers["mcp-protocol-version"];
    if (version !== undefined && (typeof version !== "string" || !versions.includes(version)))
      throw new McpValidationError("mcp-protocol-version");
    const id = headers["mcp-session-id"];
    if (id !== undefined || method !== "POST") {
      const session = this.sessions.get(actor.generation);
      if (!session || session.id !== id) throw new ControlError("not_found");
      if (version !== undefined && version !== session.version)
        throw new McpValidationError("mcp-protocol-version");
      if (method === "DELETE") this.sessions.delete(actor.generation);
    }
  }

  async dispatch(
    actor: Principal,
    headers: IncomingHttpHeaders,
    input: unknown,
  ): Promise<{ status: number; body?: unknown; sessionId?: string }> {
    this.transport(actor, headers, "POST");
    // MCP schemas permit extension properties. Only selected protocol fields are
    // consumed here; tool arguments still pass the service's exact validators.
    const request = record(input, "request");
    const id = request["id"];
    requireField(request["jsonrpc"] === "2.0", "jsonrpc");
    requireField(typeof request["method"] === "string", "method");
    requireField(
      id === undefined ||
        (typeof id === "string" && id.length <= MCP_ID_LIMIT) ||
        (typeof id === "number" && Number.isSafeInteger(id)),
      "id",
    );
    const params = record(request["params"] === undefined ? {} : request["params"], "params");
    if (params["_meta"] !== undefined) {
      const meta = record(params["_meta"], "params._meta");
      const progress = meta["progressToken"];
      requireField(
        id === undefined ||
          progress === undefined ||
          typeof progress === "string" ||
          (typeof progress === "number" && Number.isFinite(progress)),
        "params._meta.progressToken",
      );
    }
    const result = (value: unknown) => ({
      status: 200,
      body: { jsonrpc: "2.0", id, result: value },
    });
    // Modern stdio clients probe before the legacy initialize handshake. Return
    // a protocol error so they can fall back, rather than terminating the bridge.
    // Authentication has already run; metadata never creates a session or grant.
    if (request["method"] === "server/discover" && id !== undefined) {
      return {
        status: 200,
        body: { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } },
      };
    }
    if (request["method"] === "initialize") {
      requireField(id !== undefined, "id");
      requireField(headers["mcp-session-id"] === undefined, "mcp-session-id");
      const requestedVersion = params["protocolVersion"];
      if (typeof requestedVersion !== "string")
        throw new McpValidationError("params.protocolVersion");
      record(params["capabilities"], "params.capabilities");
      const client = record(params["clientInfo"], "params.clientInfo");
      requireField(typeof client["name"] === "string", "params.clientInfo.name");
      requireField(typeof client["version"] === "string", "params.clientInfo.version");
      // Optional implementation metadata and client capabilities are unused. In
      // particular, never fetch clientInfo icons/URLs or treat capabilities as grants.
      for (const generation of this.sessions.keys()) {
        if (!this.service.live(generation)) this.sessions.delete(generation);
      }
      const session = {
        id: randomUUID(),
        version: negotiateMcpVersion(requestedVersion),
        ready: false,
      };
      this.sessions.set(actor.generation, session);
      return {
        ...result({
          protocolVersion: session.version,
          capabilities: { tools: {} },
          serverInfo: { name: "foom", version: "1.0.0" },
          instructions: controlInstructions(actor),
        }),
        sessionId: session.id,
      };
    }
    const session = this.sessions.get(actor.generation);
    if (!session || headers["mcp-session-id"] !== session.id)
      throw new McpValidationError("mcp-session-id");
    if (id === undefined) {
      if (request["method"] === "notifications/initialized") {
        session.ready = true;
      }
      return { status: 202 };
    }
    if (request["method"] === "ping") {
      return result({});
    }
    if (!session.ready) throw new ControlError("invalid_request");
    const registry = mcpTools(
      this.service.childLimit(),
      agentProviders().map((provider) => provider.id),
      actor.role === "dispatcher",
    );
    const available = this.service
      .listed(actor)
      .flatMap((name) => registry.filter((tool) => tool.name === name));
    if (request["method"] === "tools/list") {
      requireField(
        params["cursor"] === undefined || typeof params["cursor"] === "string",
        "params.cursor",
      );
      return result({ tools: available });
    }
    if (request["method"] === "tools/call") {
      requireField(typeof params["name"] === "string", "params.name");
      if (params["arguments"] !== undefined) record(params["arguments"], "params.arguments");
      // Foom does not advertise task-augmented execution. Never silently run a
      // requested background task synchronously (which could duplicate effects).
      requireField(params["task"] === undefined, "params.task");
      try {
        if (params["name"] !== "handoff" && !available.some((tool) => tool.name === params["name"]))
          throw new ControlError("forbidden");
        if (params["name"] === "wait_for") {
          const fields = ["ids", "after", "timeoutMs"];
          if (actor.role !== "dispatcher") fields.push("boardAfter");
          exact(object(params["arguments"] ?? {}), fields);
        }
        const value = await this.service.call(actor, {
          version: 1,
          instanceId: this.service.instanceId,
          method: params["name"],
          params: params["arguments"] ?? {},
        });
        return { status: 200, body: mcpToolResponse(id, value) };
      } catch (error) {
        if (!(error instanceof ControlError) || error.code === "unauthorized") throw error;
        const name = params["name"];
        const refused =
          error.code === "forbidden" &&
          available.some((tool) => tool.name === name) &&
          !this.service.capabilities(actor).some((granted) => granted === name);
        return result({
          content: [
            {
              type: "text",
              text:
                error instanceof ManualSectionError
                  ? `invalid_request: valid section ids: ${error.validIds.join(", ")}`
                  : refused
                    ? REFUSED
                    : error.code,
            },
          ],
          isError: true,
        });
      }
    }
    return {
      status: 200,
      body: { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } },
    };
  }
}
