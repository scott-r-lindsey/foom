import { randomUUID } from "node:crypto";
import { link, lstat, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { ControlError, exact, object } from "./control-validation";
import { createPrivateFile, privateDirectory, verifyPrivate } from "./private-files";
import { validAgentId } from "../shared/providers/catalog";
import type { CaptureReport, ProbeCapture } from "../shared/probe-capture";
import type { AgentRule } from "../shared/agent-rule-types";
import { evaluateScreenRules } from "../shared/providers/screen-rules";
import { readOwnedFile } from "./owned-files";

const unavailable = (): never => {
  throw new ControlError("unavailable");
};
const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
function screenLines(value: unknown, rows: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length === rows &&
    value.every((line: unknown) => typeof line === "string" && line.length <= 10000)
  );
}
/** Captures are local untrusted data. Never include their text or parser errors in diagnostics. */
export function parseCapture(input: unknown, agentId: string): ProbeCapture {
  const value = object(input);
  exact(value, [
    "version",
    "agentId",
    "agentVersion",
    "expected",
    "lines",
    "title",
    "cols",
    "rows",
  ]);
  const { version, agentVersion, expected, lines, title, cols, rows } = value;
  if (
    version !== 1 ||
    value["agentId"] !== agentId ||
    !validAgentId(agentId) ||
    typeof agentVersion !== "string" ||
    agentVersion.length > 4096 ||
    (expected !== "working" &&
      expected !== "blocked" &&
      expected !== "idle" &&
      expected !== "other") ||
    typeof title !== "string" ||
    title.length > 4096 ||
    typeof cols !== "number" ||
    !Number.isSafeInteger(cols) ||
    cols < 1 ||
    cols > 1000 ||
    typeof rows !== "number" ||
    !Number.isSafeInteger(rows) ||
    rows < 1 ||
    rows > 1000 ||
    !screenLines(lines, rows)
  )
    return unavailable();
  return { version, agentId, agentVersion, expected, lines, title, cols, rows };
}
async function directory(root: string, agentId: string, create: boolean, active: () => void) {
  if (!validAgentId(agentId)) throw new ControlError("invalid_request");
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return unavailable();
  const canonical = await realpath(root);
  const checkRoot = async () => {
    const current = await lstat(root);
    if (
      !current.isDirectory() ||
      current.dev !== rootInfo.dev ||
      current.ino !== rootInfo.ino ||
      (await realpath(root)) !== canonical
    )
      unavailable();
  };
  let parent = root;
  const checks: (() => Promise<void>)[] = [checkRoot];
  for (const name of ["captures", agentId]) {
    await checkRoot();
    active();
    const path = join(parent, name);
    try {
      if (create) await privateDirectory(parent, name);
      else await verifyPrivate(path, true);
    } catch (error) {
      if (!create && missing(error)) return undefined;
      throw error;
    }
    const identity = await lstat(path);
    checks.push(async () => {
      await verifyPrivate(path, true);
      const current = await lstat(path);
      if (current.dev !== identity.dev || current.ino !== identity.ino) unavailable();
    });
    active();
    parent = path;
  }
  const check = async (authorize = true) => {
    for (const verify of checks) await verify();
    if (authorize) active();
  };
  await check();
  return { path: parent, check };
}
/** Publish a complete private file with an exclusive hard link, never an overwriting rename. */
export async function saveCapture(
  root: string,
  capture: ProbeCapture,
  active: () => void,
): Promise<string> {
  const parsed = parseCapture(capture, capture.agentId);
  const content = JSON.stringify(parsed);
  if (Buffer.byteLength(content) > 4 * 1024 * 1024) return unavailable();
  const target = await directory(root, parsed.agentId, true, active);
  if (!target) return unavailable();
  const temporary = join(target.path, `${randomUUID()}.tmp`);
  const handle = await createPrivateFile(temporary);
  try {
    active();
    await handle.writeFile(content);
    active();
    await handle.sync();
    active();
    await handle.close();
    active();
    for (let n = 1; n <= 1000; n++) {
      await target.check();
      const file = `${parsed.expected}-${String(n)}.json`;
      const destination = join(target.path, file);
      try {
        await link(temporary, destination);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") continue;
        throw error;
      }
      try {
        await target.check();
      } catch (error) {
        // A revoked caller can remove its own just-published file, but a redirected
        // directory must never turn cleanup into deletion outside this store.
        await target.check(false);
        await rm(destination, { force: true });
        throw error;
      }
      return `captures/${parsed.agentId}/${file}`;
    }
    throw new ControlError("capacity");
  } finally {
    await handle.close();
    await target.check(false);
    await rm(temporary, { force: true });
  }
}
/** Reuse the live classifier's rule evaluator, including priority, exclusions, regions and budget. */
export async function testCaptureRules(
  root: string,
  agentId: string,
  rules: AgentRule[],
  active: () => void = () => {},
): Promise<CaptureReport> {
  const target = await directory(root, agentId, false, active);
  const captures: CaptureReport["captures"] = [];
  if (target) {
    const files = await readdir(target.path);
    if (files.length > 1000) return unavailable();
    for (const file of files.sort()) {
      if (!/^(working|blocked|idle|other)-[1-9][0-9]{0,3}\.json$/u.test(file)) return unavailable();
      await target.check();
      const capture = parseCapture(
        JSON.parse(await readOwnedFile(join(target.path, file), 4 * 1024 * 1024)),
        agentId,
      );
      await target.check();
      if (!file.startsWith(`${capture.expected}-`)) return unavailable();
      const rule = evaluateScreenRules(
        { title: capture.title, progress: null },
        capture.lines,
        rules,
      );
      const actual = rule && rule.state !== "unknown" ? rule.state : "other";
      captures.push({
        file: `captures/${agentId}/${file}`,
        expected: capture.expected,
        actual,
        ruleId: rule?.id ?? null,
        passed: capture.expected === actual,
      });
    }
  }
  active();
  return { agentId, captures, passed: captures.every((capture) => capture.passed) };
}
