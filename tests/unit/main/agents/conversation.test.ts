import { expect, test } from "vitest";
import { conversationId, resumeArguments } from "../../../../src/main/agents/conversation";

test.each(["abc", "0199abc0-1234-7890-abcd-123456789abc", "safe_id", "a".repeat(200)])(
  "accepts opaque ID %s",
  (id) => {
    expect(conversationId(id)).toBe(true);
    expect(resumeArguments("claude", id)).toEqual(["--resume", id]);
    expect(resumeArguments("codex", id)).toEqual(["resume", id]);
    expect(resumeArguments("agy", id)).toEqual(["--conversation", id]);
  },
);
test.each([
  null,
  undefined,
  123,
  "",
  "-option",
  "--last",
  "a/b",
  "..",
  "a b",
  "a\n",
  "$(id)",
  "a".repeat(201),
])("rejects malformed ID %s", (id) => {
  expect(conversationId(id)).toBe(false);
  expect(() => resumeArguments("codex", id)).toThrow("Invalid conversation ID");
  expect(() => resumeArguments("agy", id)).toThrow("Invalid conversation ID");
});
