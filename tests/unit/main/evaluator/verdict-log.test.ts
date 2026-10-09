import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { VerdictLog } from "../../../../src/main/evaluator/verdict-log";

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

it("classifies without writing, and only committed verdicts accept feedback", async () => {
  const dir = await directory();
  const log = new VerdictLog(dir);
  const record = await log.classify({ terminalId: "t1", tail: ["Continue? (y/n)"] });
  expect(record.verdict.state).toBe("needs_input");
  await expect(readFile(path.join(dir, "verdicts.jsonl"), "utf8")).rejects.toThrow();
  await expect(log.recordAction("t1", record.id, "dismissed")).rejects.toThrow(
    "Invalid verdict feedback",
  );
  await expect(log.classify({ terminalId: "bad id", tail: [] })).rejects.toThrow(
    "Invalid terminal ID",
  );
  await log.commit(record);
  await log.recordAction("t1", record.id, "dismissed");
});

it("keeps only the latest feedback target per terminal and forgets removed terminals", async () => {
  const log = new VerdictLog(await directory());
  const other = await log.evaluate({ terminalId: "t2", tail: [] });
  const records = [];
  for (let index = 0; index < 20; index += 1)
    records.push(await log.evaluate({ terminalId: "t1", tail: [] }));
  const latest = records.pop();
  if (!latest) throw new Error("Missing verdict");
  for (const record of records)
    await expect(log.recordAction("t1", record.id, "ignored")).rejects.toThrow();
  await log.recordAction("t1", latest.id, "ignored");
  log.forget("t2");
  await expect(log.recordAction("t2", other.id, "ignored")).rejects.toThrow();
});

it("does not restore feedback when a terminal is removed during a commit or failed action", async () => {
  const root = await directory();
  const dir = path.join(root, "data");
  const log = new VerdictLog(dir);
  const record = await log.classify({ terminalId: "t1", tail: [] });
  const writing = log.commit(record);
  log.forget("t1");
  await writing;
  await expect(log.recordAction("t1", record.id, "ignored")).rejects.toThrow();
  await log.commit(record);
  await rm(dir, { recursive: true });
  await writeFile(dir, "not a directory");
  const action = log.recordAction("t1", record.id, "ignored");
  log.forget("t1");
  await expect(action).rejects.toThrow();
  await rm(dir);
  await expect(log.recordAction("t1", record.id, "ignored")).rejects.toThrow();
});
