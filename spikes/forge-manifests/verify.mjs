// Offline design-artifact validation only. Never executes a CLI or contacts a forge.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";

const read = async (name) => JSON.parse(await readFile(new URL(name, import.meta.url), "utf8"));
const schema = await read("forge.schema.json");
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
for (const name of ["github.json", "gitlab.json"]) {
  const manifest = await read(name);
  assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
  for (const mutate of [
    (copy) => { copy.kind = "agent"; },
    (copy) => { copy.version = 2; },
    (copy) => { copy.operations.refresh.shell = "echo unsafe"; },
    (copy) => { copy.mapping.state = "$..state"; },
    (copy) => { copy.mapping.states.unrecognized = "READY"; },
    (copy) => { copy.operations.refresh.argv = [{ parts: [{ slot: "token", encoding: "literal" }] }]; },
  ]) {
    const copy = structuredClone(manifest);
    mutate(copy);
    assert.equal(validate(copy), false, `${name}: schema accepted a negative example`);
  }
  const copy = structuredClone(manifest);
  copy.id += "-custom";
  copy.name += " custom";
  assert.equal(validate(copy), true, "duplicate has the same shape/capabilities");
}
const bundled = await read("../../src/shared/bundled-forges/github.json");
assert.equal(validate(bundled), true, JSON.stringify(validate.errors));
const invalidBatch = structuredClone(bundled);
invalidBatch.operations.batchStatus.extra = true;
assert.equal(validate(invalidBatch), false, "batch rejects unknown keys");
const github = await read("github.json");
const source = await readFile(new URL("../../tests/helpers/legacy-forge.ts", import.meta.url), "utf8");
const sourceQuery = /const CHECK_QUERY = `([\s\S]*?)`;/.exec(source)?.[1];
assert.equal(github.checks.fallback.query, sourceQuery);
assert.equal((await readFile(new URL("required-checks.graphql", import.meta.url), "utf8")).trimEnd(), sourceQuery);
const view = await read("fixtures/gh-view-public.json");
const list = await read("fixtures/gh-list-public.json");
const rollup = await read("fixtures/gh-rollup-public.json");
const unsupported = await read("fixtures/gh-checks-unsupported.json");
assert.equal(view.exitCode, 0);
assert.equal(list.exitCode, 0);
assert.equal(rollup.exitCode, 0);
const pr = JSON.parse(view.stdout);
assert.equal(pr.number, 14700);
assert.equal(pr.isCrossRepository, true); // A useful refusal fixture, not an adoptable PR.
assert.equal(JSON.parse(list.stdout)[0].headRefOid, pr.headRefOid);
assert.equal(JSON.parse(rollup.stdout).data.node.headRefOid, pr.headRefOid);
assert.notEqual(unsupported.exitCode, 0);
assert.match(unsupported.stderr, /unknown flag: --json/);
const auth = await read("fixtures/glab-auth-unavailable.json");
assert.equal(auth.exitCode, 0);
assert.deepEqual((await read("gitlab.json")).auth.failureContains, auth.observedFailureMarkers);
const glab = JSON.parse((await read("fixtures/glab-mr-constructed.json")).stdout);
assert.equal(glab.iid, 7);
assert.notEqual(glab.iid, glab.id); // Local MR number, not global ID.
assert.equal(glab.sha, glab.head_pipeline.sha);
assert.equal(glab.source_project_id, glab.target_project_id);
console.log("Both manifest shapes, 12 schema rejection cases, duplicates, query parity and fixture integrity passed. No runtime engine or live CLI tested.");

