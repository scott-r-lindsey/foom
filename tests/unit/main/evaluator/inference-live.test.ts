import { expect, it } from "vitest";
import { evaluateRules } from "../../../../src/main/evaluator/evaluator";
import { createInferenceSource } from "../../../../src/main/evaluator/inference-source";
import { ModelEvaluator } from "../../../../src/main/evaluator/model-evaluator";
import { evaluatorFixtures } from "../../../fixtures/evaluator";

// Explicit opt-in only: normal tests/coverage/CI never contact an inference provider.
const configured = process.env["FOOM_INFERENCE_CONFIG"];
it.skipIf(!configured)(
  "compares the configured model with the rules fixture baseline",
  async () => {
    if (!configured) throw new Error("Missing inference configuration");
    const config: unknown = JSON.parse(configured);
    const source = createInferenceSource(config, () => {
      const key = process.env["FOOM_INFERENCE_KEY"];
      if (!key) return Promise.reject(new Error("Missing inference key"));
      return Promise.resolve(key);
    });
    if (!source) throw new Error("Select a model source for the live comparison");
    const model = new ModelEvaluator(source);
    const sample = await model.runCheck();
    console.info("Run check:", {
      status: sample.status,
      elapsedMs: sample.elapsedMs,
      state: sample.verdict.state,
    });
    expect(sample.status).toBe("model");
    const rows = [];
    for (const fixture of evaluatorFixtures) {
      // The rules baseline intentionally leaves prose questions ambiguous.
      const expected = fixture.name === "prose question" ? "needs_input" : fixture.state;
      const check = await model.runCheck(fixture.tail);
      rows.push({
        name: fixture.name,
        expected,
        rules: evaluateRules({ terminalId: "fixture", tail: fixture.tail }).state,
        model: check.verdict.state,
        status: check.status,
        elapsedMs: check.elapsedMs,
      });
    }
    console.table(rows);
    console.info("Accuracy:", {
      rules: rows.filter((row) => row.rules === row.expected).length,
      model: rows.filter((row) => row.status === "model" && row.model === row.expected).length,
      total: rows.length,
    });
    // Quality is a report, not a nondeterministic CI gate; transport failures are failures.
    expect(rows.every((row) => row.status === "model")).toBe(true);
  },
  180_000,
);
