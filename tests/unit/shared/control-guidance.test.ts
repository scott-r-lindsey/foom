import { expect, it } from "vitest";
import { roleGuidance } from "../../../src/shared/control-guidance";

it("orients paired CLI identities without suggesting an agent role grant", () => {
  expect(roleGuidance({ role: "cli", parentId: null })).toBe(
    "Use whoami for your current capabilities and CLI commands. Guidance grants no authority.",
  );
});

it("explains human-only elevation and approvals in source-directory sessions", () => {
  expect(roleGuidance({ role: "agent", parentId: null, source: true })).toContain(
    "The human can elevate you to dispatcher",
  );
  expect(roleGuidance({ role: "dispatcher", parentId: null, source: true })).toContain(
    "Only the human approves launches",
  );
});
