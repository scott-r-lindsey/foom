import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import {
  boundedRegex,
  detectAgent,
  manifests,
  parseManifest,
  ruleRegion,
} from "../../../../src/main/evaluator/agent-rules";
import type { AgentRule } from "../../../../src/main/evaluator/agent-rule-types";
import { evaluateRules } from "../../../../src/main/evaluator/evaluator";
import { ModelEvaluator } from "../../../../src/main/evaluator/model-evaluator";
import claude from "../../../../src/main/evaluator/agent-rules/claude.json";
const evidence = { title: "", progress: null };
const rule: AgentRule = {
  id: "test",
  state: "working",
  priority: 1,
  region: "bottom",
  match: { contains: ["working"] },
  reason: "Working",
  comment: "Synthetic engine case",
};

test("regions bound screen input and exclude historical prompts", () => {
  expect(ruleRegion(rule, evidence, ["working", ...Array<string>(40).fill("idle")])).not.toContain(
    "working",
  );
  expect(ruleRegion({ ...rule, lines: 2 }, evidence, ["stale", "", "last", "", "now"])).toBe(
    "last\nnow",
  );
  expect(
    ruleRegion({ ...rule, region: "after_horizontal_rule" }, evidence, [
      "old",
      "───",
      "current",
      "-----",
      "new",
    ]),
  ).toBe("new");
  expect(ruleRegion({ ...rule, region: "after_horizontal_rule" }, evidence, ["no border"])).toBe(
    "no border",
  );
  expect(ruleRegion(rule, evidence, ["x".repeat(1000)])).toHaveLength(500);
});

test("ordered priorities, exclusions, no match, unknown and evaluation deadline", () => {
  const blocked: AgentRule = {
    ...rule,
    id: "blocked",
    priority: 10,
    state: "blocked",
    not: [{ contains: ["cancelled"] }],
  };
  expect(detectAgent("claude", evidence, ["working"], [rule, blocked])?.id).toBe("blocked");
  expect(detectAgent("claude", evidence, ["working cancelled"], [blocked, rule])?.id).toBe("test");
  expect(detectAgent("claude", evidence, ["other"], [rule])).toBeUndefined();
  expect(detectAgent("claude", evidence, ["working"], [{ ...rule, state: "unknown" }])?.state).toBe(
    "unknown",
  );
  const slow = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(6);
  expect(detectAgent("claude", evidence, ["working"], [rule], slow)).toBeUndefined();
  const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(6);
  expect(detectAgent("claude", evidence, ["working"], [rule], now)).toBeUndefined();
  expect(
    detectAgent("claude", evidence, ["WORKING"], [{ ...rule, match: { regex: ["^working$"] } }])
      ?.id,
  ).toBe("test");
});

test.each(["", "x".repeat(129), "(a+)+$", "a*", "a?", "a{1,3}", "a|b", "(a)\\1", "\\p{L}", "["])(
  "rejects unsafe or malformed regex %s",
  (pattern) => {
    expect(() => boundedRegex(pattern)).toThrow();
  },
);
test("validates bundled manifest engine, agent, states and regions", () => {
  expect(() => parseManifest({ ...claude, minimumEngineVersion: 2 })).toThrow();
  expect(() => parseManifest({ ...claude, id: "unknown" })).toThrow();
  const first = claude.rules[0];
  if (!first) throw new Error("Missing rule");
  expect(() => parseManifest({ ...claude, rules: [{ ...first, state: "bad" }] })).toThrow();
  expect(() => parseManifest({ ...claude, rules: [{ ...first, region: "bad" }] })).toThrow();
});

test("every shipped rule matches a versioned real capture", () => {
  const directory = join(import.meta.dirname, "../../../fixtures/agent-detection");
  const captures = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name): unknown => JSON.parse(readFileSync(join(directory, name), "utf8")));
  for (const manifest of manifests)
    for (const rule of manifest.rules) {
      let matched = false;
      for (const capture of captures) {
        if (
          typeof capture !== "object" ||
          !capture ||
          !("agent" in capture) ||
          capture.agent !== manifest.id ||
          !("rules" in capture) ||
          !Array.isArray(capture.rules) ||
          !capture.rules.includes(rule.id)
        )
          continue;
        if (
          !("version" in capture) ||
          typeof capture.version !== "string" ||
          !("tail" in capture) ||
          !Array.isArray(capture.tail) ||
          !("titles" in capture) ||
          !Array.isArray(capture.titles)
        )
          throw new Error("Invalid capture");
        const tail = capture.tail.filter((line): line is string => typeof line === "string");
        const titles = [
          "",
          ...capture.titles.filter((title): title is string => typeof title === "string"),
        ];
        const finalMatch = detectAgent(
          manifest.id,
          { title: titles.at(-1) ?? "", progress: null },
          tail,
        );
        expect(
          capture.rules,
          "Final screen and title must agree with the expected capture rules",
        ).toContain(finalMatch?.id);
        matched ||= titles.some(
          (title) =>
            detectAgent(manifest.id, { title, progress: null }, tail, [rule])?.id === rule.id,
        );
      }
      expect(matched, `${manifest.id}:${rule.id} needs a real capture`).toBe(true);
    }
});

test("exit and hooks beat agent rules; idle still reaches only the tail model", async () => {
  const input = {
    terminalId: "t",
    agent: "codex" as const,
    evidence: { title: "Action Required", progress: null },
    tail: ["Press Enter"],
  };
  expect(evaluateRules(input)).toMatchObject({
    state: "needs_input",
    signal: "rules:codex:osc_title_blocked",
    reason: "Approval requested",
  });
  expect(evaluateRules({ ...input, exitCode: 0 })).toMatchObject({
    state: "done",
    signal: "process:exit",
  });
  expect(
    evaluateRules({
      ...input,
      hook: { terminalId: "t", action: "needs_input", signal: "claude:PermissionRequest" },
    }),
  ).toMatchObject({ signal: "claude:PermissionRequest" });
  expect(evaluateRules({ ...input, evidence: { title: "⠋ codex", progress: null } })).toMatchObject(
    { state: "working", confidence: 0.95 },
  );
  const complete = vi.fn().mockResolvedValue('{"state":"needs_input","confidence":0.9}');
  const model = new ModelEvaluator({ complete });
  const idle = {
    ...input,
    tail: ["Which file should I edit?"],
    evidence: { title: "private-title", progress: null },
  };
  expect((await new ModelEvaluator().evaluate(idle)).signal).toBe("rules:codex:osc_title_idle");
  expect((await model.evaluate(idle)).state).toBe("needs_input");
  expect(complete.mock.calls[0]?.[0]).not.toContain("private-title");
  await model.evaluate(input);
  expect(complete).toHaveBeenCalledOnce();
});
