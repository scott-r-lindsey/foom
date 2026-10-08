import { ControlMcp } from "./mcp";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ControlService } from "./service";
import type { Principal } from "./types";
import { ControlError } from "./validation";

/** Transport limits only; roles, methods and target policy live in ControlService. */
export class ControlHttp {
  private readonly server = createServer(
    { maxHeaderSize: 8192, connectionsCheckingInterval: 1000 },
    (request, response) => {
      this.receive(request, response);
    },
  );
  private readonly mcp: ControlMcp;
  private origin = "";
  private closed = false;
  private constructor(private readonly service: ControlService) {
    this.mcp = new ControlMcp(service);
    this.server.maxConnections = 32;
    this.server.requestTimeout = 5000;
    this.server.headersTimeout = 5000;
    this.server.timeout = 5000;
    this.server.keepAliveTimeout = 1000;
  }
  static async listen(service: ControlService): Promise<ControlHttp> {
    const http = new ControlHttp(service);
    await new Promise<void>((resolve, reject) => {
      http.server.once("error", reject);
      http.server.listen(0, "127.0.0.1", () => {
        http.server.removeListener("error", reject);
        resolve();
      });
    });
    const address = http.server.address();
    if (!address || typeof address === "string") throw new ControlError("unavailable");
    http.origin = `http://127.0.0.1:${String(address.port)}`;
    return http;
  }
  get endpoint(): string {
    return `${this.origin}/control/v1`;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.service.close();
    await this.service.operations.drain();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
      this.server.closeAllConnections();
    });
  }
  private receive(request: IncomingMessage, response: ServerResponse): void {
    const end = (status: number, result?: unknown, sessionId?: string): void => {
      response.writeHead(status, {
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
        Connection: "close",
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
      });
      response.end(JSON.stringify(result));
    };
    if (
      request.headers.host !== this.origin.slice(7) ||
      request.headers.origin !== undefined ||
      request.socket.remoteAddress !== "127.0.0.1"
    ) {
      end(403, { error: "forbidden" });
      return;
    }
    const mcp = request.url === "/mcp";
    if (!mcp && (request.url !== "/control/v1" || request.method !== "POST")) {
      end(404, { error: "not_found" });
      return;
    }
    let actor: Principal;
    let release: () => void;
    try {
      const token = request.headers.authorization;
      if (!token?.startsWith("Bearer ")) throw new ControlError("unauthorized");
      actor = this.service.authenticate(token.slice(7));
      release = this.service.reserve(actor);
    } catch (error) {
      end(error instanceof ControlError && error.code === "capacity" ? 429 : 401, {
        error: error instanceof ControlError ? error.code : "unauthorized",
      });
      return;
    }
    response.once("close", release);
    if (mcp) {
      try {
        this.mcp.transport(actor, request.headers, request.method ?? "");
      } catch (error) {
        end(error instanceof ControlError && error.code === "not_found" ? 404 : 400, {
          error: "invalid_request",
        });
        return;
      }
      if (request.method !== "POST") {
        end(request.method === "DELETE" ? 204 : 405);
        return;
      }
      const accept = request.headers.accept ?? "";
      if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
        end(406, { error: "invalid_request" });
        return;
      }
    }
    if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
      end(415, { error: "invalid_request" });
      return;
    }
    if (Number(request.headers["content-length"]) > 65536) {
      end(413, { error: "invalid_request" });
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("error", () => {
      chunks.length = 0;
      release();
    });
    request.on("data", (chunk: Buffer) => {
      if (response.writableEnded) return;
      size += chunk.length;
      if (size > 65536) {
        chunks.length = 0;
        end(413, { error: "invalid_request" });
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (response.writableEnded) return;
      try {
        const value: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
        );
        if (mcp) {
          const result = this.mcp.dispatch(actor, request.headers, value);
          end(result.status, result.body, result.sessionId);
        } else end(200, { result: this.service.dispatch(actor, value) });
      } catch (error) {
        const code = error instanceof ControlError ? error.code : "invalid_request";
        end(
          code === "unauthorized"
            ? 401
            : code === "forbidden"
              ? 403
              : code === "not_found"
                ? 404
                : 400,
          { error: code },
        );
      }
    });
  }
}
