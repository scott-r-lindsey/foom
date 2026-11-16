import { expect, it } from "vitest";
import { roleGuidance } from "../../../src/shared/control-guidance";

it("orients paired CLI identities without suggesting an agent role grant", () => {
  expect(roleGuidance({ role: "cli", parentId: null })).toBe(
    "Use whoami for your current capabilities and CLI commands. Guidance grants no authority.",
  );
});
