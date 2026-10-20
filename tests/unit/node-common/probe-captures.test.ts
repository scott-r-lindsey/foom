import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  parseCapture,
  saveCapture,
  testCaptureRules,
} from "../../../src/node-common/probe-captures";
import blocked from "../../fixtures/agent-captures/blocked.json";
import type { AgentRule } from "../../../src/main/evaluator/agent-rule-types";
import { object } from "../../../src/node-common/control-validation";
import { validateConfig } from "../../../src/cli/config";
import { OWNED_FILES } from "../../../src/main/config/layout";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "foom-capture-"));
  roots.push(root);
  return root;
}
const capture = parseCapture(blocked, "fixture");
const rule: AgentRule = {
  id: "approval",
  state: "blocked",
  region: "after_horizontal_rule",
  priority: 200,
  match: { contains: ["Approve?"] },
  reason: "Approval",
  comment: "Fixture",
};
const active = () => {};
test("atomic private captures never overwrite, even with concurrent saves; replay shares regions and priority", async () => {
  const root = await fixture();
  expect(await testCaptureRules(root, "fixture", [rule])).toEqual({
    agentId: "fixture",
    captures: [],
    passed: true,
  });
  const files = await Promise.all([
    saveCapture(root, capture, active),
    saveCapture(root, capture, active),
  ]);
  expect(new Set(files).size).toBe(2);
  for (const file of files)
    expect(JSON.parse(await readFile(join(root, file), "utf8"))).toEqual(capture);
  expect((await readdir(join(root, "captures/fixture"))).sort()).toEqual([
    "blocked-1.json",
    "blocked-2.json",
  ]);
  const low: AgentRule = {
    ...rule,
    id: "old-working",
    state: "working",
    priority: 100,
    region: "bottom",
    match: { contains: ["Working"] },
  };
  const result = await testCaptureRules(root, "fixture", [low, rule]);
  expect(result.passed).toBe(true);
  expect(result.captures).toEqual(
    [1, 2].map((n) => ({
      file: `captures/fixture/blocked-${String(n)}.json`,
      expected: "blocked",
      actual: "blocked",
      ruleId: "approval",
      passed: true,
    })),
  );
  expect((await testCaptureRules(root, "fixture", [low])).passed).toBe(false);
  expect(
    (await testCaptureRules(root, "fixture", [{ ...rule, not: [{ contains: ["Approve?"] }] }]))
      .captures[0],
  ).toMatchObject({ actual: "other", ruleId: null });
});
test("idle, working, unknown and unmatched preserve raw screen states without terminal verdicts", async () => {
  const root = await fixture();
  for (const expected of ["idle", "working", "other"] as const) {
    await saveCapture(root, { ...capture, expected }, active);
  }
  for (const state of ["idle", "working", "unknown"] as const) {
    const result = await testCaptureRules(root, "fixture", [{ ...rule, state }]);
    expect(result.captures.map((row) => row.actual)).toEqual(
      Array(3).fill(state === "unknown" ? "other" : state),
    );
  }
  expect(
    (await testCaptureRules(root, "fixture", [])).captures.every(
      (row) => row.actual === "other" && row.ruleId === null,
    ),
  ).toBe(true);
});
test("rejects untrusted capture structure, lengths, sizes and path components", async () => {
  for (const patch of [
    { version: 2 },
    { agentId: "other" },
    { agentVersion: 1 },
    { agentVersion: "x".repeat(4097) },
    { expected: "done" },
    { title: 1 },
    { title: "x".repeat(4097) },
    { cols: 0 },
    { cols: 1001 },
    { cols: 1.5 },
    { rows: 0 },
    { rows: 1001 },
    { rows: 2 },
    { lines: "text" },
    { lines: [1, 2, 3] },
    { lines: ["x".repeat(10001), "", ""] },
    { extra: true },
  ])
    expect(() => parseCapture({ ...capture, ...patch }, "fixture")).toThrow();
  expect(() => parseCapture(null, "fixture")).toThrow();
  const root = await fixture();
  for (const agentId of ["../outside", "a.b", "/absolute", "x".repeat(41), "shell"]) {
    await expect(saveCapture(root, { ...capture, agentId }, active)).rejects.toThrow();
    await expect(testCaptureRules(root, agentId, [])).rejects.toThrow("invalid_request");
  }
  await expect(
    saveCapture(
      root,
      { ...capture, lines: Array.from({ length: 1000 }, () => "x".repeat(5000)), rows: 1000 },
      active,
    ),
  ).rejects.toThrow("unavailable");
});
test("rejects links, special entries, malformed JSON, mismatched labels and oversized directories", async () => {
  const root = await fixture();
  const outside = await fixture();
  await writeFile(join(outside, "screen.json"), JSON.stringify(capture), { mode: 0o600 });
  await saveCapture(root, capture, active);
  const path = join(root, "captures/fixture/blocked-1.json");
  for (const text of ["{", JSON.stringify({ ...capture, expected: "idle" })]) {
    await writeFile(path, text);
    await expect(testCaptureRules(root, "fixture", [rule])).rejects.toThrow();
  }
  await rm(path);
  await symlink(join(outside, "screen.json"), path);
  await expect(testCaptureRules(root, "fixture", [rule])).rejects.toThrow();
  await rm(path);
  await mkdir(path);
  await expect(testCaptureRules(root, "fixture", [rule])).rejects.toThrow();
  await rm(path, { recursive: true });
  await writeFile(join(root, "captures/fixture/bad.json"), "{}", { mode: 0o600 });
  await expect(testCaptureRules(root, "fixture", [rule])).rejects.toThrow();
  await rm(join(root, "captures/fixture/bad.json"));
  await Promise.all(
    Array.from({ length: 1001 }, (_, n) =>
      writeFile(join(root, `captures/fixture/other-${String(n + 1)}.json`), "{}", { mode: 0o600 }),
    ),
  );
  await expect(testCaptureRules(root, "fixture", [rule])).rejects.toThrow("unavailable");
  await rm(join(root, "captures"), { recursive: true });
  await symlink(outside, join(root, "captures"), process.platform === "win32" ? "junction" : "dir");
  await expect(saveCapture(root, capture, active)).rejects.toThrow("unavailable");
  await expect(testCaptureRules(root, "fixture", [rule])).rejects.toThrow("unavailable");
  await expect(testCaptureRules(join(root, "captures"), "fixture", [])).rejects.toThrow(
    "unavailable",
  );
});
test("revocation cancels persistence and replay without exposing screen text", async () => {
  const root = await fixture();
  let checks = 0;
  await expect(
    saveCapture(root, capture, () => {
      if (++checks > 5) throw Error("revoked");
    }),
  ).rejects.toThrow("revoked");
  const file = await saveCapture(root, capture, active);
  await expect(
    testCaptureRules(root, "fixture", [rule], () => {
      throw Error("revoked");
    }),
  ).rejects.toThrow("revoked");
  expect(JSON.parse(await readFile(join(root, file), "utf8"))).toEqual(capture);
});
test("offline validation reports capture mismatches for manifest files and bundled agents without screen text", async () => {
  const root = await fixture();
  await mkdir(join(root, "agents"));
  const manifest = object(JSON.parse(OWNED_FILES["examples/agent.json"] ?? "{}"));
  manifest["id"] = "fixture";
  object(manifest["attention"])["rules"] = [];
  await writeFile(join(root, "agents/fixture.json"), JSON.stringify(manifest));
  await saveCapture(root, capture, active);
  const result = await validateConfig(join(root, "agents/fixture.json"));
  expect(result.code).toBe(1);
  expect(JSON.stringify(result)).toContain("Saved screen captures fail attention rules");
  expect(JSON.stringify(result)).not.toContain("Approve?");
  await saveCapture(root, { ...capture, agentId: "claude" }, active);
  const all = await validateConfig(root);
  expect(all.code).toBe(1);
  expect(all.problems.some((row) => row.file === "captures/claude")).toBe(true);
  await rm(join(root, "captures/claude"), { recursive: true });
});

test("revocation after publication rolls back the capture and removes temporary files", async () => {
  const root = await fixture();
  await expect(
    saveCapture(root, capture, () => {
      if (existsSync(join(root, "captures/fixture/blocked-1.json"))) throw Error("revoked");
    }),
  ).rejects.toThrow("revoked");
  expect(await readdir(join(root, "captures/fixture"))).toEqual([]);
});
test("exhausted capture numbers preserve every existing file", async () => {
  const root = await fixture();
  await saveCapture(root, capture, active);
  await Promise.all(
    Array.from({ length: 999 }, (_, n) =>
      writeFile(join(root, `captures/fixture/blocked-${String(n + 2)}.json`), "preserve", {
        mode: 0o600,
      }),
    ),
  );
  await expect(saveCapture(root, capture, active)).rejects.toThrow("capacity");
  expect(await readFile(join(root, "captures/fixture/blocked-1000.json"), "utf8")).toBe("preserve");
  expect((await readdir(join(root, "captures/fixture"))).length).toBe(1000);
});
