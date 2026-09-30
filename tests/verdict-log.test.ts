import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { VerdictLog } from "../src/verdict-log";

const dirs: string[] = [];
async function directory(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "foom-verdict-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
it("persists ordered verdicts and next actions without terminal contents", async () => {
  const dir = await directory();
  const log = new VerdictLog(dir);
  const records = await Promise.all(
    ["replied", "dismissed", "ignored"].map((terminalId) =>
      log.evaluate({ terminalId, tail: ["secret-token-private"] }),
    ),
  );
  for (const action of ["replied", "dismissed", "ignored"] as const) {
    const record = records.find((entry) => entry.terminalId === action);
    if (!record) throw new Error("Missing verdict");
    await log.recordAction(action, record.id, action);
    await expect(log.recordAction(action, record.id, action)).rejects.toThrow(
      "Invalid verdict feedback",
    );
  }
  const text = await readFile(path.join(dir, "verdicts.jsonl"), "utf8");
  const lines: unknown[] = text
    .trim()
    .split("\n")
    .map((line): unknown => JSON.parse(line));
  expect(lines).toHaveLength(6);
  expect(lines[0]).toMatchObject({
    type: "verdict",
    terminalId: "replied",
    verdict: { state: "working" },
  });
  expect(lines[4]).toMatchObject({
    type: "action",
    action: "dismissed",
    feedback: "not_attention",
  });
  expect(lines[3]).toMatchObject({ feedback: null });
  expect(text).not.toContain("secret-token-private");
  if (process.platform !== "win32")
    expect((await stat(path.join(dir, "verdicts.jsonl"))).mode & 0o777).toBe(0o600);
  await new VerdictLog(dir).evaluate({ terminalId: "next", tail: [] });
  expect(
    (await readFile(path.join(dir, "verdicts.jsonl"), "utf8")).trim().split("\n"),
  ).toHaveLength(7);
});
it("rejects unknown and cross-terminal feedback, and reserves the next action", async () => {
  const log = new VerdictLog(await directory());
  await expect(log.evaluate({ terminalId: "bad\nID", tail: [] })).rejects.toThrow(
    "Invalid terminal ID",
  );
  const record = await log.evaluate({ terminalId: "t1", tail: [] });
  await expect(log.recordAction("t2", record.id, "dismissed")).rejects.toThrow();
  await expect(log.recordAction("t1", "unknown", "ignored")).rejects.toThrow();
  // Exercise runtime validation without weakening the typed public API.
  await expect(
    Reflect.apply(log.recordAction.bind(log), log, ["t1", record.id, "opened"]),
  ).rejects.toThrow();
  const first = log.recordAction("t1", record.id, "replied");
  await expect(log.recordAction("t1", record.id, "ignored")).rejects.toThrow();
  await first;
});
it("reports filesystem failures and allows retry after recovery", async () => {
  const root = await directory();
  const dir = path.join(root, "data");
  await writeFile(dir, "not a directory");
  const log = new VerdictLog(dir);
  await expect(log.evaluate({ terminalId: "t1", tail: [] })).rejects.toThrow();
  await rm(dir);
  const record = await log.evaluate({ terminalId: "t1", tail: [] });
  await rm(dir, { recursive: true });
  await writeFile(dir, "not a directory");
  await expect(log.recordAction("t1", record.id, "ignored")).rejects.toThrow();
  await rm(dir);
  await log.recordAction("t1", record.id, "ignored");
});

it("logs model verdicts through the injected classifier without model prose or tails", async () => {
  const { ModelEvaluator } = await import("../src/model-evaluator");
  const model = new ModelEvaluator({
    complete: () => Promise.resolve('{"state":"needs_input","confidence":0.9}'),
  });
  const dir = await directory();
  const log = new VerdictLog(dir, (input) => model.evaluate(input));
  const record = await log.evaluate({ terminalId: "t1", tail: ["private terminal prose"] });
  expect(record.verdict).toMatchObject({ state: "needs_input", signal: "model:classification" });
  await log.recordAction("t1", record.id, "dismissed");
  const text = await readFile(path.join(dir, "verdicts.jsonl"), "utf8");
  expect(text).not.toContain("private terminal prose");
  expect(text).toContain("not_attention");
});
