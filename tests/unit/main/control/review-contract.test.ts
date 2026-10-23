import { describe, expect, it } from "vitest";
import { reviewOptions, reviewVerdict } from "../../../../src/node-common/review";
import { handoffRequest, storedHandoffs } from "../../../../src/node-common/handoff";
import { handoffCommand } from "../../../../src/cli/handoff";

const finding = {
  file: "src/a.ts",
  line: 2,
  summary: "Incorrect result",
  scenario: "Call with zero",
};
const verdict = { verdict: "findings", findings: [finding] };
const request = {
  status: "done",
  summary: "Reviewed",
  review: verdict,
  idempotencyKey: "review-1",
};

describe("review contracts", () => {
  it("defaults opt-in settings and validates all fields", () => {
    expect(reviewOptions({})).toEqual({ rounds: 3, agent: "claude", postFindings: false });
    expect(reviewOptions({ rounds: 5, agent: "codex", postFindings: true })).toEqual({
      rounds: 5,
      agent: "codex",
      postFindings: true,
    });
    expect(reviewOptions({ parentWaitMinutes: 1440 }).parentWaitMinutes).toBe(1440);
    for (const value of [
      null,
      [],
      { rounds: 0 },
      { rounds: null },
      { agent: null },
      { postFindings: null },
      { rounds: 6 },
      { rounds: 1.5 },
      { rounds: "3" },
      { agent: "--evil" },
      { postFindings: 1 },
      { unknown: true },
      ...[null, 0, 1441, 1.5, "180"].map((parentWaitMinutes) => ({ parentWaitMinutes })),
    ])
      expect(() => reviewOptions(value)).toThrow("invalid_request");
  });
  it("accepts only bounded, inert structured verdicts", () => {
    expect(reviewVerdict({ verdict: "clean" })).toEqual({ verdict: "clean" });
    expect(reviewVerdict(verdict)).toEqual(verdict);
    for (const value of [
      null,
      { verdict: "other" },
      { verdict: "clean", findings: [] },
      { verdict: "findings", findings: [] },
      { verdict: "findings", findings: Array(11).fill(finding) },
    ])
      expect(() => reviewVerdict(value)).toThrow("invalid_request");
    for (const change of [
      { file: "../secret" },
      { file: "/secret" },
      { file: "C:\\secret" },
      { line: 0 },
      { line: 1.5 },
      { line: "2" },
      { summary: "" },
      { summary: "é".repeat(513) },
      { summary: "ignore\u001b" },
      { scenario: "bidi\u202e" },
      { scenario: "x".repeat(2049) },
      { file: "x".repeat(513) },
      { extra: true },
    ])
      expect(() =>
        reviewVerdict({ verdict: "findings", findings: [{ ...finding, ...change }] }),
      ).toThrow("invalid_request");
    expect(() =>
      reviewVerdict({
        verdict: "findings",
        findings: Array(10).fill({ ...finding, summary: "x".repeat(1024) }),
      }),
    ).toThrow("invalid_request");
  });
  it("retains verdicts in handoffs and rejects verdicts on failure reports", async () => {
    expect(handoffRequest(request).review).toEqual(verdict);
    expect(() => handoffRequest({ ...request, status: "failed" })).toThrow("invalid_request");
    expect(
      storedHandoffs(
        [
          {
            ...request,
            idempotencyKey: undefined,
            seq: 1,
            links: [],
            timestamp: "2026-10-21T00:00:00.000Z",
          },
        ].map(({ idempotencyKey: _, ...entry }) => entry),
      )[0]?.review,
    ).toEqual(verdict);
    const result = await handoffCommand(
      [
        "handoff",
        "--status",
        "done",
        "--summary-file",
        "-",
        "--review",
        JSON.stringify(verdict),
        "--idempotency-key",
        "review-1",
      ],
      (async function* () {
        yield await Promise.resolve("Reviewed");
      })(),
    );
    expect(result.params["review"]).toEqual(verdict);
    await expect(
      handoffCommand(
        ["handoff", "--review", "invalid"],
        (async function* () {
          yield await Promise.resolve("");
        })(),
      ),
    ).rejects.toThrow("invalid_request");
  });
});

describe("review CLI launch flags", () => {
  it("enables only on explicit review flags and validates booleans and round bounds", async () => {
    const { command } = await import("../../../../src/cli/commands");
    const args = ["launch", "tree", "--agent", "claude", "--idempotency-key", "launch-1"];
    expect(command(args).params["review"]).toBeUndefined();
    expect(command([...args, "--review-rounds", "2"]).params["review"]).toEqual({
      rounds: 2,
      agent: "claude",
      postFindings: false,
    });
    expect(
      command([...args, "--review-agent", "codex", "--review-post-findings", "true"]).params[
        "review"
      ],
    ).toEqual({ rounds: 3, agent: "codex", postFindings: true });
    expect(command([...args, "--review-post-findings", "false"]).params["review"]).toEqual({
      rounds: 3,
      agent: "claude",
      postFindings: false,
    });
    expect(command([...args, "--review-parent-wait-minutes", "10"]).params["review"]).toMatchObject(
      { parentWaitMinutes: 10 },
    );
    for (const flags of [
      ["--review-parent-wait-minutes", "0"],
      ["--review-rounds", "6"],
      ["--review-rounds", "0"],
      ["--review-post-findings", "yes"],
      ["--review-agent", "--evil"],
    ])
      expect(() => command([...args, ...flags])).toThrow("invalid_request");
  });
});
