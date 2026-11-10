import { StringDecoder } from "node:string_decoder";
import { request } from "node:http";
import { endpoint } from "./client";
import { object } from "../shared/control-validation";
import { MCP_RESPONSE_LIMIT } from "../node-common/mcp-response";
import { MCP_ERROR_FIELDS, MCP_HTTP_ERRORS } from "../shared/mcp-protocol";
import type { ConsoleIo } from "./types";

class McpTransportError extends Error {}
function httpFailure(status: number | undefined, response: string): McpTransportError {
  let code = "http_error";
  let field = "";
  try {
    const body = object(JSON.parse(response));
    if (MCP_HTTP_ERRORS.some((known) => known === body["error"])) code = String(body["error"]);
    if (MCP_ERROR_FIELDS.some((known) => known === body["field"]))
      field = ` field=${String(body["field"])}`;
  } catch {
    // Untrusted response text is never included in diagnostics.
  }
  return new McpTransportError(`${String(status ?? "no_http_response")} ${code}${field}`);
}

/** No discovery or pairing: this transport is available only to a launching session. */
export async function mcpCommand(
  args: readonly string[],
  io: ConsoleIo,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  if (args.length !== 1) return 2;
  const token = env["FOOM_CONTROL_TOKEN"];
  const session = env["FOOM_SESSION"];
  let url: URL;
  try {
    if (
      !token ||
      !/^[a-f0-9]{64}$/u.test(token) ||
      !session ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(session)
    )
      return 0;
    url = new URL(endpoint(env["FOOM_CONTROL_URL"] ?? ""));
    url.pathname = "/mcp";
  } catch {
    return 0;
  }
  let sessionId: string | undefined;
  let protocol: string | undefined;
  let method = "request";
  const send = (body: unknown): Promise<void> =>
    new Promise((resolve, reject) => {
      let status: number | undefined;
      const req = request(
        url,
        {
          method: "POST",
          agent: false,
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
            ...(protocol ? { "mcp-protocol-version": protocol } : {}),
          },
        },
        (res) => {
          status = res.statusCode;
          let bytes = 0;
          let response = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            bytes += Buffer.byteLength(chunk);
            if (bytes > MCP_RESPONSE_LIMIT) {
              reject(
                new McpTransportError(
                  `${String(res.statusCode ?? "no_http_response")} response_too_large`,
                ),
              );
              req.destroy();
              return;
            }
            response += chunk;
          });
          res.on("error", () => {
            reject(
              new McpTransportError(
                `${String(res.statusCode ?? "no_http_response")} response_error`,
              ),
            );
          });
          res.on("end", () => {
            try {
              if (res.statusCode === 202 && response.length === 0) {
                resolve();
                return;
              }
              if (res.statusCode !== 200) throw httpFailure(res.statusCode, response);
              const value: unknown = JSON.parse(response);
              const id = res.headers["mcp-session-id"];
              if (id !== undefined) {
                if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/u.test(id))
                  throw new McpTransportError("200 invalid_session_header");
                sessionId = id;
                const version = object(object(value)["result"])["protocolVersion"];
                if (typeof version !== "string" || !/^[\x21-\x7e]{1,200}$/u.test(version))
                  throw new McpTransportError("200 invalid_protocol_version");
                protocol = version;
              }
              io.out(`${JSON.stringify(value)}\n`);
              resolve();
            } catch (error) {
              reject(
                error instanceof McpTransportError
                  ? error
                  : new McpTransportError("200 invalid_response"),
              );
            }
          });
        },
      );
      const timer = setTimeout(() => {
        reject(new McpTransportError(`${String(status ?? "no_http_response")} timeout`));
        req.destroy();
      }, 65000);
      req.on("close", () => {
        clearTimeout(timer);
      });
      req.on("error", () => {
        reject(new McpTransportError(`${String(status ?? "no_http_response")} network_error`));
      });
      req.end(JSON.stringify(body));
    });
  const invalidInput = (code: string): number => {
    io.error(`Foom MCP transport failed: no_http_response ${code} (${method}).\n`);
    return 2;
  };
  try {
    let buffer = "";
    const decoder = new StringDecoder("utf8");
    for await (const chunk of io.input) {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      let end = buffer.indexOf("\n");
      while (end >= 0) {
        const line = buffer.slice(0, end);
        if (Buffer.byteLength(line) > 65536) return invalidInput("request_too_large");
        buffer = buffer.slice(end + 1);
        const value: unknown = JSON.parse(line);
        const name = object(value)["method"];
        method = [
          "initialize",
          "notifications/initialized",
          "ping",
          "tools/list",
          "tools/call",
        ].some((known) => known === name)
          ? String(name)
          : "request";
        await send(value);
        end = buffer.indexOf("\n");
      }
      if (Buffer.byteLength(buffer) > 65536) return invalidInput("request_too_large");
    }
    return buffer.length || decoder.end().length ? invalidInput("incomplete_input") : 0;
  } catch (error) {
    const reason =
      error instanceof McpTransportError ? error.message : "no_http_response invalid_input";
    io.error(`Foom MCP transport failed: ${reason} (${method}).\n`);
    return 4;
  }
}
