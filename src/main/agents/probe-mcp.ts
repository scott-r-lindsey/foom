import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { exact, object } from "../../shared/control-validation";

const versions = ["2025-03-26", "2025-06-18", "2025-11-25"];
/** Deliberately independent of ControlService/ControlMcp: no path to repository tools. */
export class ProbeMcp {
  readonly token = randomBytes(32).toString("hex");
  private origin = "";
  private session: { id: string; version: string; ready: boolean } | undefined;
  private closed = false;
  private readonly facts = { connected: false, listedTools: false, pinged: false };
  private readonly server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
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
            !versions.includes(protocol) ||
            typeof client["name"] !== "string" ||
            typeof client["version"] !== "string"
          )
            throw Error();
          this.session = { id: randomUUID(), version: protocol, ready: false };
          this.facts.connected = true;
          result(
            {
              protocolVersion: protocol,
              capabilities: { tools: {} },
              serverInfo: { name: "foom-probe", version: "1.0.0" },
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
          this.facts.listedTools = true;
          result({
            tools: [
              {
                name: "ping",
                description: "Verify the isolated probe connection.",
                inputSchema: { type: "object", properties: {}, additionalProperties: false },
              },
            ],
          });
          return;
        }
        if (value["method"] === "tools/call") {
          exact(params, ["name", "arguments"]);
          if (params["name"] !== "ping") {
            result({ isError: true, content: [{ type: "text", text: "forbidden" }] });
            return;
          }
          exact(object(params["arguments"] ?? {}), []);
          this.facts.pinged = true;
          result({ content: [{ type: "text", text: "pong" }], isError: false });
          return;
        }
        end(200, { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
      } catch {
        end(400);
      }
    });
  });
  private constructor() {
    this.server.maxConnections = 32;
    this.server.requestTimeout = 5000;
    this.server.headersTimeout = 5000;
    this.server.timeout = 5000;
    this.server.keepAliveTimeout = 1000;
  }
  static async listen(): Promise<ProbeMcp> {
    const mcp = new ProbeMcp();
    await new Promise<void>((resolve, reject) => {
      mcp.server.once("error", reject);
      mcp.server.listen(0, "127.0.0.1", () => {
        mcp.server.removeListener("error", reject);
        resolve();
      });
    });
    const address = mcp.server.address();
    if (!address || typeof address === "string") throw Error("Probe MCP unavailable");
    mcp.origin = `http://127.0.0.1:${String(address.port)}`;
    return mcp;
  }
  get url(): string {
    return `${this.origin}/control/v1`;
  }
  snapshot() {
    return { ...this.facts };
  }
  close(): void {
    this.closed = true;
    this.session = undefined;
    this.server.close();
    this.server.closeAllConnections();
  }
}
