import { describe, expect, test } from "vitest";
import { formatCoverageSummary } from "../../../scripts/format-coverage-summary.mjs";

describe("formatCoverageSummary", () => {
  test("formats the total metrics as a GitHub-flavored Markdown table", () => {
    const summary = {
      total: {
        statements: { covered: 75, total: 100, pct: 75 },
        branches: { covered: 40, total: 50, pct: 80 },
        functions: { covered: 18, total: 20, pct: 90 },
        lines: { covered: 70, total: 80, pct: 87.5 },
      },
    };

    expect(formatCoverageSummary(summary)).toContain("| Statements | 75 | 100 | 75% |");
    expect(formatCoverageSummary(summary)).toContain("| Lines | 70 | 80 | 87.5% |");
    expect(formatCoverageSummary(summary)).toContain("<!-- foom-coverage -->");
  });

  test("rejects incomplete summaries", () => {
    expect(() => formatCoverageSummary({ total: {} })).toThrow(
      "Coverage summary is missing the statements metric",
    );
  });
});
