import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HookAgent, HookLaunch, HookSignal } from "./shared/hooks";

export const MAX_HOOK_BYTES = 64 * 1024;
type Session = { terminalId: string; agent: HookAgent; digest: Buffer; agentId?: string };

function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
}

function reduceEvent(session: Session, value: unknown): HookSignal | undefined {
  if (!record(value)) throw new Error("Invalid event");
  const agentId = session.agent === "claude" ? value["session_id"] : value["thread-id"];
  if (!identifier(agentId) || (session.agentId !== undefined && session.agentId !== agentId))
    throw new Error("Invalid agent session");
  let signal: HookSignal["signal"];
  let action: HookSignal["action"] = "classify";
  if (session.agent === "codex") {
    if (!identifier(value["turn-id"]) || typeof value["type"] !== "string")
      throw new Error("Invalid turn");
    if (value["type"] !== "agent-turn-complete") return;
    signal = "codex:agent-turn-complete";
  } else {
    switch (value["hook_event_name"]) {
      case "Stop":
        signal = "claude:Stop";
        break;
      case "PermissionRequest":
        signal = "claude:PermissionRequest";
        action = "needs_input";
        break;
      case "Notification":
        if (typeof value["notification_type"] !== "string") throw new Error("Invalid notification");
        if (value["notification_type"] === "permission_prompt") {
          signal = "claude:permission_prompt";
          action = "needs_input";
        } else if (value["notification_type"] === "idle_prompt") signal = "claude:idle_prompt";
        else return;
        break;
      default:
        if (typeof value["hook_event_name"] !== "string") throw new Error("Invalid hook");
        return;
    }
  }
  session.agentId = agentId;
  return { terminalId: session.terminalId, action, signal };
}

/** Main-only launch capability. Payloads are never logged or passed to consumers. */
export class HookReceiver {
  private readonly sessions = new Map<string, Session>();
  private readonly unknownDigest = digest(randomBytes(32).toString("hex"));
  private readonly server = createServer(
    { maxHeaderSize: 8192, connectionsCheckingInterval: 1000 },
    (request, response) => {
      this.receive(request, response);
    },
  );
  private closed = false;
  private origin = "";

  private constructor(private readonly onSignal: (signal: HookSignal) => void) {
    this.server.requestTimeout = 5000;
    this.server.headersTimeout = 5000;
    this.server.timeout = 5000;
    this.server.keepAliveTimeout = 1000;
    this.server.maxConnections = 32;
  }

  static async listen(onSignal: (signal: HookSignal) => void): Promise<HookReceiver> {
    const receiver = new HookReceiver(onSignal);
    await new Promise<void>((resolve, reject) => {
      receiver.server.once("error", reject);
      // Never accept a caller-supplied bind address, even in development.
      receiver.server.listen(0, "127.0.0.1", () => {
        receiver.server.removeListener("error", reject);
        resolve();
      });
    });
    const address = receiver.server.address();
    if (!address || typeof address === "string") throw new Error("Invalid listener address");
    receiver.origin = `http://127.0.0.1:${String(address.port)}`;
    return receiver;
  }

  register(terminalId: string, agent: HookAgent): HookLaunch {
    if (this.closed) throw new Error("Receiver is closed");
    if (!identifier(terminalId)) throw new Error("Invalid terminal ID");
    const sessionId = randomUUID();
    const token = randomBytes(32).toString("hex");
    this.sessions.set(sessionId, { terminalId, agent, digest: digest(token) });
    return {
      env: { FOOM_SESSION: sessionId, FOOM_TOKEN: token, FOOM_HOOK_URL: `${this.origin}/hooks` },
      revoke: () => {
        this.sessions.delete(sessionId);
      },
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.sessions.clear();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
      this.server.closeAllConnections();
    });
  }

  private receive(request: IncomingMessage, response: ServerResponse): void {
    const end = (status: number): void => {
      response.writeHead(status, { Connection: "close", "Cache-Control": "no-store" });
      response.end();
    };
    // No browser clients, DNS aliases, cross-origin requests, or query credentials.
    if (request.headers.host !== this.origin.slice(7) || request.headers.origin !== undefined) {
      end(403);
      return;
    }
    if (request.method !== "POST" || request.url !== "/hooks") {
      end(404);
      return;
    }
    const header = request.headers["x-foom-session"];
    const sessionId = typeof header === "string" ? header : "";
    const session = this.sessions.get(sessionId);
    const authorization = request.headers.authorization ?? "";
    const authorized = timingSafeEqual(
      digest(authorization),
      session?.digest ?? this.unknownDigest,
    );
    if (!authorized || !session) {
      end(401);
      return;
    }
    if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
      end(415);
      return;
    }
    if (Number(request.headers["content-length"]) > MAX_HOOK_BYTES) {
      end(413);
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("error", () => {
      chunks.length = 0;
    });
    request.on("data", (chunk: Buffer) => {
      if (response.writableEnded) return;
      size += chunk.length;
      if (size > MAX_HOOK_BYTES) {
        chunks.length = 0;
        end(413);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (response.writableEnded) return;
      // A launch can be revoked while a request is still arriving.
      if (this.sessions.get(sessionId) !== session) {
        end(401);
        return;
      }
      let signal: HookSignal | undefined;
      try {
        const value: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
        );
        signal = reduceEvent(session, value);
      } catch {
        end(400);
        return;
      }
      try {
        if (signal) this.onSignal(signal);
        end(204);
      } catch {
        end(500);
      }
    });
  }
}
