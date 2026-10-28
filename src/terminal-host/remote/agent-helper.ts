import { mcpTools } from "../../shared/control-tools";
import { mkdirSync, readFileSync, rmdirSync, writeFileSync, constants } from "node:fs";
import { open } from "node:fs/promises";
import { endpointRequest } from "./agent-endpoint";
import {
  keys,
  record,
  remotePublicResult,
  REMOTE_PHASE_2_REASON,
} from "../../shared/remote-agent-protocol";

export async function boundedInput(
  input: NodeJS.ReadableStream = process.stdin,
  limit = 65536,
): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    if (!(typeof chunk === "string" || Buffer.isBuffer(chunk))) throw new Error("Invalid input");
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (bytes > limit) throw new Error("Input too large");
    chunks.push(data);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}
export async function observeRemote(
  args: readonly string[],
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  env = process.env,
): Promise<void> {
  const [channel, transport, response, order, ...rest] = args;
  if (response === "empty-json-first") output.write("{}\n");
  try {
    if (
      !channel ||
      !/^[A-Za-z0-9_-]{1,64}$/u.test(channel) ||
      !["stdin", "argv-last"].includes(transport ?? "") ||
      !["silent", "empty-json-first"].includes(response ?? "") ||
      !["ordered", "unordered"].includes(order ?? "")
    )
      return;
    let sequence: string | undefined;
    if (order === "ordered") {
      const path = env[`FOOM_ORDER_${channel.replaceAll("-", "_")}`] ?? env["FOOM_HOOK_ORDER"];
      if (!path) return;
      const lock = `${path}.lock`;
      mkdirSync(lock, { mode: 0o700 });
      try {
        const previous = readFileSync(path, "utf8");
        if (!/^(0|[1-9][0-9]{0,9})$/u.test(previous) || Number(previous) >= 2147483647) return;
        sequence = String(Number(previous) + 1);
        writeFileSync(path, sequence, { mode: 0o600 });
      } finally {
        rmdirSync(lock);
      }
    }
    const raw = transport === "stdin" ? await boundedInput(input) : (rest.at(-1) ?? "");
    if (Buffer.byteLength(raw) > 65536) return;
    const payload: unknown = JSON.parse(raw);
    await endpointRequest(
      "/hook",
      {
        channel,
        payload,
        event: transport === "stdin" ? (rest.at(-1) ?? "") : "",
        ...(sequence ? { sequence } : {}),
      },
      env,
    );
  } catch {
    /* Observe only: transport never changes provider approval or exit status. */
  }
}
export async function remoteCli(
  args: readonly string[],
  input: NodeJS.ReadableStream = process.stdin,
): Promise<unknown> {
  if (
    args[0] === "--help" ||
    args[0] === "help" ||
    (args.length === 2 &&
      args[1] === "--help" &&
      ["whoami", "manual", "handoff"].includes(args[0] ?? ""))
  )
    return {
      usage: [
        "foom whoami --json",
        "foom manual [--section ID] [--page N] --json",
        "foom handoff --status done|blocked|failed --summary-file FILE|- [--link HTTPS_URL] --idempotency-key KEY [--review JSON] --json",
      ],
      restriction: REMOTE_PHASE_2_REASON,
    };
  const method = args[0]?.replaceAll("-", "_");
  if (method === "whoami" && args.slice(1).every((arg) => arg === "--json")) {
    const result = await endpointRequest("/call", { method, params: {} });
    return result ? remotePublicResult(result) : { error: "unavailable" };
  }
  if (method !== "handoff" && method !== "manual")
    return { error: "phase_2_restricted", reason: REMOTE_PHASE_2_REASON };
  const params: Record<string, unknown> = {};
  const links: string[] = [];
  let summaryFile: string | undefined;
  if (args.length > 30) throw new Error("Invalid remote CLI arguments");
  for (let index = 1; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--json") continue;
    const value = args[++index];
    if (!value) throw new Error("Missing argument");
    if (method === "manual") {
      if (flag === "--section" && params["section"] === undefined) params["section"] = value;
      else if (flag === "--page" && params["page"] === undefined && /^\d+$/u.test(value))
        params["page"] = Number(value);
      else throw new Error("Invalid manual argument");
    } else if (flag === "--summary-file" && summaryFile === undefined) summaryFile = value;
    else if (flag === "--link") {
      links.push(value);
      params["links"] = links;
    } else {
      const key =
        flag === "--status"
          ? "status"
          : flag === "--idempotency-key"
            ? "idempotencyKey"
            : flag === "--review"
              ? "review"
              : undefined;
      if (!key || params[key] !== undefined) throw new Error("Invalid handoff argument");
      params[key] = key === "review" ? (JSON.parse(value) as unknown) : value;
    }
  }
  if (method === "handoff") {
    if (!summaryFile) throw new Error("Missing summary");
    if (summaryFile === "-") params["summary"] = await boundedInput(input, 8192);
    else {
      const file = await open(
        summaryFile,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 8192) throw new Error("Invalid summary file");
        const buffer = Buffer.alloc(8193);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
        if (bytesRead > 8192) throw new Error("Summary too large");
        params["summary"] = new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, bytesRead),
        );
      } finally {
        await file.close();
      }
    }
  }
  const result = await endpointRequest("/call", { method, params });
  return result ? remotePublicResult(result) : { error: "unavailable" };
}
/** MCP protocol ends here. Only typed tool calls cross the SSH relay. */
export async function remoteMcp(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  let buffered = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let initialized = false;
  let ready = false;
  const respond = (value: unknown) => output.write(`${JSON.stringify(value)}\n`);
  const dispatch = async (line: string) => {
    let id: unknown;
    try {
      const value: unknown = JSON.parse(line);
      if (
        !record(value) ||
        !keys(value, ["jsonrpc", "id", "method", "params"]) ||
        value["jsonrpc"] !== "2.0" ||
        typeof value["method"] !== "string" ||
        value["method"].length < 1 ||
        value["method"].length > 64
      )
        throw new Error("Invalid MCP request");
      const candidate = value["id"];
      if (
        candidate !== undefined &&
        !(typeof candidate === "string" && candidate.length <= 200) &&
        !(typeof candidate === "number" && Number.isSafeInteger(candidate))
      )
        throw new Error("Invalid MCP id");
      id = candidate;
      const params = value["params"] ?? {};
      if (!record(params)) throw new Error("Invalid MCP params");
      if (params["_meta"] !== undefined) {
        if (!record(params["_meta"])) throw new Error("Invalid MCP metadata");
        delete params["_meta"];
      }
      if (
        ["tools/list", "ping", "notifications/initialized"].includes(value["method"]) &&
        !keys(params, [])
      )
        throw new Error("Invalid MCP params");
      if (value["method"] === "initialize") {
        if (
          id === undefined ||
          !keys(params, ["protocolVersion", "capabilities", "clientInfo"]) ||
          !["2025-03-26", "2025-06-18", "2025-11-25"].includes(String(params["protocolVersion"])) ||
          !record(params["capabilities"]) ||
          !record(params["clientInfo"]) ||
          typeof params["clientInfo"]["name"] !== "string" ||
          params["clientInfo"]["name"].length > 200 ||
          typeof params["clientInfo"]["version"] !== "string" ||
          params["clientInfo"]["version"].length > 200
        )
          throw new Error("Invalid MCP initialization");
        // Authenticate before announcing a usable attachment.
        const identity = await endpointRequest("/call", { method: "whoami", params: {} });
        if (identity?.type !== "identity") throw new Error("Remote grant unavailable");
        initialized = true;
        ready = false;
        respond({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: params["protocolVersion"],
            capabilities: { tools: {} },
            serverInfo: { name: "foom-remote", version: "1" },
            instructions: REMOTE_PHASE_2_REASON,
          },
        });
      } else if (
        initialized &&
        value["method"] === "notifications/initialized" &&
        id === undefined
      ) {
        const result = await endpointRequest("/call", { method: "mcp_connected", params: {} });
        ready = result?.type === "identity";
      } else if (id === undefined) return;
      else if (initialized && value["method"] === "ping")
        respond({ jsonrpc: "2.0", id, result: {} });
      else if (ready && value["method"] === "tools/list")
        respond({
          jsonrpc: "2.0",
          id,
          result: {
            tools: mcpTools(1, [])
              .filter((tool) => ["whoami", "manual", "handoff"].includes(tool.name))
              .map((tool) =>
                tool.name === "whoami"
                  ? {
                      ...tool,
                      description:
                        "Your opaque remote launch alias and restricted child capabilities.",
                    }
                  : tool,
              ),
          },
        });
      else if (ready && value["method"] === "tools/call") {
        if (
          !keys(params, ["name", "arguments", "_meta"]) ||
          typeof params["name"] !== "string" ||
          params["name"].length > 64 ||
          !record(params["arguments"] ?? {})
        )
          throw new Error("Invalid tool call");
        const result = await endpointRequest("/call", {
          method: params["name"],
          params: params["arguments"] ?? {},
        });
        if (!result) throw new Error("Remote request unavailable");
        const publicResult = remotePublicResult(result);
        respond({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(publicResult) }],
            structuredContent: publicResult,
            isError: result.type === "error",
          },
        });
      } else
        respond({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method unavailable" } });
    } catch {
      if (id !== undefined)
        respond({
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "Invalid or unavailable remote request" },
        });
    }
  };
  for await (const chunk of input) {
    if (!(typeof chunk === "string" || Buffer.isBuffer(chunk)))
      throw new Error("Invalid MCP input");
    buffered += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(buffered) > 65536) throw new Error("MCP input too large");
    let end: number;
    while ((end = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      if (line.length) await dispatch(line);
    }
  }
  if (decoder.decode() || buffered.length) throw new Error("Truncated MCP input");
}
