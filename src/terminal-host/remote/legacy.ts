import { daemonHostPlatform } from "./host-platform";
import { lstatSync, readdirSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { RemoteFrames, remoteFrame, remoteResponse } from "../../shared/remote-host-protocol";
import { checkSocket } from "./private-path";

export interface LegacyDaemon {
  executable: string;
  pid: number;
  started: string;
  count: number;
}
function owned(path: string, directory: boolean): boolean {
  const info = lstatSync(path);
  return (
    !info.isSymbolicLink() &&
    (directory ? info.isDirectory() : info.isFile()) &&
    info.uid === process.getuid?.() &&
    (info.mode & 0o022) === 0
  );
}
function inspect(
  socketPath: string,
  build: string,
  codeFolder: string,
  signal?: AbortSignal,
): Promise<number | undefined> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const frames = new RemoteFrames();
    let negotiated = false;
    let settled = false;
    const finish = (count?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", cancelled);
      socket.destroy();
      resolve(count);
    };
    const cancelled = () => {
      finish();
    };
    const deadline = setTimeout(() => {
      finish();
    }, 1000);
    signal?.addEventListener("abort", cancelled, { once: true });
    if (signal?.aborted) finish();
    socket.once("connect", () => {
      try {
        checkSocket(socketPath);
        socket.write(remoteFrame({ type: "hello", build }));
      } catch {
        finish();
      }
    });
    socket.on("data", (bytes: Buffer) => {
      try {
        frames.push(bytes, (value) => {
          if (!remoteResponse(value)) throw new Error("Invalid legacy response");
          if (!negotiated) {
            if (value.type !== "hello" || value.build !== build)
              throw new Error("Legacy build mismatch");
            negotiated = true;
            socket.write(
              remoteFrame({ type: "manage", operation: "inspect", codeFolder, agents: [] }),
            );
          } else {
            if (value.type !== "managed" || !value.result.ok || value.result.facts.sessions > 32)
              throw new Error("Legacy inventory unavailable");
            finish(value.result.facts.sessions);
          }
        });
      } catch {
        finish();
      }
    });
    socket.once("error", () => {
      finish();
    });
    socket.once("close", () => {
      finish();
    });
  });
}
/** Old daemons have no session enumeration. Inspect only their existing management API. */
export async function legacyDaemon(
  home: string,
  codeFolder: string,
  signal?: AbortSignal,
): Promise<LegacyDaemon | undefined> {
  if (signal?.aborted) throw new Error("Legacy inspection cancelled");
  const root = join(home, ".foom-host");
  const socket = join(root, "host.sock");
  try {
    checkSocket(socket);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const candidates: { executable: string; build: string }[] = [];
  for (const version of readdirSync(root)) {
    if (!/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/u.test(version)) continue;
    const directory = join(root, version);
    if (!owned(directory, true)) throw new Error("Unsafe legacy cache");
    for (const build of readdirSync(directory)) {
      if (!/^[a-f0-9]{64}$/u.test(build)) continue;
      const cached = join(directory, build);
      const executable = join(cached, "foom-host");
      if (!owned(cached, true) || !owned(executable, false)) throw new Error("Unsafe legacy cache");
      candidates.push({ executable, build });
      if (candidates.length > 32) throw new Error("Legacy cache limit");
    }
  }
  for (const candidate of candidates) {
    if (signal?.aborted) throw new Error("Legacy inspection cancelled");
    const count = await inspect(socket, candidate.build, codeFolder, signal);
    if (count === undefined) continue;
    if (!count) return undefined;
    const identity = await daemonHostPlatform.processIdentity(candidate.executable, signal);
    if (!identity) throw new Error("Legacy daemon identity unavailable");
    return { ...identity, executable: candidate.executable, count };
  }
  throw new Error("Legacy daemon unavailable");
}
/** End explicitly authorizes all sessions in this exact legacy daemon. Never an upgrade path. */
export async function endLegacyDaemon(daemon: LegacyDaemon, signal?: AbortSignal): Promise<void> {
  const current = await daemonHostPlatform.processIdentity(daemon.executable, signal);
  if (
    signal?.aborted ||
    current?.pid !== daemon.pid ||
    current.started !== daemon.started ||
    !owned(daemon.executable, false)
  )
    throw new Error("Legacy daemon changed");
  process.kill(daemon.pid, "SIGTERM");
}
