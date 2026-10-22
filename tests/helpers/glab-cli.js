// Offline glab fixture. Recorded envelopes retain their provenance; synthetic discovery
// wrappers/default-branch context and explicit test overrides are never live captures.
const { readFileSync } = require("node:fs");
const path = require("node:path");
function recordedGitlab() {
  const capture = (name) =>
    JSON.parse(
      JSON.parse(
        readFileSync(
          path.resolve(
            __dirname,
            `../../spikes/forge-manifests/fixtures/glab-${name}-recorded.json`,
          ),
          "utf8",
        ),
      ).stdout,
    );
  const scenarios = [
    "pending",
    "success",
    "failed",
    "manual",
    "skipped",
    "no-pipeline",
    "merged",
    "closed",
    "skipped-pipeline",
  ];
  return {
    rest: scenarios.map((name) => capture(`${name}-rest`)),
    rows: [
      ...Object.values(capture("batch").data.project),
      ...Object.values(capture("batch-skipped").data.project).filter((row) => row.iid === "9"),
    ],
  };
}
const FAKE_GLAB = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(process.env.TEST_FORGE_STATE, "utf8"));
if (process.env.TEST_FORGE_LOG) fs.appendFileSync(process.env.TEST_FORGE_LOG, JSON.stringify(args) + "\\n");
if (fixture.error) process.exit(2);
if (args.join(" ") === "auth status --hostname " + (fixture.host ?? "gitlab.com")) {
  if (fixture.loggedOut) process.stderr.write("No token provided");
  process.exit(0);
}
if (args[0] !== "api" || args[2] !== "--hostname" || args[3] !== (fixture.host ?? "gitlab.com")) process.exit(2);
if (args[1] === "graphql") {
  if (fixture.apiError) process.exit(1);
  if (args[4] !== "-f" || !args[5]?.startsWith("query=") || args[6] !== "-f" || !args[7]?.startsWith("project=")) process.exit(2);
  const project = { id: fixture.rows[0].targetProject.id, repository: { rootRef: "main" } };
  for (const selection of args[5].matchAll(/p([0-9]+): mergeRequest(s?)\\(/g)) {
    const index = selection[1];
    const branch = args.find(arg => arg.startsWith("b" + index + "="))?.slice(index.length + 2);
    const number = new RegExp('p' + index + ': mergeRequest\\\\(iid: "([0-9]+)"').exec(args[5])?.[1];
    const rows = fixture.rows.filter(row => selection[2] ? row.sourceBranch === branch && row.state === "opened" : row.iid === number);
    for (const row of rows) if (fixture.pipelineStatus && row.headPipeline) row.headPipeline.status = fixture.pipelineStatus;
    project["p" + index] = selection[2] ? { nodes: rows, pageInfo: { hasNextPage: false } } : rows[0] ?? null;
  }
  process.stdout.write(JSON.stringify({ data: { project } }));
  process.exit(0);
}
if (args[4] !== "--method" || args[5] !== "GET") process.exit(2);
const endpoint = /^projects\\/[^/]+\\/merge_requests(?:\\/([0-9]+))?$/.exec(args[1]);
if (!endpoint) process.exit(2);
if (endpoint[1]) {
  const row = fixture.rest.find(row => String(row.iid) === endpoint[1]);
  if (!row) process.exit(1);
  process.stdout.write(JSON.stringify(row));
} else {
  const branch = args.find(arg => arg.startsWith("source_branch="))?.slice(14);
  process.stdout.write(JSON.stringify(fixture.rest.filter(row => row.source_branch === branch && (!args.includes("state=opened") || row.state === "opened")).slice(0, 2)));
}
`;
module.exports = { FAKE_GLAB, recordedGitlab };
