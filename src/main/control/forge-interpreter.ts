import type { ForgeCommand, ForgeManifest, ForgePlan } from "../../shared/forge-plugin";
import type {
  ForgeBindings,
  ForgeProvider,
  ForgeRemote,
  ForgeTransport,
  PullRequest,
} from "./forge.d";
import { forgeBranch, pullRequest } from "./forge";
import { forgeIdentity, forgeValue, reduceForgeChecks } from "./forge-mapping";
import { manifestForgeBatch } from "./forge-manifest-batch";
import { expandForgeArguments, forgeJson } from "./forge-execution";

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
    ...(manifest.operations.batchStatus
      ? ({
          batch: (matches) =>
            manifestForgeBatch(manifest, remote, transport, matches, defaultBranch),
        } satisfies Pick<ForgeProvider, "batch">)
      : {}),
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
          mergeCommit: manifest.mapping.mergeCommit
            ? forgeValue(row, manifest.mapping.mergeCommit)
            : undefined,
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
          forgeValue(refreshed, manifest.mapping.headSha) !== candidate.headSha ||
          (manifest.mapping.mergeCommit !== undefined &&
            forgeValue(refreshed, manifest.mapping.mergeCommit) !==
              forgeValue(row, manifest.mapping.mergeCommit))
        )
          return undefined;
        return { ...candidate, requiredChecks };
      } catch {
        return undefined;
      }
    },
  };
}
