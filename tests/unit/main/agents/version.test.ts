import { expect, it } from "vitest";
import { meetsMinimum } from "../../../../src/main/agents/version";
it("rejects an incomplete internal version pattern", () => {
  expect(() => meetsMinimum("1", /^(1)$/u, [1, 2])).toThrow("Incomplete version pattern");
});
