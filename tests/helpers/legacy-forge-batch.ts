// Frozen pre-activation batch reference; fixture transports only.
import { forgeBranch, pullRequest, rollupChecks } from "./legacy-forge";
import type { ForgeRunner } from "./legacy-forge";
import type { ForgeMatch, ForgeObservation } from "../../src/main/control/forge.d";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}
const fields = `number title headRefName headRefOid state isCrossRepository
  headRepository { nameWithOwner }`;
function checks(number: number | undefined): string {
  const required = number === undefined ? "" : `isRequired(pullRequestNumber: ${String(number)})`;
  return `commits(last: 1) { nodes { commit { oid statusCheckRollup { contexts(first: 100) {
    pageInfo { hasNextPage } nodes { __typename
      ... on CheckRun { ${required} status conclusion }
      ... on StatusContext { ${required} state }
    }
  } } } } }`;
}

/** One bounded read per repository, with values supplied separately from query syntax. */
export async function batchForge(
  repository: string,
  matches: readonly ForgeMatch[],
  run: ForgeRunner,
): Promise<ReadonlyMap<string, ForgeObservation> | undefined> {
  if (
    matches.length === 0 ||
    matches.length > 1000 ||
    matches.some(
      (match) =>
        !forgeBranch(match.branch) ||
        (match.number !== undefined && (!Number.isSafeInteger(match.number) || match.number <= 0)),
    )
  )
    return undefined;
  const variables = matches
    .flatMap((match, i) => (match.number === undefined ? [`$b${String(i)}: String!`] : []))
    .join(", ");
  const selections = matches
    .map((match, i) =>
      match.number === undefined
        ? `p${String(i)}: pullRequests(headRefName: $b${String(i)}, states: OPEN, first: 2) {
        pageInfo { hasNextPage } nodes { ${fields} ${checks(undefined)} }
      }`
        : `p${String(i)}: pullRequest(number: ${String(match.number)}) { ${fields} ${checks(match.number)} }`,
    )
    .join("\n");
  const [owner, name] = repository.split("/");
  try {
    const output = await run([
      "api",
      "graphql",
      "--hostname",
      "github.com",
      "-f",
      `query=query($owner: String!, $name: String!${variables ? `, ${variables}` : ""}) { repository(owner: $owner, name: $name) {
        defaultBranchRef { name } ${selections}
      } }`,
      "-f",
      `owner=${owner ?? ""}`,
      "-f",
      `name=${name ?? ""}`,
      ...matches.flatMap((match, i) =>
        match.number === undefined ? ["-f", `b${String(i)}=${match.branch}`] : [],
      ),
    ]);
    if (Buffer.byteLength(output) > 256 * 1024) return undefined;
    return parseBatch(JSON.parse(output), repository, matches);
  } catch {
    return undefined;
  }
}

export function parseBatch(
  value: unknown,
  repository: string,
  matches: readonly ForgeMatch[],
): ReadonlyMap<string, ForgeObservation> | undefined {
  const response = record(value);
  if (!response || response["errors"] !== undefined) return undefined;
  const data = record(record(response["data"])?.["repository"]);
  const defaultBranch = record(data?.["defaultBranchRef"])?.["name"];
  if (!data || !forgeBranch(defaultBranch)) return undefined;
  const result = new Map<string, ForgeObservation>();
  for (const [i, match] of matches.entries()) {
    if (match.branch === defaultBranch) continue;
    let raw = data[`p${String(i)}`];
    if (match.number === undefined) {
      const connection = record(raw);
      const nodes = connection?.["nodes"];
      if (
        !Array.isArray(nodes) ||
        nodes.length > 2 ||
        typeof record(connection?.["pageInfo"])?.["hasNextPage"] !== "boolean"
      )
        return undefined;
      if (nodes.length !== 1 || record(connection?.["pageInfo"])?.["hasNextPage"] !== false)
        continue;
      raw = nodes[0];
    } else if (raw === null) continue;
    const row = record(raw);
    if (
      !row ||
      row["isCrossRepository"] !== false ||
      typeof record(row["headRepository"])?.["nameWithOwner"] !== "string" ||
      String(record(row["headRepository"])?.["nameWithOwner"]).toLowerCase() !==
        repository.toLowerCase() ||
      row["headRefName"] !== match.branch ||
      (match.number !== undefined && row["number"] !== match.number)
    )
      continue;
    const pr = pullRequest({
      number: row["number"],
      headSha: row["headRefOid"],
      state: row["state"],
      requiredChecks: "unknown",
    });
    const title = row["title"];
    if (
      !pr ||
      typeof title !== "string" ||
      title.length > 1024 ||
      /[\p{Cc}\p{Cf}]/u.test(title) ||
      (match.number === undefined && pr.state !== "OPEN")
    )
      return undefined;
    const required =
      match.number === undefined ? "unknown" : rollupChecks({ data: { node: row } }, pr.headSha);
    result.set(match.branch, {
      ...pr,
      requiredChecks: required,
      board: {
        number: pr.number,
        title,
        url: `https://github.com/${repository}/pull/${String(pr.number)}`,
        state: pr.state,
        checks: checkCounts(row, pr.headSha),
      },
    });
  }
  return result;
}

function checkCounts(row: Record<string, unknown>, head: string) {
  const commits = record(row["commits"])?.["nodes"];
  if (!Array.isArray(commits) || commits.length !== 1) return null;
  const commit = record(record(commits[0])?.["commit"]);
  if (commit?.["oid"] !== head) return null;
  const counts = { passed: 0, failed: 0, pending: 0 };
  if (commit["statusCheckRollup"] === null) return counts;
  const contexts = record(record(commit["statusCheckRollup"])?.["contexts"]);
  const nodes = contexts?.["nodes"];
  if (
    record(contexts?.["pageInfo"])?.["hasNextPage"] !== false ||
    !Array.isArray(nodes) ||
    nodes.length > 100
  )
    return null;
  for (const item of nodes) {
    const check = record(item);
    if (!check) return null;
    // Reuse the required-check validator with a single required context.
    const conclusion = rollupChecks(
      {
        data: {
          node: {
            headRefOid: head,
            commits: {
              nodes: [
                {
                  commit: {
                    oid: head,
                    statusCheckRollup: {
                      contexts: {
                        pageInfo: { hasNextPage: false },
                        nodes: [{ ...check, isRequired: true }],
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      },
      head,
    );
    if (conclusion === "unknown" || conclusion === "none") return null;
    counts[conclusion === "success" ? "passed" : conclusion === "failure" ? "failed" : "pending"]++;
  }
  return counts;
}
