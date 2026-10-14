// Shared fake forge CLI. It accepts only the fixed read-only commands Foom uses;
// all data comes from a local fixture. No network or real gh is involved.
const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(process.env.TEST_FORGE_STATE, "utf8"));
if (fixture.error) { process.stderr.write("Forge unavailable"); process.exit(2); }
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
const pr = { number: 340, headRefOid: "a".repeat(40), headRefName: "child-one", state: "OPEN", headRepositoryOwner: { login: "o" }, isCrossRepository: false, ...fixture.pr };
if (args[1] === "list") process.stdout.write(JSON.stringify(fixture.absent ? [] : [pr]));
if (args[1] === "view") process.stdout.write(JSON.stringify(args.at(-1) === "id" ? { id: "PR_test" } : pr));
if (args[1] === "checks") {
  if (fixture.oldGh) { process.stderr.write("unknown flag: --json"); process.exit(1); }
  if (!args.includes("--required")) process.exit(2);
  process.stdout.write(JSON.stringify(fixture.checks ?? [{ bucket: "pending" }]));
  process.exit(fixture.exitCode ?? 0);
}
`;
module.exports = { FAKE_GH };
