import { createServer } from "node:http";
import { ControlError } from "../../shared/control-validation";
import type { AgentProbes } from "./probes";

/** Separate loopback-only capability, no discovery file, pairing, MCP or repository API. */
export class ProbeHttp {
  private origin = "";
  private readonly active = new Set<string>();
  private readonly server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    const end = (status: number, body: unknown) => {
      response.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        Connection: "close",
      });
      response.end(JSON.stringify(body));
    };
    if (
      request.method !== "POST" ||
      request.url !== "/probe/v1" ||
      request.headers.host !== this.origin.slice(7) ||
      request.headers.origin !== undefined ||
      request.socket.remoteAddress !== "127.0.0.1"
    ) {
      end(403, { error: "forbidden" });
      return;
    }
    const auth = request.headers.authorization;
    if (!auth || !/^Bearer [a-f0-9]{64}$/u.test(auth)) {
      end(401, { error: "unauthorized" });
      return;
    }
    const token = auth.slice(7);
    if (this.active.has(token)) {
      end(429, { error: "capacity" });
      return;
    }
    if (request.headers["content-type"] !== "application/json") {
      end(400, { error: "invalid_request" });
      return;
    }
    this.active.add(token);
    response.once("close", () => this.active.delete(token));
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("error", () => this.active.delete(token));
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
      request.socket.setTimeout(615000);
      void (async () => {
        try {
          const input: unknown = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
          );
          end(200, { result: await this.probes.call(token, input) });
        } catch (error) {
          const code = error instanceof ControlError ? error.code : "unavailable";
          end(code === "unauthorized" ? 401 : 400, { error: code });
        }
      })();
    });
  });
  private constructor(private readonly probes: AgentProbes) {
    this.server.maxConnections = 32;
    this.server.requestTimeout = 5000;
    this.server.headersTimeout = 5000;
    this.server.timeout = 5000;
    this.server.keepAliveTimeout = 1000;
  }
  static async listen(probes: AgentProbes): Promise<ProbeHttp> {
    const http = new ProbeHttp(probes);
    try {
      await new Promise<void>((resolve, reject) => {
        http.server.once("error", reject);
        http.server.listen(0, "127.0.0.1", () => {
          http.server.removeListener("error", reject);
          resolve();
        });
      });
      const address = http.server.address();
      if (!address || typeof address === "string") throw new Error("Probe listener unavailable");
      http.origin = `http://127.0.0.1:${String(address.port)}`;
      return http;
    } catch (error) {
      http.server.close();
      throw error;
    }
  }
  get url(): string {
    return `${this.origin}/probe/v1`;
  }
  async close(): Promise<void> {
    await this.probes.close();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
      this.server.closeAllConnections();
    });
  }
}
