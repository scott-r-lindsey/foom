import { expect, it } from "vitest";
import { parse } from "graphql/language";
import {
  expandForgeBatchQuery,
  validateForgeBatchQueries,
} from "../../../src/shared/forge-batch-query";
import { parseForgeManifest } from "../../../src/shared/forge-manifest";
import { githubManifest } from "../../../src/main/control/forge-manifests";
import github from "../../../src/shared/bundled-forges/github.json";

const plan = github.operations.batchStatus;
const copy = { ...github, id: "config-batch" };
function parsePlan(patch: object) {
  return parseForgeManifest(
    JSON.stringify({
      ...copy,
      operations: { ...copy.operations, batchStatus: { ...plan, ...patch } },
    }),
  );
}
it("strictly validates immutable dynamic batch plans for either manifest origin", () => {
  const parsed = parsePlan({});
  expect(parsed.operations.batchStatus).toMatchObject({ repository: ["data", "repository"] });
  expect(Object.isFrozen(parsed.operations.batchStatus?.checks)).toBe(true);
  for (const patch of [
    { extra: true },
    { query: null },
    { command: { ...plan.command, jsonExitCodes: [0, 1] } },
    { command: { ...plan.command, jsonExitCodes: [1] } },
    { command: { ...plan.command, argv: [...plan.command.argv, "--input", "@file"] } },
    {
      command: {
        ...plan.command,
        argv: [
          "api",
          "graphql",
          "--hostname",
          { parts: [{ slot: "host", encoding: "literal" }] },
          "-f",
          { parts: ["query=", { slot: "query", encoding: "literal" }] },
          "-F",
          "owner=@file",
        ],
      },
    },
    { webUrl: { parts: [{ slot: "branch", encoding: "literal" }] } },
    { checks: { ...plan.checks, shape: "object", limit: 1 } },
    { checks: { ...plan.checks, required: undefined } },
    { sourceProject: ["__proto__"] },
    { crossProject: [1000] },
  ])
    expect(() => parsePlan(patch)).toThrow();
  expect(githubManifest.operations.batchStatus?.command.jsonExitCodes).toEqual([0]);
});
it("rejects mutations, unbound variables, fragments, directives and malformed batch insertion points", () => {
  for (const patch of [
    {
      query: "mutation($owner: String!, $name: String!) { deleteRepository { clientMutationId } }",
    },
    { query: "subscription($owner: String!, $name: String!) { x }" },
    { query: "query($owner: String!, $name: String!) { repository { name } }" },
    {
      query: "query($owner: String!, $name: String!) { repository { ...FoomBatch ...FoomBatch } }",
    },
    { query: "query($owner: String!, $name: String!) { repository { ...Other } }" },
    { query: "query($owner: String!, $owner: String!) { repository { ...FoomBatch } }" },
    { query: "query($owner: Int!, $name: String!) { repository { ...FoomBatch } }" },
    { query: 'query($owner: String! = "x", $name: String!) { repository { ...FoomBatch } }' },
    {
      query: "query($owner: String!, $name: String!) { repository(id: $unbound) { ...FoomBatch } }",
    },
    {
      query:
        "query($owner: String!, $name: String!) { repository @skip(if: true) { ...FoomBatch } }",
    },
    { query: plan.query + " fragment FoomBatch on Repository { name }" },
    { discovery: "query($branch: String!) { a: pullRequests { nodes { number } } }" },
    { discovery: "query($branch: String!) { pullRequests { nodes { number } } other { id } }" },
    { discovery: "query($branch: String!) { ...FoomBatch }" },
    { discovery: "query($branch: String!) { pullRequests { ...Other } }" },
    { discovery: "query { x }" },
    { bound: "query($number: Int!) { x(number: $other) }" },
    { bound: "query {" },
    { bound: "x".repeat(16385) },
  ])
    expect(() => parsePlan(patch)).toThrow();
});
it("composes ASTs without any text substitution and rejects invalid numeric syntax", () => {
  validateForgeBatchQueries(plan.query, plan.discovery, plan.bound);
  const expanded = expandForgeBatchQuery(plan.query, plan.discovery, plan.bound, [undefined, 12]);
  expect(() => parse(expanded)).not.toThrow();
  expect(expanded).toContain("$b0: String!");
  expect(expanded).toContain("headRefName: $b0");
  expect(expanded).toContain("p1: pullRequest(number: 12)");
  expect(expanded).toContain("isRequired(pullRequestNumber: 12)");
  expect(expanded).not.toContain("FoomBatch");
  expect(expanded).not.toContain("$number");
  for (const number of [-1, 0, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])
    expect(() => expandForgeBatchQuery(plan.query, plan.discovery, plan.bound, [number])).toThrow();
  expect(() =>
    expandForgeBatchQuery(plan.query, "query($branch: String!) { ...Other }", plan.bound, [
      undefined,
    ]),
  ).toThrow();
});

it("bounds individual and combined query text in UTF-8 bytes rather than code units", () => {
  const comment = "\n#" + "é".repeat(6000);
  expect(() =>
    parsePlan({
      query: plan.query + comment,
      discovery: plan.discovery + comment,
      bound: plan.bound + comment,
    }),
  ).toThrow("too-large");
  expect(() => {
    validateForgeBatchQueries(plan.query + "\n#" + "é".repeat(9000), plan.discovery, plan.bound);
  }).toThrow("unsafe-query");
});
