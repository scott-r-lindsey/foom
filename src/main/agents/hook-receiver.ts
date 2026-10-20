import { probeHookEvent, type ProbeHookObserver } from "./probe-events";
import type { ManifestChannel } from "../../shared/agent-manifest-v2";
import type { V2HookState } from "./providers/v2-events";
import { agentProvider } from "./providers/registry";
import { reduceEvent, identifier } from "./providers/hook-events";
import type { HookSession as Session } from "./providers/hook-events";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HookAgent, HookLaunch, HookSignal } from "../../shared/hooks";

export const MAX_HOOK_BYTES = 64 * 1024;

function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
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

  register(
    terminalId: string,
    agent: HookAgent,
    v2?: {
      channels: Map<string, ManifestChannel>;
      state: V2HookState;
      observe?: ProbeHookObserver;
    },
  ): HookLaunch {
    if (this.closed) throw new Error("Receiver is closed");
    if (!identifier(terminalId)) throw new Error("Invalid terminal ID");
    const sessionId = randomUUID();
    const token = randomBytes(32).toString("hex");
    const provider = v2 ? undefined : agentProvider(agent);
    const model = provider?.model;
    this.sessions.set(sessionId, {
      terminalId,
      agent,
      digest: digest(token),
      ...(model ? { model } : {}),
      ...(v2 ? { channels: v2.channels, v2State: v2.state, observe: v2.observe } : {}),
    });
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
        const header = request.headers["x-foom-channel"];
        const channel =
          typeof header === "string"
            ? session.channels?.get(header)
            : header === undefined
              ? [...(session.channels?.values() ?? [])].find(
                  (entry) => entry.observer.protocol === "ordered-v2",
                )
              : undefined;
        const expected = session.observe?.expected();
        try {
          signal = reduceEvent(
            session,
            value,
            request.headers["x-foom-event"],
            request.headers["x-foom-sequence"],
            request.headers["x-foom-channel"],
          );
        } finally {
          if (session.observe && channel)
            session.observe.receive(
              probeHookEvent(
                channel,
                value,
                request.headers["x-foom-event"],
                request.headers["x-foom-sequence"],
                expected,
                signal,
              ),
            );
        }
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
