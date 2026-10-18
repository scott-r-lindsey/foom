import type {
  ForgeArgument,
  ForgeCommand,
  ForgeManifest,
  ForgePlan,
  ForgeSlot,
} from "../../shared/forge-plugin";
import type {
  ForgeBindings,
  ForgeProvider,
  ForgeRemote,
  ForgeResponse,
  ForgeTransport,
  PullRequest,
} from "./forge.d";
import { forgeBranch, pullRequest } from "./forge";
import { forgeIdentity, forgeProject, forgeValue, reduceForgeChecks } from "./forge-mapping";
import { forgeHost } from "../../shared/forge-manifest";

export function expandForgeArguments(
  argv: readonly ForgeArgument[],
  bindings: ForgeBindings,
): string[] {
  const slot = (name: ForgeSlot): string => {
    const value = bindings[name];
    let valid: boolean;
    switch (name) {
      case "host":
        valid = typeof value === "string" && forgeHost(value);
        break;
      case "project":
        valid = typeof value === "string" && forgeProject(value, "nested");
        break;
      case "branch":
        valid = forgeBranch(value);
        break;
      case "number":
        valid = typeof value === "number" && Number.isSafeInteger(value) && value > 0;
        break;
      case "nodeId":
        valid = typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_+/=-]{0,199}$/u.test(value);
        break;
      case "query":
        valid = typeof value === "string" && Buffer.byteLength(value) <= 16384;
        break;
    }
    if (!valid || value === undefined) throw new Error("Invalid forge binding");
    return String(value);
  };
  const result = argv.map((arg) => {
    const query =
      typeof arg !== "string" &&
      arg.parts.some((part) => typeof part !== "string" && part.slot === "query");
    const expanded =
      typeof arg === "string"
        ? arg
        : arg.parts
            .map((part) =>
              typeof part === "string"
                ? part
                : part.encoding === "percent-component"
                  ? encodeURIComponent(slot(part.slot))
                  : slot(part.slot),
            )
            .join("");
    if (
      !expanded ||
      Buffer.byteLength(expanded) > 20480 ||
      (query
        ? /[^\P{Cc}\n\t]|[\p{Cf}\p{Co}\p{Cs}\u2028\u2029]/u
        : /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\u2028\u2029]/u
      ).test(expanded)
    )
      throw new Error("Invalid forge argument");
    return expanded;
  });
  if (result.reduce((total, arg) => total + Buffer.byteLength(arg), 0) > 65536)
    throw new Error("Forge arguments too large");
  return result;
}
export function forgeJson(response: ForgeResponse, command: ForgeCommand): unknown {
  if (
    Buffer.byteLength(response.stdout) > 256 * 1024 ||
    Buffer.byteLength(response.stderr) > 256 * 1024
  )
    throw new Error("Forge output too large");
  if (response.stdout === "") {
    for (const diagnostic of command.emptyDiagnostics) {
      const message = response.stderr.replace(/\r?\n$/u, "");
      if (
        response.code === diagnostic.exitCode &&
        message.startsWith(diagnostic.prefix) &&
        message.endsWith(diagnostic.suffix) &&
        forgeBranch(message.slice(diagnostic.prefix.length, -diagnostic.suffix.length))
      )
        return [];
    }
  }
  if (!command.jsonExitCodes.includes(response.code)) throw new Error("Forge unavailable");
  const parsed: unknown = JSON.parse(response.stdout);
  if (response.code !== 0 && !Array.isArray(parsed)) throw new Error("Invalid forge result");
  return parsed;
}
/** Fixed workflow; ownership and final identity checks cannot be changed by output tables. */
export function manifestForgeProvider(
  manifest: ForgeManifest,
  remote: ForgeRemote,
  transport: ForgeTransport,
  defaultBranch?: string,
): ForgeProvider {
  const execute = async (command: ForgeCommand, bindings: ForgeBindings) =>
    forgeJson(await transport(expandForgeArguments(command.argv, bindings)), command);
  const base = { host: remote.host, project: remote.project };
  const identity = (row: unknown) => forgeIdentity(manifest, row, remote);
  async function checks(plan: ForgePlan, candidate: PullRequest) {
    let nodeId: string | undefined;
    let value: unknown;
    for (const command of plan.commands) {
      value = await execute(command, {
        ...base,
        number: candidate.number,
        ...(nodeId === undefined ? {} : { nodeId }),
        ...(plan.query === undefined ? {} : { query: plan.query }),
      });
      if (command.bindNodeId) {
        const bound = forgeValue(value, command.bindNodeId);
        if (typeof bound !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_+/=-]{0,199}$/u.test(bound))
          throw new Error("Invalid node identity");
        nodeId = bound;
      }
    }
    return reduceForgeChecks(value, plan.result, candidate.headSha, candidate.number);
  }
  return {
    async resolve(number) {
      if (!Number.isSafeInteger(number) || number <= 0) return undefined;
      try {
        const row = await execute(manifest.operations.resolveNumber, { ...base, number });
        const resolved = identity(row);
        if (!resolved || resolved.number !== number) return undefined;
        return {
          branch: resolved.branch,
          state: resolved.state,
          sameRepository: resolved.sameRepository,
        };
      } catch {
        return undefined;
      }
    },
    async lookup(branch, number, state = "open") {
      if (
        !forgeBranch(branch) ||
        branch === defaultBranch ||
        (number !== undefined && (!Number.isSafeInteger(number) || number <= 0))
      )
        return undefined;
      try {
        const raw = await execute(
          number === undefined
            ? manifest.operations.lookupByBranch[state]
            : manifest.operations.refresh,
          { ...base, branch, ...(number === undefined ? {} : { number }) },
        );
        const row: unknown =
          number === undefined
            ? Array.isArray(raw) && raw.length === 1
              ? raw[0]
              : undefined
            : raw;
        const found = identity(row);
        if (
          !found ||
          !found.sameRepository ||
          found.branch !== branch ||
          (number !== undefined && found.number !== number) ||
          (number === undefined && state === "open" && found.state !== "OPEN")
        )
          return undefined;
        const candidate = pullRequest({
          number: found.number,
          headSha: forgeValue(row, manifest.mapping.headSha),
          state: found.state,
          requiredChecks: "unknown",
        });
        if (!candidate) return undefined;
        let requiredChecks: PullRequest["requiredChecks"] = "unknown";
        try {
          requiredChecks = await checks(manifest.checks.primary, candidate);
        } catch {
          if (manifest.checks.fallback) {
            try {
              requiredChecks = await checks(manifest.checks.fallback, candidate);
            } catch {
              /* Unknown checks preserve PR identity. */
            }
          }
        }
        const refreshed = await execute(manifest.operations.refresh, {
          ...base,
          number: candidate.number,
        });
        const verified = identity(refreshed);
        if (
          !verified ||
          !verified.sameRepository ||
          verified.branch !== branch ||
          verified.number !== candidate.number ||
          verified.state !== candidate.state ||
          forgeValue(refreshed, manifest.mapping.headSha) !== candidate.headSha
        )
          return undefined;
        return { ...candidate, requiredChecks };
      } catch {
        return undefined;
      }
    },
  };
}
