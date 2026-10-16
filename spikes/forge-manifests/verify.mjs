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
const github = await read("github.json");
const source = await readFile(new URL("../../src/main/control/forge.ts", import.meta.url), "utf8");
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
