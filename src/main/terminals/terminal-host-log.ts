import type { HostExitDiagnostic, HostNearMiss } from "./terminal-host-diagnostics";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { privateDirectory, atomicPrivate } from "../../node-common/private-files";
import { readOwnedFile } from "../../node-common/owned-files";

type History = { exits: string[]; timeouts: string[]; nearMisses: string[] };
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
    cause: ["watchdog-kill", "foom-kill", "host-exit"].includes(String(value["cause"]))
      ? value["cause"]
      : undefined,
    snapshot: safeSnapshot(value["snapshot"]),
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
function number(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function safeSnapshot(value: unknown): unknown {
  if (!object(value)) return undefined;
  return {
    liveTerminals: number(value["liveTerminals"]),
    hostMemoryKB: number(value["hostMemoryKB"]),
    lastMessageAgeMs: number(value["lastMessageAgeMs"]),
    mainLagMs: number(value["mainLagMs"]),
  };
}
function safeNearMiss(line: string): string {
  const value: unknown = JSON.parse(line);
  if (!object(value) || !["late-reply", "late-drain", "late-turn"].includes(String(value["kind"])))
    throw new Error("Invalid host diagnostics");
  return JSON.stringify({
    time: value["time"],
    kind: value["kind"],
    replyLatencyMs: number(value["replyLatencyMs"]),
    probeElapsedMs: number(value["probeElapsedMs"]),
    lateCycles: number(value["lateCycles"]),
    mainLagMs: number(value["mainLagMs"]),
  });
}
async function persist(profile: string, batch: History): Promise<void> {
  try {
    if (!batch.exits.length && !batch.timeouts.length && !batch.nearMisses.length) {
      try {
        await lstat(join(profile, "terminal-host-diagnostics"));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
        throw error;
      }
    }
    const directory = await privateDirectory(profile, "terminal-host-diagnostics");
    let history: History = { exits: [], timeouts: [], nearMisses: [] };
    try {
      const previous: unknown = JSON.parse(
        await readOwnedFile(join(directory, "exits.json"), 2 * 1024 * 1024),
      );
      if (strings(previous)) history.exits = previous;
      else if (
        object(previous) &&
        (previous["version"] === 2 || previous["version"] === 3) &&
        strings(previous["exits"]) &&
        strings(previous["timeouts"])
      )
        history = {
          exits: previous["exits"],
          timeouts: previous["timeouts"],
          nearMisses: strings(previous["nearMisses"]) ? previous["nearMisses"] : [],
        };
      else throw new Error("Invalid host diagnostics");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      if (!batch.exits.length && !batch.timeouts.length && !batch.nearMisses.length) return;
    }
    await atomicPrivate(directory, "exits.json", {
      version: 3,
      exits: [...history.exits, ...batch.exits].slice(-32).map(safeExit),
      timeouts: [...history.timeouts, ...batch.timeouts].slice(-16),
      nearMisses: [...history.nearMisses, ...batch.nearMisses].slice(-16).map(safeNearMiss),
    });
  } catch {
    console.error("Unable to persist terminal host diagnostics");
  }
}
function enqueue(profile: string, kind?: keyof History, line?: string): void {
  const batch = pending.get(profile) ?? { exits: [], timeouts: [], nearMisses: [] };
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
export function recordHostNearMiss(profile: string, record: HostNearMiss): void {
  enqueue(
    profile,
    "nearMisses",
    safeNearMiss(JSON.stringify({ time: new Date().toISOString(), ...record })),
  );
}
export function flushHostExits(): Promise<void> {
  return writes;
}
