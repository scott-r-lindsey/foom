import type { HostExitDiagnostic } from "./terminal-host-diagnostics";
import { join } from "node:path";
import { privateDirectory, atomicPrivate } from "../../node-common/private-files";
import { readOwnedFile } from "../../node-common/owned-files";

// Store JSON records as bounded lines; the private atomic JSON file contains this
// array of strings. Never pass request/response payloads or PTY data to this sink.
let writes: Promise<void> = Promise.resolve();
export function recordHostExit(profile: string, diagnostic: HostExitDiagnostic): void {
  // Explicit fields prevent future callers from accidentally persisting payloads.
  const line = JSON.stringify({
    time: new Date().toISOString(),
    reason: diagnostic.reason,
    serviceName: diagnostic.serviceName,
    pid: diagnostic.pid,
    exitCode: diagnostic.exitCode ?? null,
    gone: diagnostic.gone,
    stderr: diagnostic.stderr,
  });
  writes = writes.then(async () => {
    try {
      const directory = await privateDirectory(profile, "terminal-host-diagnostics");
      let records: string[] = [];
      try {
        const previous: unknown = JSON.parse(
          await readOwnedFile(join(directory, "exits.json"), 2 * 1024 * 1024),
        );
        if (
          !Array.isArray(previous) ||
          !previous.every((line: unknown) => typeof line === "string")
        )
          throw new Error("Invalid host diagnostics");
        records = previous;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      await atomicPrivate(directory, "exits.json", [...records.slice(-31), line]);
    } catch {
      // Storage failure must not interrupt terminal recovery or expose paths/data.
      console.error("Unable to persist terminal host diagnostics");
    }
  });
}
export function flushHostExits(): Promise<void> {
  return writes;
}
