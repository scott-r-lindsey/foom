import { expect, it } from "vitest";
import { childPostText } from "../../../../src/shared/message-board-presentation";
const text = (event: string, content: unknown) =>
  childPostText(`${event} · ${JSON.stringify(content)}`);
it.each([
  ["launch", { prompt: "Fixture task", automatic: false }, "Launched: Fixture task"],
  ["launch", { automatic: true }, "Launched · automatic review"],
  [
    "prompt",
    { text: "⟨redacted⟩ reply sent · delivered", delivery: "delivered" },
    "Prompt · ⟨redacted⟩ · delivered",
  ],
  ["prompt", { prompt: "Continue", automatic: true }, "Review follow-up started · automatic"],
  [
    "send_keys",
    { text: "keys sent (2)", delivery: "indeterminate" },
    "Keys sent (2) · indeterminate",
  ],
  ["send_keys", { text: "internal-id", delivery: "bad" }, "Keys sent · "],
  [
    "handoff",
    { status: "done", summary: "Fixed the bug", authorId: "private" },
    "Handoff · done\nFixed the bug",
  ],
  ["pull request", { number: 340 }, "Pull request #340"],
  [
    "review loop start",
    { rounds: 3, agent: "claude", authorId: "private" },
    "Review started · 3 rounds · claude",
  ],
  ["review round start", { round: 2 }, "Review round 2 started"],
  [
    "review transition",
    { phase: "escalated", reason: "round cap", content: { verdict: "clean" } },
    "Review · escalated · round cap\nClean",
  ],
  ["review verdict", { verdict: "clean" }, "Review verdict · Clean"],
  ["review restored", {}, "Review restored"],
  ["review resumed by parent", {}, "Review resumed by parent"],
  ["review waiting on parent", {}, "Review waiting on parent"],
  ["exit", {}, "Child exited"],
  ["stop", { status: "succeeded" }, "Stop · succeeded"],
  ["close", { status: "closed" }, "Close · closed"],
  ["worktree removal", { status: "succeeded" }, "Worktree removal · succeeded"],
  ["unknown-private-id", { secret: "private" }, "Child event"],
  ["pull request", { number: -1 }, "Pull request"],
  ["review loop start", { rounds: "private", agent: 3 }, "Review started"],
  ["review round start", {}, "Review round started"],
  ["review transition", {}, "Review · "],
  ["review verdict", null, "Review verdict · "],
])("presents %s through fixed templates", (event, content, expected) => {
  expect(text(event, content)).toBe(expected);
});
it("renders findings without internal metadata or raw JSON", () => {
  const findings = {
    verdict: "findings",
    findings: [
      {
        file: "a.ts",
        line: 2,
        summary: "Incorrect zero",
        scenario: "Zero input",
        terminalId: "private",
      },
      { file: "invalid" },
    ],
  };
  expect(text("findings forwarded", { content: findings, authorId: "private" })).toBe(
    "Findings forwarded\na.ts:2 · Incorrect zero\nZero input",
  );
  expect(text("review verdict", findings)).toContain("a.ts:2 · Incorrect zero");
});
it.each(["no separator", 'handoff · {"summary":"unfinished ⟨truncated⟩'])(
  "hides incomplete structured records: %s",
  (input) => {
    expect(childPostText(input)).toBe("Child event · ⟨truncated⟩");
  },
);

it("summarizes generated review briefs without exposing their quoted JSON", () => {
  const prompt =
    'Resume work. Quoted review notes (JSON): {"verdict":"findings","authorId":"private"}';
  expect(text("prompt", { prompt, automatic: true })).toBe("Review follow-up started · automatic");
  expect(text("launch", { prompt, automatic: true })).toBe("Launched · automatic review");
  expect(
    text("prompt", { text: "Continue fixture task", automatic: true, delivery: "delivered" }),
  ).toBe("Prompt · automatic · Continue fixture task · delivered");
});
