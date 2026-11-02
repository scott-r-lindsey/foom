import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { HostBuildFact } from "../../shared/registered-hosts.d";
import { record } from "../../shared/remote-agent-protocol";
import { hostProbe } from "./agent-discovery";

/** Declared requirements only. Never run package scripts or install dependencies. */
export async function buildFacts(
  checkout: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<HostBuildFact[]> {
  const facts: HostBuildFact[] = [];
  try {
    const file = await open(
      join(checkout, "package.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let manifest: unknown;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 65536) return facts;
      const buffer = Buffer.alloc(65537);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 65536) return facts;
      manifest = JSON.parse(buffer.toString("utf8", 0, bytesRead));
    } finally {
      await file.close();
    }
    if (!record(manifest)) return facts;
    const engines = manifest["engines"];
    const node = record(engines) ? engines["node"] : undefined;
    if (typeof node === "string" && /^[a-zA-Z0-9.*+^~|<>= .-]{1,128}$/u.test(node))
      facts.push({ tool: "node", required: node });
    const manager = manifest["packageManager"];
    const match =
      typeof manager === "string"
        ? /^(npm|pnpm|yarn|bun)@([0-9][a-zA-Z0-9.+-]{0,127})$/u.exec(manager)
        : null;
    const tool = match?.[1];
    if (tool === "npm" || tool === "pnpm" || tool === "yarn" || tool === "bun")
      facts.push({ tool, required: match?.[2] ?? "" });
    for (const fact of facts) {
      try {
        const version = (
          await hostProbe(
            fact.tool,
            ["--version"],
            checkout,
            { ...env, COREPACK_ENABLE_NETWORK: "0", COREPACK_ENABLE_AUTO_PIN: "0" },
            false,
            5000,
            signal,
          )
        )
          .trim()
          .replace(/^v/u, "");
        if (/^[0-9][a-zA-Z0-9.+-]{0,63}$/u.test(version)) fact.version = version;
      } catch {
        signal?.throwIfAborted();
      }
    }
  } catch {
    signal?.throwIfAborted();
  }
  return facts;
}
