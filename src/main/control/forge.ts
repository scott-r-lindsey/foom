import { batchForge } from "./forge-batch";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ForgeProvider, PullRequest } from "./forge.d";

const execute = promisify(execFile);
const FIELDS =
  "number,headRefOid,headRefName,state,headRepositoryOwner,isCrossRepository,mergeCommit";
export type ForgeRunner = (args: readonly string[]) => Promise<string>;

/** Fail closed without surfacing CLI diagnostics (which can contain credentials). */
export const runForge: ForgeRunner = async (args) => {
  try {
    const result = await execute("gh", [...args], {
      timeout: 10000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat" },
    });
    return result.stdout;
  } catch (error) {
    // gh reports an empty required set before its JSON exporter runs.
    if (
      args[0] === "pr" &&
      args[1] === "checks" &&
      args.includes("--required") &&
      error instanceof Error &&
      "code" in error &&
      error.code === 1 &&
      "stdout" in error &&
      error.stdout === "" &&
      "stderr" in error &&
      typeof error.stderr === "string"
    ) {
      const match = /^no (?:required )?checks reported on the '(.+)' branch\r?\n?$/u.exec(
        error.stderr,
      );
      if (forgeBranch(match?.[1])) return "[]";
    }
    // `pr checks` exits 1 for failed checks and 8 for pending checks, with valid JSON.
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === 1 || error.code === 8) &&
      "stdout" in error &&
      typeof error.stdout === "string" &&
      error.stdout.trimStart().startsWith("[")
    )
      return error.stdout;
    throw new Error("Forge unavailable", { cause: error });
  }
};

