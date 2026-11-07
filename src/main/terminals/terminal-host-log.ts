import type { HostExitDiagnostic } from "./terminal-host-diagnostics";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { privateDirectory, atomicPrivate } from "../../node-common/private-files";
import { readOwnedFile } from "../../node-common/owned-files";

type History = { exits: string[]; timeouts: string[] };
const commands = new Set<string>([
  "create",
  "theme",
  "attach",
  "detach",
  "kill",
  "stop",
  "shutdown",
  "screen",
  "write",
  "child-input",
  "resize",
  "acknowledge",
  "tail",
  "ping",
]);
let writes: Promise<void> = Promise.resolve();
let draining = false;
const pending = new Map<string, History>();

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === "string");
}
/** Rebuild legacy records from safe metadata; raw stderr and extra fields are erased. */
function safeExit(line: string): string {
  const value: unknown = JSON.parse(line);
  if (
    !object(value) ||
    typeof value["reason"] !== "string" ||
    typeof value["serviceName"] !== "string"
  )
    throw new Error("Invalid host diagnostics");
  const gone = value["gone"];
  return JSON.stringify({
    time: value["time"],
    reason: value["reason"],
    serviceName: value["serviceName"],
    pid: value["pid"],
    exitCode: value["exitCode"] ?? null,
    gone: object(gone)
      ? { type: gone["type"], reason: gone["reason"], exitCode: gone["exitCode"] }
      : undefined,
  });
}
async function persist(profile: string, batch: History): Promise<void> {
  try {
    if (!batch.exits.length && !batch.timeouts.length) {
      try {
        await lstat(join(profile, "terminal-host-diagnostics"));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
        throw error;
      }
    }
    const directory = await privateDirectory(profile, "terminal-host-diagnostics");
    let history: History = { exits: [], timeouts: [] };
    try {
      const previous: unknown = JSON.parse(
        await readOwnedFile(join(directory, "exits.json"), 2 * 1024 * 1024),
      );
      if (strings(previous)) history.exits = previous;
      else if (
        object(previous) &&
        previous["version"] === 2 &&
        strings(previous["exits"]) &&
        strings(previous["timeouts"])
      )
        history = { exits: previous["exits"], timeouts: previous["timeouts"] };
      else throw new Error("Invalid host diagnostics");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      if (!batch.exits.length && !batch.timeouts.length) return;
    }
    await atomicPrivate(directory, "exits.json", {
      version: 2,
      exits: [...history.exits, ...batch.exits].slice(-32).map(safeExit),
      timeouts: [...history.timeouts, ...batch.timeouts].slice(-16),
    });
  } catch {
    console.error("Unable to persist terminal host diagnostics");
  }
}
function enqueue(profile: string, kind?: keyof History, line?: string): void {
  const batch = pending.get(profile) ?? { exits: [], timeouts: [] };
  if (kind && line) batch[kind] = [...batch[kind], line].slice(kind === "exits" ? -32 : -16);
  pending.set(profile, batch);
  if (draining) return;
  draining = true;
  writes = writes.then(async () => {
    try {
      for (const [profile, batch] of pending) {
        pending.delete(profile);
        await persist(profile, batch);
      }
    } finally {
      draining = false;
    }
  });
}
/** Startup also purges stderr from earlier versions, without adding an exit record. */
export function initializeHostLog(profile: string): void {
  enqueue(profile);
}
export function recordHostExit(profile: string, diagnostic: HostExitDiagnostic): void {
  enqueue(
    profile,
    "exits",
    safeExit(JSON.stringify({ time: new Date().toISOString(), ...diagnostic })),
  );
}
export function recordHostTimeout(profile: string, command: unknown, elapsedMs: number): void {
  if (
    typeof command !== "string" ||
    !commands.has(command) ||
    !Number.isSafeInteger(elapsedMs) ||
    elapsedMs < 0
  )
    return;
  enqueue(
    profile,
    "timeouts",
    JSON.stringify({ time: new Date().toISOString(), command, elapsedMs }),
  );
}
export function flushHostExits(): Promise<void> {
  return writes;
}
