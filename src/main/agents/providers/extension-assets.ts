import { createHash } from "node:crypto";

// Executed by the agent, never in main. Keep this self-contained, silent and observe-only.
// Revise the ABI filename and lock together when these reviewed bytes change.
const PI_V1 = String.raw`import { readFileSync } from "node:fs";
import { request } from "node:http";
export default function (pi) {
  const env = process.env;
  const token = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  if (!token(env.FOOM_TOKEN) && !token(env.FOOM_CONTROL_TOKEN)) return;
  try {
    const source = readFileSync(new URL("./launch.json", import.meta.url), "utf8");
    if (source.length > 16384) return;
    const config = JSON.parse(source);
    if (!config || typeof config !== "object" || Array.isArray(config)) return;
    const endpoint = (value, path) => {
      if (typeof value !== "string") return undefined;
      const url = new URL(value);
      return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port &&
        url.pathname === path && !url.username && !url.password && !url.search && !url.hash
        ? url : undefined;
    };
    const post = (url, headers, value, read = false) => new Promise((resolve, reject) => {
      const body = JSON.stringify(value);
      let timer;
      let response;
      const finish = (value, failed = false) => {
        clearTimeout(timer);
        if (failed) reject(new Error("Foom transport unavailable"));
        else resolve(value);
      };
      const req = request(url, {method: "POST", headers: {
        "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers,
      }}, (res) => {
        response = res;
        if (!read) { res.destroy(); finish(); return; }
        let bytes = 0;
        const chunks = [];
        res.on("error", () => finish(undefined, true));
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 65536) { res.destroy(); finish(undefined, true); }
          else chunks.push(chunk);
        });
        res.on("end", () => {
          if (res.statusCode !== 200) { finish(undefined, true); return; }
          try { finish(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch { finish(undefined, true); }
        });
      });
      req.on("error", () => finish(undefined, true));
      timer = setTimeout(() => { req.destroy(); response?.destroy(); finish(undefined, true); }, 1000);
      req.end(body);
    });
    if (token(env.FOOM_CONTROL_TOKEN) && config.mcp) {
      const mcp = config.mcp;
      const url = endpoint(mcp.url, "/mcp");
      if (url && /^foom_[a-f0-9]{32}$/.test(mcp.name) && Array.isArray(mcp.tools) &&
          mcp.tools.length <= 64 && mcp.tools.every((name) => typeof name === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(name))) {
        let previous;
        const refresh = async () => {
          try {
            let tools = mcp.tools;
            if (mcp.roleAware === true) {
              const control = new URL(url);
              control.pathname = "/control/v1";
              const value = await post(control, {Authorization: "Bearer " + env.FOOM_CONTROL_TOKEN}, {
                version: 1, instanceId: env.FOOM_CONTROL_INSTANCE, method: "whoami", params: {},
              }, true);
              const capabilities = value?.result?.capabilities;
              if (!Array.isArray(capabilities) || capabilities.length > 64 ||
                  capabilities.some((name) => typeof name !== "string")) throw new Error("Invalid capabilities");
              tools = tools.filter((name) => capabilities.includes(name));
            }
            const fingerprint = JSON.stringify(tools);
            if (fingerprint === previous) return;
            pi.registerMcpServer(mcp.name, {url: url.href,
              headers: {Authorization: "Bearer " + env.FOOM_CONTROL_TOKEN},
              exposure: "hidden", toolExposure: Object.fromEntries(tools.map((name) => [name, "direct"]))});
            previous = fingerprint;
          } catch {
            previous = undefined;
            try { pi.unregisterMcpServer(mcp.name); } catch { /* Do not expose a stale role. */ }
          }
        };
        if (mcp.roleAware === true) {
          pi.on("session_start", refresh);
          pi.on("before_agent_start", refresh);
        } else void refresh();
      }
    }
    const url = endpoint(env.FOOM_HOOK_URL, "/hooks");
    if (env.FOOM_HOOK_PROTOCOL !== "1" || !token(env.FOOM_TOKEN) || !url ||
        !/^[a-f0-9-]{36}$/.test(env.FOOM_SESSION ?? "") ||
        typeof config.channel !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(config.channel) ||
        !JSON.parse(env.FOOM_HOOK_CHANNELS ?? "[]").includes(config.channel)) return;
    const report = async (event, ctx, facts = {}) => {
      try {
        const conversationId = ctx.sessionManager.getSessionId();
        if (typeof conversationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(conversationId)) return;
        await post(url, {
          Authorization: env.FOOM_TOKEN, "X-Foom-Session": env.FOOM_SESSION,
          "X-Foom-Channel": config.channel,
        }, {event, conversationId, ...facts});
      } catch { /* Reports never gate agent execution. */ }
    };
    let outcome;
    pi.on("session_start", (_event, ctx) => report("session_start", ctx));
    pi.on("agent_start", (_event, ctx) => { outcome = undefined; return report("agent_start", ctx); });
    for (const event of ["turn_start", "turn_end", "tool_execution_start", "ui_prompt_start"])
      pi.on(event, (_event, ctx) => report(event, ctx));
    pi.on("ui_prompt_end", (_event, ctx) => report("ui_prompt_end", ctx, {fullyIdle: ctx.isIdle()}));
    pi.on("agent_before_settle", (event) => {
      // Only copy the bounded outcome. Return no entries or continuation/approval decision.
      outcome = ["completed", "aborted", "error"].includes(event.outcome) ? event.outcome : undefined;
    });
    pi.on("agent_settled", (event, ctx) => {
      if (typeof event.aborted !== "boolean" || outcome === undefined) return;
      return report("agent_settled", ctx, {outcome: event.aborted ? "aborted" : outcome});
    });
  } catch { /* Missing files, unsupported APIs and revoked receivers fail open. */ }
}
`;

const PI_V1_SHA256 = "ae9a6e65ea5985aef101d087dd4825b4839236122fce9c3ec204c7af3eb722e0";

export function assertExtensionIntegrity(source: string): void {
  if (createHash("sha256").update(source).digest("hex") !== PI_V1_SHA256)
    throw new Error("Bundled extension integrity mismatch");
}

/** A manifest selects a reviewed ABI, never executable source, a module path or a digest. */
export function extensionAsset(api: string): { name: string; source: string } {
  if (api !== "pi-v1") throw new Error("Unknown extension API");
  assertExtensionIntegrity(PI_V1);
  return { name: "pi-v1.mjs", source: PI_V1 };
}
