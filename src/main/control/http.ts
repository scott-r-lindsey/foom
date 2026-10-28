import { Pairing } from "./pairing";
import type { PairingOptions } from "./types";
import { ControlMcp } from "./mcp";
import { boundedHttpServer } from "./http-limits";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ControlService } from "./service";
import type { Principal } from "./types";
import { ControlError } from "../../shared/control-validation";

/** Transport limits only; roles, methods and target policy live in ControlService. */
export class ControlHttp {
  private readonly server = boundedHttpServer((request, response) => {
    this.receive(request, response);
  });
  private readonly pairing: Pairing | undefined;
  private readonly mcp: ControlMcp;
  private origin = "";
  private closed = false;
  private constructor(
    private readonly service: ControlService,
    options?: PairingOptions,
  ) {
    this.pairing = options ? new Pairing(service, options) : undefined;
    this.mcp = new ControlMcp(service);
  }
  static async listen(service: ControlService, options?: PairingOptions): Promise<ControlHttp> {
    const http = new ControlHttp(service, options);
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
    this.pairing?.close();
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
    if (request.url === "/control/v1/pair" && request.method === "POST" && this.pairing) {
      this.pairing.receive(request, response);
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
    const disconnected = new AbortController();
    response.once("close", () => {
      release();
      disconnected.abort();
    });
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
      void (async () => {
        try {
          const value: unknown = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
          );
          // Leave room for the CLI's 60-second mutation deadline as well as bounded waits.
          request.socket.setTimeout(65000);
          if (mcp) {
            const result = await this.mcp.dispatch(actor, request.headers, value);
            this.service.mcpConnected(actor);
            if (!response.writableEnded) end(result.status, result.body, result.sessionId);
          } else {
            if (
              typeof value === "object" &&
              value !== null &&
              "method" in value &&
              value.method === "wait_for" &&
              "params" in value &&
              typeof value.params === "object" &&
              value.params !== null &&
              "untilEvent" in value.params &&
              value.params.untilEvent === true
            )
              request.socket.setTimeout(0);
            const result = await this.service.call(actor, value, disconnected.signal);
            if (!response.writableEnded) end(200, { result });
          }
        } catch (error) {
          if (response.writableEnded) return;
          const code = error instanceof ControlError ? error.code : "invalid_request";
          end(
            code === "unauthorized"
              ? 401
              : code === "forbidden" || code === "no_parent"
                ? 403
                : code === "not_found"
                  ? 404
                  : 400,
            { error: code },
          );
        }
      })();
    });
  }
}
