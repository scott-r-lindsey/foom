import { createHash } from "node:crypto";

/** Fixed remote pi-v1 ABI. Executed only by Pi; no user-selected source or module imports. */
const PI_REMOTE_V1 = String.raw`import { readFileSync } from "node:fs";
import { request } from "node:http";
export default function (pi) {
  const env = process.env;
  const token = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  if (!env.FOOM_REMOTE_SOCKET || !token(env.FOOM_REMOTE_TOKEN)) return;
  try {
    const source = readFileSync(new URL("./launch.json", import.meta.url), "utf8");
    if (source.length > 16384) return;
    const config = JSON.parse(source);
    const post = (path, value) => new Promise((resolve, reject) => {
      const body = JSON.stringify(value);
      if (Buffer.byteLength(body) > 65536) { reject(new Error("Invalid report")); return; }
      const req = request({socketPath: env.FOOM_REMOTE_SOCKET, path, method: "POST", agent: false,
        headers: {Host: "localhost", "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: path === "/hook" ? env.FOOM_REMOTE_HOOK_TOKEN : env.FOOM_REMOTE_TOKEN}}, res => {
        let size = 0;
        const chunks = [];
        res.on("error", reject);
        res.on("data", chunk => {
          size += chunk.length;
          if (size > 65536) res.destroy(new Error("Response too large"));
          else chunks.push(chunk);
        });
        res.on("end", () => {
          if (res.statusCode === 204 && path === "/hook") { resolve(); return; }
          try {
            if (res.statusCode !== 200) throw new Error("Unavailable");
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch { reject(new Error("Unavailable")); }
        });
      });
      const deadline = setTimeout(() => req.destroy(new Error("Unavailable")), 1000);
      req.on("close", () => clearTimeout(deadline));
      req.on("error", reject);
      req.end(body);
    });
    const observe = (name, handler) => pi.on(name, async (event, ctx) => {
      try { await handler(event, ctx); } catch { /* Observers never gate execution. */ }
    });
    if (config.mcp && /^foom_[a-f0-9]{32}$/.test(config.mcp.name) && env.FOOM_REMOTE_HELPER) {
      const name = config.mcp.name;
      let previous;
      const refresh = async () => {
        try {
          const identity = await post("/call", {method: "whoami", params: {}});
          if (identity?.type !== "identity" || !Array.isArray(identity.capabilities) || identity.capabilities.length > 64 ||
              identity.capabilities.some(value => typeof value !== "string")) throw new Error("Unavailable");
          const tools = ["whoami", "manual", "handoff"].filter(tool => identity.capabilities.includes(tool));
          const fingerprint = JSON.stringify(tools);
          if (previous === fingerprint) return;
          pi.registerMcpServer(name, {command: env.FOOM_REMOTE_HELPER, args: ["--mcp"],
            env: {FOOM_REMOTE_SOCKET: env.FOOM_REMOTE_SOCKET, FOOM_REMOTE_TOKEN: env.FOOM_REMOTE_TOKEN},
            exposure: "hidden", toolExposure: Object.fromEntries(tools.map(tool => [tool, "direct"]))});
          previous = fingerprint;
        } catch { previous = undefined; try { pi.unregisterMcpServer(name); } catch {} }
      };
      observe("session_start", refresh);
      observe("before_agent_start", refresh);
    }
    if (config.channel !== "lifecycle" || !token(env.FOOM_REMOTE_HOOK_TOKEN)) return;
    const report = (event, ctx, facts = {}) => {
      const conversationId = ctx.sessionManager.getSessionId();
      if (typeof conversationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(conversationId)) return;
      return post("/hook", {channel: config.channel, payload: {event, conversationId, ...facts}});
    };
    let outcome;
    observe("session_start", (_event, ctx) => report("session_start", ctx));
    observe("agent_start", (_event, ctx) => { outcome = undefined; return report("agent_start", ctx); });
    for (const event of ["turn_start", "turn_end", "tool_execution_start", "ui_prompt_start"])
      observe(event, (_event, ctx) => report(event, ctx));
    observe("ui_prompt_end", (_event, ctx) => {
      const fullyIdle = ctx.isIdle();
      if (typeof fullyIdle === "boolean") return report("ui_prompt_end", ctx, {fullyIdle});
    });
    observe("agent_before_settle", event => {
      outcome = ["completed", "aborted", "error"].includes(event?.outcome) ? event.outcome : undefined;
    });
    observe("agent_settled", (event, ctx) => {
      if (typeof event?.aborted === "boolean" && outcome !== undefined)
        return report("agent_settled", ctx, {outcome: event.aborted ? "aborted" : outcome});
    });
  } catch { /* Missing files and unsupported extension APIs retain screen evaluation. */ }
}
`;

const SHA256 = "65b4c42b9985b8796dd11ba70c7ed6e36ca92141031e579a5f5a5b665bfd32c0";
export function assertRemotePiIntegrity(source: string): void {
  if (createHash("sha256").update(source).digest("hex") !== SHA256)
    throw new Error("Remote extension integrity mismatch");
}
export function remotePiExtension(): string {
  assertRemotePiIntegrity(PI_REMOTE_V1);
  return PI_REMOTE_V1;
}
