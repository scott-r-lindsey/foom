import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { boundedHttpServer, reserveRequest } from "./http-limits";
import { bundledManual, ManualSectionError } from "./manual";
import { manualTools } from "../../shared/control-tools";
import { exact, object } from "../../shared/control-validation";

import { MCP_VERSIONS as versions, negotiateMcpVersion } from "../../shared/mcp-protocol";
/** Deliberately independent of ControlService/ControlMcp: no path to repository tools. */
export class ManualMcp {
  readonly token = randomBytes(32).toString("hex");
  private origin = "";
  private session: { id: string; version: string; ready: boolean } | undefined;
  private closed = false;
  private readonly requests = { calls: 0 };

  private readonly server = boundedHttpServer((request, response) => {
    const end = (status: number, body?: unknown, session?: string) => {
      response.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        Connection: "close",
        ...(session ? { "Mcp-Session-Id": session } : {}),
      });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    const authorization = request.headers.authorization ?? "";
    const expected = Buffer.from(`Bearer ${this.token}`);
    const actual = Buffer.from(authorization);
    if (this.closed || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      end(401);
      return;
    }
    if (
      request.socket.remoteAddress !== "127.0.0.1" ||
      request.headers.host !== this.origin.slice(7) ||
      request.headers.origin !== undefined ||
      request.url !== "/mcp"
    ) {
      end(403);
      return;
    }
    let release: () => void;
    try {
      release = reserveRequest(this.requests);
    } catch {
      end(429, { error: "capacity" });
      return;
    }
    response.once("close", release);
    const session = request.headers["mcp-session-id"];
    const version = request.headers["mcp-protocol-version"];
    if (
      (session !== undefined && session !== this.session?.id) ||
      (version !== undefined &&
        (typeof version !== "string" ||
          !versions.includes(version) ||
          (session !== undefined && version !== this.session?.version)))
    ) {
      end(400);
      return;
    }
    if (request.method === "DELETE" && this.session && session === this.session.id) {
      this.session = undefined;
      end(204);
      return;
    }
    if (request.method !== "POST") {
      end(405);
      return;
    }
    if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
      end(415);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("error", () => {
      chunks.length = 0;
      release();
    });
    request.on("data", (chunk: Buffer) => {
      if (response.writableEnded) return;
      size += chunk.length;
      if (size > 65536) {
        chunks.length = 0;
        end(413);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (response.writableEnded) return;
      if (this.closed) {
        end(401);
        return;
      }
      try {
        const value = object(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))),
        );
        exact(value, ["jsonrpc", "id", "method", "params"]);
        const id = value["id"];
        if (
          value["jsonrpc"] !== "2.0" ||
          typeof value["method"] !== "string" ||
          (id !== undefined &&
            !(typeof id === "string" && id.length <= 200) &&
            !(typeof id === "number" && Number.isSafeInteger(id)))
        )
          throw Error();
        const params = object(value["params"] ?? {});
        const result = (result: unknown, session?: string) => {
          end(200, { jsonrpc: "2.0", id, result }, session);
        };
        if (value["method"] === "initialize") {
          exact(params, ["protocolVersion", "capabilities", "clientInfo"]);
          const protocol = params["protocolVersion"];
          const client = object(params["clientInfo"]);
          object(params["capabilities"]);
          if (
            id === undefined ||
            session !== undefined ||
            typeof protocol !== "string" ||
            typeof client["name"] !== "string" ||
            typeof client["version"] !== "string"
          )
            throw Error();
          this.session = { id: randomUUID(), version: negotiateMcpVersion(protocol), ready: false };

          result(
            {
              protocolVersion: this.session.version,
              capabilities: { tools: {} },
              serverInfo: { name: "foom-manual", version: "1.0.0" },
              instructions: "For questions about using Foom, call manual.",
            },
            this.session.id,
          );
          return;
        }
        if (!this.session || session !== this.session.id) throw Error();
        if (value["method"] === "notifications/initialized" && id === undefined) {
          exact(params, []);
          this.session.ready = true;
          end(202);
          return;
        }
        if (id === undefined || !this.session.ready) throw Error();
        if (params["_meta"] !== undefined) {
          object(params["_meta"]);
          delete params["_meta"];
        }
        if (value["method"] === "ping") {
          exact(params, []);
          result({});
          return;
        }
        if (value["method"] === "tools/list") {
          exact(params, []);

          result({
            tools: manualTools,
          });
          return;
        }
        if (value["method"] === "tools/call") {
          exact(params, ["name", "arguments"]);
          if (params["name"] !== "manual") {
            end(200, { jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown tool" } });
            return;
          }
          try {
            const value = bundledManual().read(params["arguments"] ?? {});
            result({
              content: [{ type: "text", text: JSON.stringify(value) }],
              structuredContent: value,
              isError: false,
            });
          } catch (error) {
            result({
              isError: true,
              content: [
                {
                  type: "text",
                  text:
                    error instanceof ManualSectionError
                      ? `invalid_request: valid section ids: ${error.validIds.join(", ")}`
                      : "invalid_request",
                },
              ],
            });
          }
          return;
        }
        end(200, { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
      } catch {
        end(400);
      }
    });
  });
  private constructor() {}

  static async listen(): Promise<ManualMcp> {
    const mcp = new ManualMcp();
    await new Promise<void>((resolve, reject) => {
      mcp.server.once("error", reject);
      mcp.server.listen(0, "127.0.0.1", () => {
        mcp.server.removeListener("error", reject);
        resolve();
      });
    });
    const address = mcp.server.address();
    if (!address || typeof address === "string") throw Error("Manual MCP unavailable");
    mcp.origin = `http://127.0.0.1:${String(address.port)}`;
    return mcp;
  }
  get url(): string {
    return `${this.origin}/control/v1`;
  }
  get env(): Readonly<Record<string, string>> {
    // Names are the provider attachment ABI, not a ControlService grant.
    return { FOOM_CONTROL_URL: this.url, FOOM_CONTROL_TOKEN: this.token };
  }
  readonly toolNames = ["manual"];
  dispose(): void {
    this.close();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.session = undefined;
    this.server.close();
    this.server.closeAllConnections();
  }
}
