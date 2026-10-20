import type { ForgeManifest, ForgeBatchPlan, ForgeCheckResult } from "../../shared/forge-plugin";
import type { ForgeMatch, ForgeObservation, ForgeRemote, ForgeTransport } from "./forge.d";
import { expandForgeBatchQuery } from "../../shared/forge-batch-query";
import { expandForgeArguments, forgeJson } from "./forge-execution";
import { forgeBranch, pullRequest } from "./forge";
import { forgeProject, forgeValue, reduceForgeChecks } from "./forge-mapping";

function checkCounts(value: unknown, result: ForgeCheckResult, head: string, number: number) {
  const all = { ...result, required: undefined };
  if (reduceForgeChecks(value, all, head, number) === "unknown") return null;
  const counts = { passed: 0, failed: 0, pending: 0 };
  if (all.nullAt && forgeValue(value, all.nullAt) === null) return counts;
  const rows = forgeValue(value, all.rows);
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    const conclusion = reduceForgeChecks(
      [row],
      {
        ...all,
        guards: [],
        nullAt: undefined,
        pageComplete: undefined,
        rows: [],
      },
      head,
      number,
    );
    if (conclusion === "unknown" || conclusion === "none") return null;
    counts[conclusion === "success" ? "passed" : conclusion === "failure" ? "failed" : "pending"]++;
  }
  return counts;
}

function parseManifestBatch(
  value: unknown,
  manifest: ForgeManifest,
  plan: ForgeBatchPlan,
  remote: ForgeRemote,
  matches: readonly ForgeMatch[],
  defaultBranch: string | undefined,
) {
  if (forgeValue(value, ["errors"]) !== undefined) return undefined;
  const repository = forgeValue(value, plan.repository);
  const reportedDefault = forgeValue(repository, plan.defaultBranch);
  if (!forgeBranch(reportedDefault)) return undefined;
  const observations = new Map<string, ForgeObservation>();
  for (const [index, match] of matches.entries()) {
    // Both trusted Git discovery and the sampled remote default exclude adoption/tracking.
    if (match.branch === defaultBranch || match.branch === reportedDefault) continue;
    let row = forgeValue(repository, [`p${String(index)}`]);
    if (match.number === undefined) {
      const nodes = forgeValue(row, plan.nodes);
      const more = forgeValue(row, plan.pageComplete);
      if (!Array.isArray(nodes) || nodes.length > 2 || typeof more !== "boolean") return undefined;
      if (nodes.length !== 1 || more) continue;
      row = nodes[0];
    } else if (row === null) continue;
    const source = forgeValue(row, plan.sourceProject);
    if (
      forgeValue(row, plan.crossProject) !== false ||
      typeof source !== "string" ||
      !forgeProject(source, manifest.remote.namespace) ||
      (manifest.remote.case === "exact"
        ? source !== remote.project
        : source.toLowerCase() !== remote.project.toLowerCase()) ||
      forgeValue(row, manifest.mapping.branch) !== match.branch ||
      (match.number !== undefined && forgeValue(row, manifest.mapping.number) !== match.number)
    )
      continue;
    const rawState = forgeValue(row, manifest.mapping.state);
    const pr = pullRequest({
      number: forgeValue(row, manifest.mapping.number),
      headSha: forgeValue(row, manifest.mapping.headSha),
      mergeCommit: manifest.mapping.mergeCommit
        ? forgeValue(row, manifest.mapping.mergeCommit)
        : undefined,
      state:
        typeof rawState === "string" && Object.hasOwn(manifest.mapping.states, rawState)
          ? manifest.mapping.states[rawState]
          : undefined,
      requiredChecks: "unknown",
    });
    const title = manifest.mapping.title ? forgeValue(row, manifest.mapping.title) : undefined;
    if (
      !pr ||
      typeof title !== "string" ||
      title.length > 1024 ||
      /[\p{Cc}\p{Cf}]/u.test(title) ||
      (match.number === undefined && pr.state !== "OPEN")
    )
      return undefined;
    const url = expandForgeArguments([plan.webUrl], { ...remote, number: pr.number })[0];
    if (!url || url.length > 4096 || !url.startsWith(`https://${remote.host}/`)) return undefined;
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== remote.host ||
      parsed.username ||
      parsed.password ||
      parsed.port
    )
      return undefined;
    observations.set(match.branch, {
      ...pr,
      requiredChecks:
        match.number === undefined
          ? "unknown"
          : reduceForgeChecks(row, plan.checks, pr.headSha, pr.number),
      board: {
        number: pr.number,
        title,
        url,
        state: pr.state,
        checks: checkCounts(row, plan.checks, pr.headSha, pr.number),
      },
    });
  }
  return observations;
}

/** Measure the exact request that will execute, including generated raw-field variables. */
function batchArguments(
  manifest: ForgeManifest,
  remote: ForgeRemote,
  matches: readonly ForgeMatch[],
) {
  const plan = manifest.operations.batchStatus;
  if (!plan) throw new Error("Missing batch plan");
  const [projectOwner, projectName] = remote.project.split("/");
  const query = expandForgeBatchQuery(
    plan.query,
    plan.discovery,
    plan.bound,
    matches.map((match) => match.number),
  );
  const argv = expandForgeArguments(plan.command.argv, {
    ...remote,
    query,
    ...(projectOwner === undefined ? {} : { projectOwner }),
    ...(projectName === undefined ? {} : { projectName }),
  });
  // This append form is part of the closed GraphQL raw-field command grammar.
  argv.push(
    ...matches.flatMap((match, index) =>
      match.number === undefined ? ["-f", `b${String(index)}=${match.branch}`] : [],
    ),
  );
  if (argv.length > 64 || argv.reduce((size, arg) => size + Buffer.byteLength(arg), 0) > 65536)
    throw new Error("Batch arguments too large");
  return argv;
}

/** Largest prefix within the query and argv caps. Scheduling stays in the serial tracker. */
export function manifestBatchSize(
  manifest: ForgeManifest,
  remote: ForgeRemote,
  matches: readonly ForgeMatch[],
): number {
  let low = 0;
  let high = Math.min(matches.length, 1000);
  while (low < high) {
    const size = Math.ceil((low + high) / 2);
    try {
      batchArguments(manifest, remote, matches.slice(0, size));
      low = size;
    } catch {
      high = size - 1;
    }
  }
  return low;
}

/** One bounded argv-array request; no CLI execution, retries or scheduling in the interpreter. */
export async function manifestForgeBatch(
  manifest: ForgeManifest,
  remote: ForgeRemote,
  transport: ForgeTransport,
  matches: readonly ForgeMatch[],
  defaultBranch?: string,
): Promise<ReadonlyMap<string, ForgeObservation> | undefined> {
  const plan = manifest.operations.batchStatus;
  if (
    !plan ||
    !forgeProject(remote.project, "pair") ||
    matches.length === 0 ||
    matches.length > 1000 ||
    new Set(matches.map((match) => match.branch)).size !== matches.length ||
    matches.some(
      (match) =>
        !forgeBranch(match.branch) ||
        (match.number !== undefined && (!Number.isSafeInteger(match.number) || match.number <= 0)),
    )
  )
    return undefined;
  try {
    const argv = batchArguments(manifest, remote, matches);
    const value = forgeJson(await transport(argv), plan.command);
    return parseManifestBatch(value, manifest, plan, remote, matches, defaultBranch);
  } catch {
    return undefined;
  }
}
