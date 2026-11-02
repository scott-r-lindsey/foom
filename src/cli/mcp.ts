import { StringDecoder } from "node:string_decoder";
import { request } from "node:http";
import { endpoint } from "./client";
import { object } from "../shared/control-validation";
import { MCP_RESPONSE_LIMIT } from "../node-common/mcp-response";
import type { ConsoleIo } from "./types";

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
  const send = (body: unknown): Promise<void> =>
    new Promise((resolve, reject) => {
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
          let bytes = 0;
          let response = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            bytes += Buffer.byteLength(chunk);
            if (bytes > MCP_RESPONSE_LIMIT) {
              reject(new Error("MCP transport failed"));
              req.destroy();
              return;
            }
            response += chunk;
          });
          res.on("error", reject);
          res.on("end", () => {
            try {
              if (res.statusCode === 202 && response.length === 0) {
                resolve();
                return;
              }
              if (res.statusCode !== 200) throw new Error("MCP transport failed");
              const value: unknown = JSON.parse(response);
              const id = res.headers["mcp-session-id"];
              if (id !== undefined) {
                if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/u.test(id))
                  throw new Error("MCP transport failed");
                sessionId = id;
                const version = object(object(value)["result"])["protocolVersion"];
                if (typeof version !== "string" || !/^[\x21-\x7e]{1,200}$/u.test(version))
                  throw new Error("MCP transport failed");
                protocol = version;
              }
              io.out(`${JSON.stringify(value)}\n`);
              resolve();
            } catch {
              reject(new Error("MCP transport failed"));
            }
          });
        },
      );
      const timer = setTimeout(() => {
        reject(new Error("MCP transport failed"));
        req.destroy();
      }, 65000);
      req.on("close", () => {
        clearTimeout(timer);
      });
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  try {
    let buffer = "";
    const decoder = new StringDecoder("utf8");
    for await (const chunk of io.input) {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      let end = buffer.indexOf("\n");
      while (end >= 0) {
        const line = buffer.slice(0, end);
        if (Buffer.byteLength(line) > 65536) return 2;
        buffer = buffer.slice(end + 1);
        const value: unknown = JSON.parse(line);
        await send(value);
        end = buffer.indexOf("\n");
      }
      if (Buffer.byteLength(buffer) > 65536) return 2;
    }
    return buffer.length || decoder.end().length ? 2 : 0;
  } catch {
    io.error("Foom MCP transport failed.\n");
    return 4;
  }
}
