import { createServer, request, type Server } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManifestChannel } from "../../shared/agent-manifest-v2";
import type { V2HookState } from "../../shared/v2-hooks";
import type { HookSignal } from "../../shared/hooks";
import type { RemoteControlResult } from "../../shared/remote-agent";
import {
  keys,
  record,
  remoteControlResult,
  remoteControlParams,
} from "../../shared/remote-agent-protocol";
import { reduceV2 } from "../../shared/agent-hook-events";
import { checkSocket, privateDirectory } from "./private-path";

const digest = (value: string) => createHash("sha256").update(value).digest();
/** Per-launch HTTP over a Unix socket. There is deliberately no IP listen path. */
export class AgentEndpoint {
  readonly directory = mkdtempSync(join(realpathSync(tmpdir()), "fa-"));
  readonly socket = join(this.directory, "s");
  readonly token = randomBytes(32).toString("hex");
  readonly hookToken = randomBytes(32).toString("hex");
  readonly channels = new Map<string, ManifestChannel>();
  readonly state: V2HookState = {};
  private active = true;
  private activation: Promise<void> | undefined;
  private enable: (() => void) | undefined;
  private calls = 0;
  private readonly server: Server;
  constructor(
    agent: string,
    signal: (signal: HookSignal) => void,
    call: (method: string, params: unknown) => Promise<RemoteControlResult>,
    waitForActivation = false,
  ) {
    privateDirectory(this.directory);
    if (waitForActivation)
      this.activation = new Promise((resolve) => {
        this.enable = resolve;
      });
    this.server = createServer(
      { maxHeaderSize: 8192, connectionsCheckingInterval: 1000 },
      (req, res) => {
        const end = (status: number, value?: RemoteControlResult) => {
          res.writeHead(status, {
            Connection: "close",
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          res.end(value ? JSON.stringify(value) : "");
        };
        const hook = req.url === "/hook";
        const candidate = req.headers.authorization ?? "";
        const expected = hook ? this.hookToken : this.token;
        if (!this.live() || !timingSafeEqual(digest(candidate), digest(expected))) {
          end(401);
          return;
        }
        if (
          req.method !== "POST" ||
          (!hook && req.url !== "/call") ||
          req.headers.origin !== undefined ||
          req.headers.host !== "localhost"
        ) {
          end(403);
          return;
        }
        if (
          req.headers["content-type"] !== "application/json" ||
          Number(req.headers["content-length"]) > 65536
        ) {
          end(400);
          return;
        }
        if (this.calls >= 4) {
          end(429);
          return;
        }
        this.calls++;
        let released = false;
        const release = () => {
          if (!released) {
            released = true;
            this.calls--;
          }
        };
        res.once("close", release);
        let size = 0;
        const chunks: Buffer[] = [];
        req.on("error", release);
        req.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 65536) {
            chunks.length = 0;
            end(413);
          } else if (!res.writableEnded) chunks.push(chunk);
        });
        req.on("end", () => {
          if (res.writableEnded) return;
          void (async () => {
            try {
              if (!this.live()) {
                end(401);
                return;
              }
              const value: unknown = JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
              );
              if (!record(value)) throw new Error("Invalid endpoint request");
              if (hook) {
                if (
                  !keys(value, ["channel", "event", "sequence", "payload"]) ||
                  typeof value["channel"] !== "string"
                )
                  throw new Error("Invalid hook");
                const channel = this.channels.get(value["channel"]);
                if (!channel) throw new Error("Unknown channel");
                // The placeholder is never an externally visible terminal identity.
                const reduced = reduceV2(
                  channel,
                  this.state,
                  "remote",
                  agent,
                  value["payload"],
                  value["event"],
                  value["sequence"],
                );
                if (reduced) signal(reduced);
                end(204);
              } else {
                if (
                  !keys(value, ["method", "params"]) ||
                  typeof value["method"] !== "string" ||
                  value["method"].length > 64 ||
                  !record(value["params"])
                )
                  throw new Error("Invalid control request");
                await this.activation;
                if (!this.live()) {
                  end(401);
                  return;
                }
                const result = await call(
                  value["method"],
                  remoteControlParams(value["method"], value["params"]),
                );
                if (!this.live()) {
                  end(401);
                  return;
                }
                if (!remoteControlResult(result)) throw new Error("Invalid control result");
                end(200, result);
              }
            } catch {
              end(400, { type: "error", error: "invalid_request" });
            } finally {
              release();
            }
          })();
        });
      },
    );
    this.server.maxConnections = 16;
    this.server.requestTimeout = 5000;
    this.server.headersTimeout = 5000;
    this.server.timeout = 5000;
    this.server.keepAliveTimeout = 1000;
  }
  async listen(): Promise<void> {
    if (Buffer.byteLength(this.socket) > 100) throw new Error("Remote socket path too long");
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socket, () => {
        this.server.removeListener("error", reject);
        chmodSync(this.socket, 0o600);
        resolve();
      });
    });
  }
  private live(): boolean {
    return this.active;
  }
  activate(): void {
    this.enable?.();
    this.enable = undefined;
    this.activation = undefined;
  }
  env(): Record<string, string> {
    return {
      FOOM_REMOTE_SOCKET: this.socket,
      FOOM_REMOTE_TOKEN: this.token,
      FOOM_REMOTE_HOOK_TOKEN: this.hookToken,
      FOOM_REMOTE_HELPER: process.execPath,
    };
  }
  folder(name: string): string {
    const path = join(this.directory, name);
    mkdirSync(path, { mode: 0o700 });
    return path;
  }
  dispose(): void {
    if (!this.live()) return;
    this.active = false;
    this.activate();
    this.channels.clear();
    if (this.server.listening) this.server.close();
    this.server.closeAllConnections();
    try {
      rmSync(this.directory, { recursive: true, force: true });
    } catch {
      /* Credentials and sockets stay revoked even if an agent made its launch files inaccessible. */
    }
  }
}
/** Used only by the child-facing helper. No daemon socket or terminal ID is involved. */
export function endpointRequest(
  path: "/hook" | "/call",
  value: unknown,
  env = process.env,
): Promise<RemoteControlResult | undefined> {
  return new Promise((resolve, reject) => {
    const socketPath = env["FOOM_REMOTE_SOCKET"];
    const token = env[path === "/hook" ? "FOOM_REMOTE_HOOK_TOKEN" : "FOOM_REMOTE_TOKEN"];
    if (!socketPath || !token) {
      reject(new Error("Remote launch unavailable"));
      return;
    }
    try {
      checkSocket(socketPath);
    } catch {
      reject(new Error("Remote request unavailable"));
      return;
    }
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > 65536) {
      reject(new Error("Remote request too large"));
      return;
    }
    const req = request(
      {
        socketPath,
        path,
        method: "POST",
        headers: {
          Host: "localhost",
          "Content-Type": "application/json",
          Authorization: token,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (bytes: Buffer) => {
          size += bytes.length;
          if (size > 65536) res.destroy(new Error("Remote response too large"));
          else chunks.push(bytes);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            if (res.statusCode === 204 && path === "/hook") {
              resolve(undefined);
              return;
            }
            if (res.statusCode !== 200) throw new Error("Remote request refused");
            const result: unknown = JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
            );
            if (!remoteControlResult(result)) throw new Error("Invalid remote result");
            resolve(result);
          } catch {
            reject(new Error("Remote request unavailable"));
          }
        });
      },
    );
    const deadline = setTimeout(
      () => req.destroy(new Error("Remote request timed out")),
      path === "/hook" ? 1000 : 10000,
    );
    req.once("close", () => {
      clearTimeout(deadline);
    });
    req.once("error", reject);
    req.end(body);
  });
}
