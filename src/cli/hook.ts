import { request } from "node:http";
import type { ConsoleIo } from "./types";

/** Observe only. No discovery, pairing, control credentials, or payload-derived authority. */
export async function hookCommand(
  args: readonly string[],
  input: ConsoleIo["input"],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  if (!env["FOOM_HOOK_URL"] || !env["FOOM_SESSION"] || !env["FOOM_TOKEN"]) return 0;
  try {
    if (env["FOOM_HOOK_PROTOCOL"] !== "1") return 2;
    const event = args[1];
    if (!event || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(event)) return 2;
    const channels: unknown = JSON.parse(env["FOOM_HOOK_CHANNELS"] ?? "[]");
    if (
      !Array.isArray(channels) ||
      !channels.every(
        (id: unknown): id is string => typeof id === "string" && /^[a-z][a-z0-9-]{0,39}$/u.test(id),
      )
    )
      return 2;
    const channel =
      args.length === 2 && channels.length === 1
        ? channels[0]
        : args.length === 4 && args[2] === "--channel"
          ? args[3]
          : undefined;
    if (typeof channel !== "string" || !channels.includes(channel)) return 2;
    const url = env["FOOM_HOOK_URL"];
    const target = new URL(url);
    if (
      target.href !== url ||
      target.protocol !== "http:" ||
      target.hostname !== "127.0.0.1" ||
      !target.port ||
      target.pathname !== "/hooks" ||
      target.search ||
      target.hash ||
      target.username ||
      target.password
    )
      return 2;
    if (!/^[a-f0-9]{64}$/u.test(env["FOOM_TOKEN"]) || !/^[a-f0-9-]{36}$/u.test(env["FOOM_SESSION"]))
      return 2;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > 65536) return 2;
      chunks.push(bytes);
    }
    const body = Buffer.concat(chunks);
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    return await new Promise<number>((resolve) => {
      const req = request(
        target,
        {
          method: "POST",
          agent: false,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": body.length,
            Authorization: env["FOOM_TOKEN"],
            "X-Foom-Session": env["FOOM_SESSION"],
            "X-Foom-Channel": channel,
            "X-Foom-Event": event,
          },
        },
        (response) => {
          response.on("error", resolve.bind(undefined, 1));
          response.resume();
          resolve(response.statusCode === 204 ? 0 : 1);
        },
      );
      const timer = setTimeout(() => req.destroy(), 3000);
      req.on("close", () => {
        clearTimeout(timer);
      });
      req.on("error", () => {
        resolve(1);
      });
      req.end(body);
    });
  } catch {
    return 2;
  }
}
