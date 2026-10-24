import assert from "node:assert/strict";
import { test } from "node:test";
import { checkLocal } from "./check-local.mjs";

test("local checks bound concurrency, serialize tests and aggregate every failure", async () => {
  let active = 0;
  let peak = 0;
  const completed = [];
  const results = await checkLocal(async (stage) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    if (stage === "test:ci") assert.ok(completed.includes("test"));
    completed.push(stage);
    active--;
    if (stage === "typecheck") throw Error("spawn failure");
    return stage === "lint:local" || stage === "test" ? 1 : 0;
  });
  assert.equal(peak, 2);
  assert.equal(results.length, 6);
  assert.deepEqual(
    results
      .filter(({ code }) => code !== 0)
      .map(({ stage }) => stage)
      .sort(),
    ["lint:local", "test", "typecheck"],
  );
});
