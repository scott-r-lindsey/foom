// Shared fake forge CLI. It accepts only the fixed read-only commands Foom uses;
// all data comes from a local fixture. No network or real gh is involved.
const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(process.env.TEST_FORGE_STATE, "utf8"));
if (fixture.error) { process.stderr.write("Forge unavailable"); process.exit(2); }
if (args[0] === "auth" && args.join(" ") === "auth status --hostname github.com") process.exit(fixture.loggedOut ? 1 : 0);
if (args[0] === "api" && args[5]?.startsWith("query=query($owner:")) {
  if (args[1] !== "graphql" || args[2] !== "--hostname" || args[3] !== "github.com") process.exit(2);
  const owner = args.find((arg) => arg.startsWith("owner="))?.slice(6);
  const name = args.find((arg) => arg.startsWith("name="))?.slice(5);
  const headSha = fixture.pr?.headRefOid ?? "a".repeat(40);
  const contexts = fixture.contexts ?? (fixture.checks ?? [{ bucket: "pending" }]).map(({ bucket }) => ({
    __typename: "CheckRun", isRequired: true,
    status: bucket === "pending" ? "IN_PROGRESS" : "COMPLETED",
    conclusion: ({pass: "SUCCESS", fail: "FAILURE", cancel: "CANCELLED", skipping: "SKIPPED"})[bucket] ?? null,
  }));
  const pr = { number: 340, title: "Fixture pull request", headRefOid: headSha, headRefName: "child-one", state: "OPEN",
    headRepository: { nameWithOwner: owner + "/" + name }, isCrossRepository: false,
    commits: { nodes: [{ commit: { oid: headSha, statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: contexts } } } }] }, ...fixture.pr };
  const repository = { defaultBranchRef: { name: "main" } };
  for (const selection of args[5].matchAll(/p([0-9]+): pullRequest/g)) {
    const index = selection[1];
    const branch = args.find((arg) => arg.startsWith("b" + index + "="))?.split("=").slice(1).join("=") ?? pr.headRefName;
    const bound = args[5].includes("p" + index + ": pullRequest(number:");
    repository["p" + index] = bound ? pr : { pageInfo: { hasNextPage: false }, nodes: fixture.absent || branch !== pr.headRefName ? [] : [pr] };
  }
  process.stdout.write(JSON.stringify({ data: { repository } }));
  process.exit(0);
}
if (args[0] === "api") {
  if (args[1] !== "graphql" || args[2] !== "--hostname" || args[3] !== "github.com" ||
      args[4] !== "-f" || !args[5].startsWith("query=query($id: ID!)") ||
      args[6] !== "-f" || args[7] !== "id=PR_test" || args.length !== 8) process.exit(2);
  if (fixture.apiError) process.exit(2);
  const headSha = fixture.pr?.headRefOid ?? "a".repeat(40);
  process.stdout.write(JSON.stringify(fixture.rollup ?? { data: { node: {
    headRefOid: headSha, commits: { nodes: [{ commit: { oid: headSha,
      statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false },
        nodes: fixture.contexts ?? [{ __typename: "CheckRun", isRequired: true, status: "IN_PROGRESS", conclusion: null }] } }
    } }] }
  } } }));
  process.exit(0);
}
if (args[0] !== "pr" || !["list", "view", "checks"].includes(args[1])) process.exit(2);
if (!args.includes("--repo") || !args.includes("--json")) process.exit(2);
// Default fixtures represent a head in the explicitly selected repository.
const owner = args[args.indexOf("--repo") + 1].split("/").at(-2);
const pr = { number: 340, headRefOid: "a".repeat(40), headRefName: "child-one", state: "OPEN", headRepositoryOwner: { login: owner }, isCrossRepository: false, ...fixture.pr };
if (args[1] === "list") process.stdout.write(JSON.stringify(fixture.absent ? [] : [pr]));
if (args[1] === "view") process.stdout.write(JSON.stringify(args.at(-1) === "id" ? { id: "PR_test" } : pr));
if (args[1] === "checks") {
  if (fixture.oldGh) { process.stderr.write("unknown flag: --json"); process.exit(1); }
  if (!args.includes("--required")) process.exit(2);
  if (fixture.checksError) {
    process.stdout.write(fixture.stdout ?? "");
    process.stderr.write(fixture.checksError);
    process.exit(fixture.exitCode ?? 1);
  }
  process.stdout.write(JSON.stringify(fixture.checks ?? [{ bucket: "pending" }]));
  process.exit(fixture.exitCode ?? 0);
}
`;
module.exports = { FAKE_GH };