export function forgeBranch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    !value.startsWith("-") &&
    !/[\p{Cc}\p{Cf}\s~^:?*[\\]/u.test(value) &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.endsWith(".") &&
    value
      .split("/")
      .every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"))
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function sameRepository(data: Record<string, unknown>, selected: string): boolean {
  const owner = record(data["headRepositoryOwner"])?.["login"];
  return (
    data["isCrossRepository"] === false &&
    typeof owner === "string" &&
    owner.toLowerCase() === selected.split("/")[0]?.toLowerCase()
  );
}

/** Whitelist persisted and public metadata as well as network output. */
export function pullRequest(value: unknown): PullRequest | undefined {
  const data = record(value);
  if (
    !data ||
    typeof data["number"] !== "number" ||
    !Number.isSafeInteger(data["number"]) ||
    data["number"] <= 0 ||
    typeof data["headSha"] !== "string" ||
    !/^[a-f0-9]{40}$/u.test(data["headSha"]) ||
    (data["state"] !== "OPEN" && data["state"] !== "CLOSED" && data["state"] !== "MERGED") ||
    (data["requiredChecks"] !== "pending" &&
      data["requiredChecks"] !== "success" &&
      data["requiredChecks"] !== "failure" &&
      data["requiredChecks"] !== "none" &&
      data["requiredChecks"] !== "unknown")
  )
    return undefined;
  return {
    number: data["number"],
    headSha: data["headSha"],
    ...(typeof data["mergeCommit"] === "string" && /^[a-f0-9]{40,64}$/u.test(data["mergeCommit"])
      ? { mergeCommit: data["mergeCommit"] }
      : {}),
    state: data["state"],
    requiredChecks: data["requiredChecks"],
  };
}

export function requiredChecks(value: unknown): PullRequest["requiredChecks"] | undefined {
  if (!Array.isArray(value) || value.length > 1000) return undefined;
  const buckets: string[] = [];
  for (const item of value) {
    const bucket = record(item)?.["bucket"];
    if (
      typeof bucket !== "string" ||
      !["pass", "fail", "pending", "skipping", "cancel"].includes(bucket)
    )
      return undefined;
    buckets.push(bucket);
  }
  if (buckets.some((bucket) => bucket === "fail" || bucket === "cancel")) return "failure";
  if (buckets.includes("pending")) return "pending";
  return buckets.length === 0 ? "none" : "success";
}

/** Only github.com is recognized; unfamiliar/enterprise hosts await a provider. */
export function githubRepository(remote: string): string | undefined {
  const match =
    /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u.exec(
      remote,
    );
  const owner = match?.[1];
  const name = match?.[2];
  return owner &&
    name &&
    !owner.startsWith(".") &&
    !owner.startsWith("-") &&
    !name.startsWith(".") &&
    !name.startsWith("-")
    ? `${owner}/${name}`
    : undefined;
}

export function forgeProvider(
  remote: string,
  runner: ForgeRunner = runForge,
): ForgeProvider | undefined {
  const selected = githubRepository(remote);
  if (!selected) return undefined;
  const repository = `github.com/${selected}`;
  return {
    batch: (matches) => batchForge(selected, matches, runner),
    async resolve(number) {
      if (!Number.isSafeInteger(number) || number <= 0) return undefined;
      try {
        const data = record(
          JSON.parse(
            await runner([
              "pr",
              "view",
              String(number),
              "--repo",
              repository,
              "--json",
              "number,headRefName,state,headRepositoryOwner,isCrossRepository",
            ]),
          ),
        );
        const owner = record(data?.["headRepositoryOwner"])?.["login"];
        if (
          !data ||
          data["number"] !== number ||
          typeof data["headRefName"] !== "string" ||
          !["OPEN", "CLOSED", "MERGED"].includes(String(data["state"])) ||
          typeof owner !== "string" ||
          typeof data["isCrossRepository"] !== "boolean"
        )
          return undefined;
        const state = data["state"];
        if (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") return undefined;
        return {
          branch: data["headRefName"],
          state,
          sameRepository: sameRepository(data, selected),
        };
      } catch {
        return undefined;
      }
    },
    async lookup(branch, number, state = "open") {
      if (
        !forgeBranch(branch) ||
        (number !== undefined && (!Number.isSafeInteger(number) || number <= 0))
      )
        return undefined;
      try {
        const output = await runner(
          number === undefined
            ? [
                "pr",
                "list",
                "--repo",
                repository,
                "--head",
                branch,
                "--state",
                state,
                "--limit",
                "2",
                "--json",
                FIELDS,
              ]
            : ["pr", "view", String(number), "--repo", repository, "--json", FIELDS],
        );
        const parsed: unknown = JSON.parse(output);
        // Ambiguous branch matches must never bind an arbitrary PR.
        const data = record(
          number === undefined
            ? Array.isArray(parsed) && parsed.length === 1
              ? parsed[0]
              : undefined
            : parsed,
        );
        if (
          !data ||
          !sameRepository(data, selected) ||
          data["headRefName"] !== branch ||
          (number !== undefined && data["number"] !== number)
        )
          return undefined;
        const candidate = pullRequest({
          number: data["number"],
          headSha: data["headRefOid"],
          mergeCommit: record(data["mergeCommit"])?.["oid"],
          state: data["state"],
          requiredChecks: "none",
        });
        if (!candidate || (number === undefined && state === "open" && candidate.state !== "OPEN"))
          return undefined;
        const conclusion = await checkConclusion(runner, repository, candidate);
        // Verify that a concurrent push did not associate checks with the old head.
        const verified: unknown = JSON.parse(
          await runner([
            "pr",
            "view",
            String(candidate.number),
            "--repo",
            repository,
            "--json",
            FIELDS,
          ]),
        );
        const head = record(verified);
        if (
          !head ||
          !sameRepository(head, selected) ||
          head["headRefOid"] !== candidate.headSha ||
          head["headRefName"] !== branch ||
          head["number"] !== candidate.number ||
          head["state"] !== candidate.state ||
          record(head["mergeCommit"])?.["oid"] !== record(data["mergeCommit"])?.["oid"]
        )
          return undefined;
        return { ...candidate, requiredChecks: conclusion };
      } catch {
        return undefined;
      }
    },
  };
}

// The same isRequired query used by gh 2.45's non-JSON `pr checks` command.
// Variables are data; the query is fixed and contains no mutations.
const CHECK_QUERY = `query($id: ID!) {
  node(id: $id) { ... on PullRequest {
    headRefOid
    commits(last: 1) { nodes { commit {
      oid
      statusCheckRollup { contexts(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          __typename
          ... on CheckRun { isRequired(pullRequestId: $id) status conclusion }
          ... on StatusContext { isRequired(pullRequestId: $id) state }
        }
      } }
    } } }
  } }
}`;

async function checkConclusion(
  runner: ForgeRunner,
  repository: string,
  candidate: PullRequest,
): Promise<PullRequest["requiredChecks"]> {
  try {
    const checks: unknown = JSON.parse(
      await runner([
        "pr",
        "checks",
        String(candidate.number),
        "--repo",
        repository,
        "--required",
        "--json",
        "bucket",
      ]),
    );
    return requiredChecks(checks) ?? "unknown";
  } catch {
    // Unsupported flags, CLI/API failures and diagnostics never hide a valid PR.
    try {
      const identity: unknown = JSON.parse(
        await runner([
          "pr",
          "view",
          String(candidate.number),
          "--repo",
          repository,
          "--json",
          "id",
        ]),
      );
      const id = record(identity)?.["id"];
      if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_+/=-]{0,199}$/u.test(id))
        return "unknown";
      const response: unknown = JSON.parse(
        await runner([
          "api",
          "graphql",
          "--hostname",
          "github.com",
          "-f",
          `query=${CHECK_QUERY}`,
          "-f",
          `id=${id}`,
        ]),
      );
      return rollupChecks(response, candidate.headSha);
    } catch {
      return "unknown";
    }
  }
}

