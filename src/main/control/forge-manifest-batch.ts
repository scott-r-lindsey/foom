import type { ForgeManifest, ForgeBatchPlan, ForgeCheckResult } from "../../shared/forge-plugin";
import type { ForgeMatch, ForgeObservation, ForgeRemote, ForgeTransport } from "./forge.d";
import { expandForgeBatchQuery } from "../../shared/forge-batch-query";
import { expandForgeArguments, forgeJson } from "./forge-execution";
import { forgeBranch, forgeTitle, forgeWebUrl, pullRequest } from "./forge";
import { forgeProject, forgeValue, reduceForgeChecks } from "./forge-mapping";

function checkCounts(value: unknown, result: ForgeCheckResult, head: string, number: number) {
  const all = { ...result, required: undefined };
  if (reduceForgeChecks(value, all, head, number) === "unknown") return null;
  const counts = { passed: 0, failed: 0, pending: 0 };
  if (all.nullAt && forgeValue(value, all.nullAt) === null) return counts;
  const rows = forgeValue(value, all.rows);
  const items = all.shape === "object" ? [rows] : rows;
  if (!Array.isArray(items)) return null;
  for (const row of items) {
    const conclusion = reduceForgeChecks(
      [row],
      {
        ...all,
        shape: "array",
        guards: [],
        nullAt: undefined,
        pageComplete: undefined,
        rows: [],
      },
      head,
      number,
    );
    if (conclusion === "unknown") return null;
    if (conclusion === "none") {
      if (all.shape === "object") continue;
      return null;
    }
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
  const mapping = plan.mapping ?? manifest.mapping;
  const projectId = (value: unknown) => {
    const parsed =
      plan.projectIdEncoding === "global-project-id" &&
      typeof value === "string" &&
      /^gid:\/\/gitlab\/Project\/[1-9][0-9]*$/u.test(value)
        ? Number(value.slice("gid://gitlab/Project/".length))
        : plan.projectIdEncoding
          ? undefined
          : value;
    return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0
      ? parsed
      : undefined;
  };
  const observations = new Map<string, ForgeObservation>();
  for (const [index, match] of matches.entries()) {
    // Both trusted Git discovery and the sampled remote default exclude adoption/tracking.
    if (match.branch === defaultBranch || match.branch === reportedDefault) continue;
    let row = forgeValue(repository, [`p${String(index)}`]);
    if (row === undefined) return undefined;
    if (match.number === undefined) {
      const nodes = forgeValue(row, plan.nodes);
      const more = forgeValue(row, plan.pageComplete);
      if (!Array.isArray(nodes) || nodes.length > 2 || typeof more !== "boolean") return undefined;
      if (nodes.length !== 1 || more) continue;
      row = nodes[0];
    } else if (row === null) continue;
    const rawNumber = forgeValue(row, mapping.number);
    const number =
      plan.numberEncoding === "decimal-string"
        ? typeof rawNumber === "string" && /^[1-9][0-9]*$/u.test(rawNumber)
          ? Number(rawNumber)
          : undefined
        : rawNumber;
    const fields = mapping.projects;
    let source = forgeValue(row, plan.sourceProject);
    let sameProject: boolean;
    if (fields.mode === "numeric-project-ids") {
      const sourceId = projectId(forgeValue(row, fields.source));
      const targetId = projectId(forgeValue(row, fields.target));
      const contextId = plan.projectContext
        ? projectId(forgeValue(repository, plan.projectContext))
        : undefined;
      sameProject = sourceId !== undefined && sourceId === targetId && targetId === contextId;
      source = remote.project;
    } else {
      sameProject =
        forgeValue(row, plan.crossProject) === false &&
        typeof source === "string" &&
        forgeProject(source, manifest.remote.namespace) &&
        (manifest.remote.case === "exact"
          ? source === remote.project
          : source.toLowerCase() === remote.project.toLowerCase());
    }
    if (
      !sameProject ||
      typeof source !== "string" ||
      forgeValue(row, mapping.branch) !== match.branch ||
      (match.number !== undefined && number !== match.number)
    )
      continue;
    const rawState = forgeValue(row, mapping.state);
    const pr = pullRequest({
      number,
      headSha: forgeValue(row, mapping.headSha),
      mergeCommit: mapping.mergeCommit ? forgeValue(row, mapping.mergeCommit) : undefined,
      state:
        typeof rawState === "string" && Object.hasOwn(mapping.states, rawState)
          ? mapping.states[rawState]
          : undefined,
      requiredChecks: "unknown",
    });
    if (!pr || (match.number === undefined && pr.state !== "OPEN")) return undefined;
    const title = mapping.title ? forgeTitle(forgeValue(row, mapping.title)) : undefined;
    let url: string | undefined;
    try {
      url = forgeWebUrl(
        expandForgeArguments([plan.webUrl], { ...remote, number: pr.number })[0],
        remote.host,
      );
    } catch {
      // An oversized display template cannot suppress verified checks.
    }
    const requiredChecks =
      match.number === undefined
        ? "unknown"
        : reduceForgeChecks(row, plan.checks, pr.headSha, pr.number);
    observations.set(match.branch, {
      ...pr,
      requiredChecks,
      ...(manifest.requestLabel ? { requestLabel: manifest.requestLabel } : {}),
      ...(manifest.numberPrefix ? { numberPrefix: manifest.numberPrefix } : {}),
      checksMeaning: manifest.checks.meaning,
      ...(title === undefined ? {} : { title }),
      ...(url === undefined ? {} : { url }),
      board: {
        number: pr.number,
        ...(title === undefined ? {} : { title }),
        ...(url === undefined ? {} : { url }),
        sourceName: source,
        ...(manifest.requestLabel ? { requestLabel: manifest.requestLabel } : {}),
        ...(manifest.numberPrefix ? { numberPrefix: manifest.numberPrefix } : {}),
        checksMeaning: manifest.checks.meaning,
        requiredChecks,
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
  const fits = (size: number) => {
    try {
      batchArguments(manifest, remote, matches.slice(0, size));
      return true;
    } catch {
      return false;
    }
  };
  const limit = Math.min(matches.length, 1000);
  let low = 0;
  let high = Math.min(1, limit);
  // Grow from a small request: expanding half of a 1000-checkout fleet just to
  // discover a 16 KiB cap wastes the serial worker's preparation budget.
  while (high < limit && fits(high)) {
    low = high;
    high = Math.min(limit, high * 2);
  }
  while (low < high) {
    const size = Math.ceil((low + high) / 2);
    if (fits(size)) low = size;
    else high = size - 1;
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
    !forgeProject(remote.project, manifest.remote.namespace) ||
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
