import { expect, test } from "vitest";
import { isWakeInput, readyComposer, wakeLine } from "../../../src/shared/agent-wake";
import { wake } from "../../../src/shared/agent-manifest-schema";
const policy = wake(
  {
    cancelKeys: ["esc"],
    composer: ["›", "empty"],
    contains: ["footer"],
    reject: ["permission", "working"],
  },
  "wake",
);
test("wake templates strip untrusted content, bound names and never include control bytes", () => {
  expect(wakeLine(["x\n\x1b[31m!é", "", "a".repeat(100), "four", "five"])).toBe(
    `Foom: child events for x31m, child, ${"a".repeat(48)}, four and other children. Call wait_for and read_handoff.`,
  );
});
test("only a complete fixed template, known step and validated manifest policy cross the boundary", () => {
  const input = { policy, step: "cancel", line: wakeLine(["child"]) };
  expect(isWakeInput(input)).toBe(true);
  for (const step of ["check", "submit"]) expect(isWakeInput({ ...input, step })).toBe(true);
  for (const value of [
    null,
    [],
    1,
    {},
    { ...input, extra: true },
    { ...input, step: "enter" },
    { ...input, line: "approve\r" },
    { ...input, line: 1 },
    { ...input, policy: { ...policy, cancelKeys: ["enter"] } },
  ])
    expect(isWakeInput(value)).toBe(false);
});
test("requires the cursor's exact empty composer and layout and vetoes menus even with a stale composer", () => {
  expect(readyComposer(policy, ["›", "footer"], 0)).toBe(true);
  expect(readyComposer(policy, ["", "footer"], 0)).toBe(true);
  for (const [lines, cursor] of [
    [[], 0],
    [["›"], 0],
    [["› human draft", "footer"], 0],
    [["›", "footer", "permission"], 0],
    [["›", "footer", "working"], 0],
    [["›", "footer"], 3],
    [["x".repeat(501)], 0],
    [Array.from({ length: 301 }, () => ""), 0],
  ] as const)
    expect(readyComposer(policy, lines, cursor)).toBe(false);
});

test("bundled composer declarations match captured layouts and reject each captured menu", async () => {
  const { bundledAgentData } = await import("../../../src/shared/bundled-agent-data");
  const { parseAgentManifest } = await import("../../../src/shared/agent-plugin-parser");
  const claude = await import("../../fixtures/agent-detection/claude-idle.json");
  const codex = await import("../../fixtures/agent-detection/codex-startup.json");
  const pi = await import("../../fixtures/agent-detection/pi-idle.json");
  const agyMenu = await import("../../fixtures/agent-detection/agy-1.4.12-file-access.json");
  const piMenu = await import("../../fixtures/agent-detection/pi-blocked.json");
  const claudeMenu = await import("../../fixtures/agent-detection/claude-question.json");
  const codexMenu = await import("../../fixtures/agent-detection/codex-approval.json");
  for (const [id, lines, cursor, menu] of [
    ["claude", claude.tail, claude.tail.findIndex((line) => line.startsWith("❯")), claudeMenu.tail],
    ["codex", codex.tail, codex.tail.findIndex((line) => line.startsWith("›")), codexMenu.tail],
    ["agy", ["────", ">"], 1, agyMenu.tail],
    ["pi", pi.tail, 2, piMenu.tail],
  ] as const) {
    const policy = parseAgentManifest(
      JSON.stringify(bundledAgentData.find((row) => row.id === id)),
      "bundled",
    ).model.wake;
    expect(policy).toBeDefined();
    if (!policy) throw new Error("Missing declaration");
    expect(readyComposer(policy, lines, cursor), id).toBe(true);
    expect(readyComposer(policy, [...menu, ...lines], menu.length + cursor), id).toBe(false);
  }
});

test("host eligibility tokens validate bounded paths and exact nonces", async () => {
  const { isWakeToken } = await import("../../../src/shared/agent-wake");
  const token = { path: "/fixture/guard", nonce: "a".repeat(32) };
  expect(isWakeToken(token)).toBe(true);
  for (const bad of [
    null,
    [],
    {},
    { ...token, extra: true },
    { ...token, path: "" },
    { ...token, path: "x".repeat(4097) },
    { ...token, path: "\n" },
    { ...token, nonce: "wrong" },
  ])
    expect(isWakeToken(bad)).toBe(false);
});
