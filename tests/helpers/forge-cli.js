// Shared fake forge CLI. It accepts only the fixed read-only commands Foom uses;
// all data comes from a local fixture. No network or real gh is involved.
const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(process.env.TEST_FORGE_STATE, "utf8"));
if (fixture.error) { process.stderr.write("Forge unavailable"); process.exit(2); }
if (args[0] !== "pr" || !["list", "view", "checks"].includes(args[1])) process.exit(2);
if (!args.includes("--repo") || !args.includes("--json")) process.exit(2);
const pr = { number: 340, headRefOid: "a".repeat(40), headRefName: "child-one", state: "OPEN", ...fixture.pr };
if (args[1] === "list") process.stdout.write(JSON.stringify(fixture.absent ? [] : [pr]));
if (args[1] === "view") process.stdout.write(JSON.stringify(pr));
if (args[1] === "checks") {
  if (!args.includes("--required")) process.exit(2);
  process.stdout.write(JSON.stringify(fixture.checks ?? [{ bucket: "pending" }]));
  process.exit(fixture.exitCode ?? 0);
}
`;
module.exports = { FAKE_GH };