export function rollupChecks(value: unknown, headSha: string): PullRequest["requiredChecks"] {
  const response = record(value);
  if (!response || response["errors"] !== undefined) return "unknown";
  const node = record(record(response["data"])?.["node"]);
  const commits = record(node?.["commits"])?.["nodes"];
  if (node?.["headRefOid"] !== headSha || !Array.isArray(commits) || commits.length !== 1)
    return "unknown";
  const commit = record(record(commits[0])?.["commit"]);
  if (commit?.["oid"] !== headSha) return "unknown";
  // GitHub returns null when the verified head commit has no check contexts.
  if (commit["statusCheckRollup"] === null) return "none";
  const contexts = record(record(commit["statusCheckRollup"])?.["contexts"]);
  const nodes = contexts?.["nodes"];
  // Refuse partial pages: optional checks must never obscure a required failure.
  if (
    record(contexts?.["pageInfo"])?.["hasNextPage"] !== false ||
    !Array.isArray(nodes) ||
    nodes.length > 100
  )
    return "unknown";
  const buckets: { bucket: string }[] = [];
  for (const item of nodes) {
    const check = record(item);
    if (!check || typeof check["isRequired"] !== "boolean") return "unknown";
    if (!check["isRequired"]) continue;
    let state: unknown;
    if (check["__typename"] === "CheckRun") {
      const status = check["status"];
      if (
        typeof status !== "string" ||
        !["COMPLETED", "IN_PROGRESS", "QUEUED", "PENDING", "WAITING", "REQUESTED"].includes(status)
      )
        return "unknown";
      state = check["status"] === "COMPLETED" ? check["conclusion"] : "PENDING";
    } else if (check["__typename"] === "StatusContext") state = check["state"];
    else return "unknown";
    if (typeof state !== "string") return "unknown";
    const bucket = {
      SUCCESS: "pass",
      NEUTRAL: "pass",
      SKIPPED: "skipping",
      FAILURE: "fail",
      ERROR: "fail",
      TIMED_OUT: "fail",
      ACTION_REQUIRED: "fail",
      STARTUP_FAILURE: "fail",
      STALE: "fail",
      CANCELLED: "cancel",
      PENDING: "pending",
    };
    const result = record(bucket)?.[state];
    if (typeof result !== "string") return "unknown";
    buckets.push({ bucket: result });
  }
  return requiredChecks(buckets) ?? "unknown";
}
