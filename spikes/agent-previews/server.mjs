// Patched local build of Foom's real control plane (#222 spike, not Foom code).
// Bundles src/main/control unchanged, then adds three preview tools by patching
// prototypes in memory. Both adapters (MCP at /mcp, CLI at /control/v1) reach the
// broker through ControlService.call, the same entry point production uses.
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Board, BrokerError, PreviewBroker } = require("./broker.cjs");
const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");

// The control service keeps a fixed error vocabulary; broker detail maps onto it.
const CODES = { unsupported_type: "invalid_request", too_large: "invalid_request", rate_limited: "capacity" };

export const PREVIEW_METHODS = ["open_preview", "list_previews", "close_preview"];

/** Minimal descriptions: the experiment checks whether agents find the tool from these alone. */
export function previewTools(readOnly) {
  const annotations = {
    readOnlyHint: readOnly,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  return [
    {
      name: "open_preview",
      description:
        "Show the user a rendered preview of a Markdown or HTML file in your worktree, in a Foom tile beside the terminals. Use it when you've written something the user should look at, like a mockup or a doc. Path is relative to your worktree. Opening the same file again returns the existing preview. Never takes focus.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", maxLength: 1024 } },
        required: ["path"],
        additionalProperties: false,
      },
      annotations,
    },
    {
      name: "list_previews",
      description: "Previews you opened that are still open.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false, required: [] },
      annotations: { ...annotations, readOnlyHint: true },
    },
    {
      name: "close_preview",
      description: "Close a preview you opened.",
      inputSchema: {
        type: "object",
        properties: { previewId: { type: "string", maxLength: 200 } },
        required: ["previewId"],
        additionalProperties: false,
      },
      annotations,
    },
  ];
}

export async function startControl({ readOnly = true, board = new Board({ landing: "t2", empty: ["t2"] }) } = {}) {
  const scratch = await mkdtemp(join(tmpdir(), "foom-agent-preview-control-"));
  const bundle = join(scratch, "control.mjs");
  await build({
    stdin: {
      contents:
        'export { ControlMcp } from "./src/main/control/mcp"; export { ControlService } from "./src/main/control/service"; export { ControlHttp } from "./src/main/control/http"; export { Operations } from "./src/main/control/operations"; export { ControlError } from "./src/main/control/validation"; export { prepareMcpLaunch } from "./src/main/agents/mcp-launch";',
      resolveDir: repo,
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: bundle,
    logLevel: "silent",
  });
  const control = await import(bundle);
  const { ControlMcp, ControlService, ControlHttp, Operations, ControlError } = control;
  const broker = new PreviewBroker({ board });
  const agents = new Map(); // terminal id -> { agent, name }; main knows this at launch
  const protocol = [];

  const capabilities = ControlService.prototype.capabilities;
  ControlService.prototype.capabilities = function (actor) {
    const base = capabilities.call(this, actor);
    return actor.role === "cli" ? base : [...base, ...PREVIEW_METHODS];
  };
  const call = ControlService.prototype.call;
  ControlService.prototype.call = async function (actor, input) {
    const method = input?.method;
    if (!PREVIEW_METHODS.includes(method)) return call.call(this, actor, input);
    this.assertActive(actor);
    if (input.version !== 1 || input.instanceId !== this.instanceId)
      throw new ControlError("invalid_request");
    if (!this.capabilities(actor).includes(method)) throw new ControlError("forbidden");
    const who = { ...actor, ...(agents.get(actor.terminalId) ?? {}) };
    try {
      const params = input.params ?? {};
      if (method === "open_preview") return broker.open(who, params);
      if (method === "list_previews") return broker.list(who, params);
      return broker.close(who, params);
    } catch (error) {
      // Broker codes map onto the control service's fixed error vocabulary.
      if (error instanceof BrokerError) throw new ControlError(CODES[error.code] ?? error.code);
      throw error;
    }
  };
  const dispatch = ControlMcp.prototype.dispatch;
  ControlMcp.prototype.dispatch = async function (actor, headers, input) {
    const name = input?.params?.name;
    protocol.push({
      at: Date.now(),
      actor: actor.terminalId,
      method: input?.method,
      ...(input?.method === "tools/call" ? { tool: name, arguments: input.params.arguments } : {}),
    });
    if (input?.method === "tools/call" && PREVIEW_METHODS.includes(name)) {
      // Same session checks as the real adapter, then the same result envelope.
      this.transport(actor, headers, "POST");
      const session = this.sessions.get(actor);
      if (!session?.ready || headers["mcp-session-id"] !== session.id)
        throw new ControlError("invalid_request");
      try {
        const value = await this.service.call(actor, {
          version: 1,
          instanceId: this.service.instanceId,
          method: name,
          params: input.params.arguments ?? {},
        });
        protocol.at(-1).result = value;
        return {
          status: 200,
          body: {
            jsonrpc: "2.0",
            id: input.id,
            result: { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: false },
          },
        };
      } catch (error) {
        if (!(error instanceof ControlError) || error.code === "unauthorized") throw error;
        protocol.at(-1).error = error.code;
        return {
          status: 200,
          body: { jsonrpc: "2.0", id: input.id, result: { content: [{ type: "text", text: error.code }], isError: true } },
        };
      }
    }
    const result = await dispatch.call(this, actor, headers, input);
    if (input?.method === "tools/list" && result.body?.result?.tools) {
      const allowed = this.service.capabilities(actor);
      result.body.result.tools.push(...previewTools(readOnly).filter((t) => allowed.includes(t.name)));
    }
    return result;
  };

  const service = new ControlService(new Operations(async () => {}, () => {}));
  const http = await ControlHttp.listen(service);
  return {
    control,
    broker,
    protocol,
    endpoint: http.endpoint,
    service,
    /** Grant like main does at launch: role, worktree and agent come from main, never the caller. */
    grant(worktree, terminalId, agent = { agent: "claude", name: "Claude Code" }, role = "agent") {
      const launch = service.prepare(worktree, worktree, role);
      launch.bind(terminalId, true);
      agents.set(terminalId, agent);
      return launch;
    },
    async close() {
      service.close();
      await http.close();
      ControlService.prototype.capabilities = capabilities;
      ControlService.prototype.call = call;
      ControlMcp.prototype.dispatch = dispatch;
      await rm(scratch, { recursive: true, force: true });
    },
  };
}