// Recorded GitLab REST/detail/list mappings. All inputs are local snapshots.
const gitlab = await read("gitlab.json");
const at = (value, path) => path.reduce((object, key) => object?.[key], value);
const recorded = async (name) => {
  const envelope = await read(`fixtures/glab-${name}-recorded.json`);
  assert.equal(envelope.glabVersion, "1.124.0 (d43ccacec)");
  assert.match(envelope.capturedAt, /^2026-10-22T/);
  assert.ok(envelope.argv.length > 0);
  assert.ok(envelope.scenario);
  assert.equal(envelope.exitCode, 0, name);
  return JSON.parse(envelope.stdout);
};
const mapped = (mr) => {
  const result = {};
  for (const field of ["number", "branch", "headSha", "state", "title", "webUrl"]) {
    result[field] = at(mr, gitlab.mapping[field]);
    assert.notEqual(result[field], undefined, `missing ${field}`);
  }
  result.state = gitlab.mapping.states[result.state];
  for (const field of ["source", "target", "context"]) {
    const id = at(mr, gitlab.mapping.projects[field]);
    assert.ok(Number.isSafeInteger(id) && id > 0, `invalid ${field} project`);
    result[field] = id;
  }
  return result;
};
const conclusion = (mr, bindings) => {
  const result = gitlab.checks.primary.result;
  const matches = (object, guards) => guards.every((guard) => at(object, guard.path) === bindings[guard.binding]);
  if (!matches(mr, result.guards)) return "unknown";
  if (at(mr, result.nullAt) === null) return "none";
  const row = at(mr, result.rows);
  if (!row || !matches(row, result.rowGuards)) return "unknown";
  assert.equal(result.shape, "object");
  assert.equal(result.limit, 1);
  return result.variants[0].table[at(row, result.variants[0].value)] ?? "unknown";
};
const cases = [
  ["pending", 1, "OPEN", "pending"],
  ["success", 2, "OPEN", "success"],
  ["failed", 3, "OPEN", "failure"],
  ["manual", 4, "OPEN", "pending"],
  ["skipped", 5, "OPEN", "success"], // Rules omit one job; the remaining job passes.
  ["no-pipeline", 6, "OPEN", "none"],
  ["merged", 7, "MERGED", "none"],
  ["closed", 8, "CLOSED", "none"],
  ["skipped-pipeline", 9, "OPEN", "none"],
];
for (const [name, number, state, checks] of cases) {
  const rest = await recorded(`${name}-rest`);
  const expected = mapped(rest);
  assert.equal(expected.number, number);
  assert.equal(expected.state, state);
  assert.equal(expected.branch, `evidence-522/${name}`);
  assert.equal(expected.source, expected.target);
  assert.equal(expected.target, expected.context);
  assert.equal(expected.webUrl, `https://gitlab.com/scott-test-projects/foom-forge-fixtures/-/merge_requests/${number}`);
  assert.match(expected.headSha, /^[a-f0-9]{40}$/);
  const bindings = { number, headSha: expected.headSha };
  assert.equal(conclusion(rest, bindings), checks, name);
  const view = await recorded(`${name}-view`);
  assert.deepEqual(mapped(view), expected);
  assert.equal(conclusion(view, bindings), checks, `${name} view`);
  const list = await recorded(`${name}-list`);
  assert.equal(list.length, 1);
  assert.deepEqual(mapped(list[0]), expected);
  // A list's absent pipeline field must never be mistaken for explicit null.
  assert.equal(conclusion(list[0], bindings), "unknown");
  if (name !== "skipped-pipeline") {
    const lookup = await recorded(`${name}-lookup`);
    assert.equal(lookup.length, 1);
    assert.deepEqual(mapped(lookup[0]), expected);
  }
}
const before = await recorded("race-before-rest");
const after = await recorded("race-after-rest");
const oldPipeline = await recorded("race-old-pipeline");
const newPipeline = await recorded("race-new-pipeline");
assert.equal(before.head_pipeline.status, "running");
assert.equal(oldPipeline.status, "running");
assert.notEqual(before.sha, after.sha);
assert.equal(oldPipeline.sha, before.sha);
assert.equal(after.pipeline.sha, before.sha);
assert.equal(after.head_pipeline.sha, after.sha);
assert.equal(newPipeline.sha, after.sha);
const newBindings = { number: after.iid, headSha: after.sha };
assert.equal(conclusion(before, newBindings), "unknown", "stale response is rejected");
assert.equal(conclusion({ ...after, head_pipeline: oldPipeline }, newBindings), "unknown", "derived stale-pipeline response is rejected");
assert.equal(conclusion(after, newBindings), "pending");
const jobs = await recorded("skipped-jobs");
assert.deepEqual(jobs.map((job) => job.name), ["fixture"]); // excluded uses rules: when: never.
assert.equal((await recorded("manual-jobs"))[0].status, "manual");
assert.equal((await recorded("manual-jobs"))[0].allow_failure, false);
const batch = (await recorded("batch")).data.project;
for (const [name, number, state] of cases.slice(0, 8)) {
  const row = batch[`mr${number}`];
  const rest = await recorded(`${name === "pending" ? "race-after" : name}-rest`);
  assert.equal(row.iid, String(number)); // GraphQL IDs are strings, REST iids are numbers.
  assert.equal(row.state, rest.state);
  assert.equal(gitlab.mapping.states[row.state], state);
  assert.equal(row.sourceBranch, rest.source_branch);
  assert.equal(row.diffHeadSha, rest.sha);
  assert.equal(row.webUrl, rest.web_url);
  assert.equal(row.sourceProject.id, `gid://gitlab/Project/${rest.source_project_id}`);
  assert.equal(row.sourceProject.id, row.targetProject.id);
  if (row.headPipeline === null) assert.equal(rest.head_pipeline, null);
  else {
    assert.equal(row.headPipeline.sha, row.diffHeadSha);
    const status = row.headPipeline.status.toLowerCase();
    assert.ok(Object.hasOwn(gitlab.checks.primary.result.variants[0].table, status));
    // Pending MR may settle between captures; assert the stable scenarios exactly.
    if (name !== "pending") assert.equal(status, rest.head_pipeline.status);
  }
}
for (const [name, diagnostic] of [
  ["unknown-mr", /404 Not Found/],
  ["unknown-project", /404 Project Not Found \(HTTP 404\)/],
  ["malformed-graphql", /Expected NAME, not end of file/],
]) {
  const envelope = await read(`fixtures/glab-${name}-recorded.json`);
  assert.equal(envelope.exitCode, 1);
  assert.equal(envelope.stdout, "");
  assert.match(envelope.stderr, diagnostic);
}
assert.equal((await recorded("merged-state-list"))[0].state, "merged");
assert.equal((await recorded("closed-state-list"))[0].state, "closed");
assert.ok((await recorded("open-state-list")).every((mr) => mr.state === "opened"));
assert.equal((await recorded("open-lookup"))[0].iid, 2);
console.log("Recorded GitLab mappings: nine scenarios, state-filtered lists, SHA race guards, GraphQL differences and three failure exits passed.");
const fork = mapped(JSON.parse((await read("fixtures/glab-fork-constructed.json")).stdout));
assert.notEqual(fork.source, fork.target, "synthetic fork is refused by project identity");
const remoteExamples = await read("fixtures/glab-remotes-constructed.json");
assert.equal(remoteExamples.remotes.length, 5);
// All recorded envelopes retain provenance, with identity data removed before storage.
const { readdir } = await import("node:fs/promises");
for (const name of await readdir(new URL("fixtures/", import.meta.url))) {
  if (!/^glab-.*-recorded\.json$/.test(name)) continue;
  const envelope = await read(`fixtures/${name}`);
  assert.equal(envelope.glabVersion, "1.124.0 (d43ccacec)");
  assert.ok(Number.isInteger(envelope.exitCode));
  assert.ok(Number.isFinite(Date.parse(envelope.capturedAt)));
  assert.ok(envelope.argv.every((arg) => typeof arg === "string"));
  assert.ok(envelope.scenario && envelope.provenance);
  assert.equal(typeof envelope.stderr, "string");
  assert.doesNotMatch(envelope.stdout, /"(?:user|author|committer|username|email|avatar_url|description)"\s*:/);
  assert.doesNotMatch(JSON.stringify(envelope), /(?:glpat-|glabpat-)[A-Za-z0-9_-]+/);
}
for (const name of ["pending", "success", "failed", "manual", "skipped"]) {
  const mr = await recorded(`${name}-rest`);
  const pipeline = await recorded(`${name}-pipeline`);
  assert.equal(pipeline.id, mr.head_pipeline.id);
  assert.equal(pipeline.sha, mr.sha);
  assert.equal(pipeline.status, mr.head_pipeline.status);
}
assert.equal((await recorded("skipped-pipeline-detail")).status, "skipped");
const finalPipelines = await recorded("final-pipelines");
assert.ok(finalPipelines.every((pipeline) => !["running", "pending"].includes(pipeline.status)));
console.log("Recorded envelope hygiene, pipeline detail parity, synthetic fork refusal and final inventory passed.");
const skippedBatch = (await recorded("batch-skipped")).data.project.mr9;
assert.equal(skippedBatch.iid, "9");
assert.equal(skippedBatch.headPipeline.status, "SKIPPED");
assert.equal(skippedBatch.headPipeline.sha, skippedBatch.diffHeadSha);
