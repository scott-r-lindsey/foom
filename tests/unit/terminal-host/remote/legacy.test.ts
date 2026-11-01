import type * as hostPlatform from "../../../../src/terminal-host/remote/host-platform";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { createServer, type Server } from "node:net";
import { chmod, mkdir, mkdtemp, rm, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
const mock = vi.hoisted(() => ({ ps: vi.fn(), kill: vi.fn<typeof process.kill>() }));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: mock.ps }),
}));
// Keep the legacy protocol/End regression cases on their captured ps fixtures.
vi.mock("../../../../src/terminal-host/remote/host-platform", async (original) => {
  const platform = await original<typeof hostPlatform>();
  return { ...platform, daemonHostPlatform: platform.createHostPlatform("darwin") };
});
import * as paths from "../../../../src/terminal-host/remote/private-path";
import { legacyDaemon, endLegacyDaemon } from "../../../../src/terminal-host/remote/legacy";
import { remoteFrame, RemoteFrames } from "../../../../src/shared/remote-host-protocol";
let home: string;
let server: Server | undefined;
let executable: string;
const build = "a".repeat(64);
const started = "Thu Oct 29 21:00:00 2026";
beforeEach(async () => {
  vi.clearAllMocks();
  home = await mkdtemp(join(tmpdir(), "lg-"));
  const directory = join(home, ".foom-host", "0.1.0", build);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  executable = join(directory, "foom-host");
  await writeFile(executable, "fixture, never executed", { mode: 0o700 });
  mock.ps.mockResolvedValue({ stdout: ` 424242 ${started} ${executable} --daemon\n` });
  mock.kill.mockReturnValue(true);
  vi.spyOn(process, "kill").mockImplementation(mock.kill);
});
afterEach(async () => {
  if (server?.listening)
    await new Promise<void>((resolve) =>
      server?.close(() => {
        resolve();
      }),
    );
  server = undefined;
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});
async function serve(count = 2, acceptBuild = build, malformed: boolean | "stall" = false) {
  server = createServer((socket) => {
    const frames = new RemoteFrames();
    socket.on("error", () => {});
    socket.on("data", (bytes: Buffer) => {
      frames.push(bytes, (message) => {
        if (!message || typeof message !== "object" || !("type" in message))
          throw new Error("Bad fixture");
        if (malformed === "stall") return;
        if (message.type === "hello") {
          if (!("build" in message) || message.build !== acceptBuild) {
            socket.destroy();
            return;
          }
          socket.write(remoteFrame({ type: "hello", build: acceptBuild }));
        } else {
          expect(message).toEqual({
            type: "manage",
            operation: "inspect",
            codeFolder: "/code",
            agents: [],
          });
          socket.end(
            remoteFrame(
              malformed
                ? { type: "exit", id: "unexpected", code: 0 }
                : {
                    type: "managed",
                    result: {
                      ok: true,
                      facts: {
                        codeFolder: "/code",
                        version: "0.1.0",
                        sessions: count,
                        cores: 1,
                        load: [0, 0, 0],
                        memoryTotal: 1,
                        memoryAvailable: 1,
                        agents: [],
                      },
                    },
                  },
            ),
          );
        }
      });
    });
  });
  const path = join(home, ".foom-host", "host.sock");
  server.listen(path);
  await once(server, "listening");
  await chmod(path, 0o600);
}
test.skipIf(process.platform === "win32")(
  "legacy sessions are counted without attaching or signaling, and End binds exact executable/PID/start",
  async () => {
    await serve();
    const observed = await legacyDaemon(home, "/code");
    expect(observed).toEqual({ executable, pid: 424242, started, count: 2 });
    expect(mock.kill).not.toHaveBeenCalled();
    if (!observed) throw new Error("No daemon");
    await endLegacyDaemon(observed);
    expect(mock.kill).toHaveBeenCalledExactlyOnceWith(424242, "SIGTERM");
    mock.ps.mockResolvedValueOnce({ stdout: ` 424243 ${started} ${executable} --daemon\n` });
    await expect(endLegacyDaemon(observed)).rejects.toThrow("changed");
    mock.ps.mockResolvedValueOnce({ stdout: "" });
    await expect(endLegacyDaemon(observed)).rejects.toThrow("changed");
    await chmod(executable, 0o777);
    await expect(endLegacyDaemon(observed)).rejects.toThrow("changed");
  },
);
test.skipIf(process.platform === "win32")(
  "absent or empty legacy daemons need no process lookup or mutation",
  async () => {
    expect(await legacyDaemon(home, "/code")).toBeUndefined();
    await serve(0);
    expect(await legacyDaemon(home, "/code")).toBeUndefined();
    expect(mock.ps).not.toHaveBeenCalled();
    expect(mock.kill).not.toHaveBeenCalled();
  },
);
test.skipIf(process.platform === "win32")(
  "legacy probing tries only bounded safe cached identities and rejects unexpected peers",
  async () => {
    const second = "b".repeat(64);
    const other = join(home, ".foom-host", "0.1.0", second);
    await mkdir(other, { mode: 0o700 });
    await writeFile(join(other, "foom-host"), "fixture", { mode: 0o700 });
    await serve(2, second);
    mock.ps.mockResolvedValueOnce({
      stdout: ` 424242 ${started} ${join(other, "foom-host")} --daemon\n`,
    });
    expect((await legacyDaemon(home, "/code"))?.count).toBe(2);
    await chmod(other, 0o777);
    await expect(legacyDaemon(home, "/code")).rejects.toThrow("Unsafe");
    await chmod(other, 0o700);
    await rm(join(other, "foom-host"));
    await symlink(executable, join(other, "foom-host"));
    await expect(legacyDaemon(home, "/code")).rejects.toThrow("Unsafe");
  },
);
test.skipIf(process.platform === "win32")(
  "malformed replies and missing/ambiguous process identity cannot authorize End",
  async () => {
    await serve(2, build, true);
    await expect(legacyDaemon(home, "/code")).rejects.toThrow("unavailable");
  },
);
test.skipIf(process.platform === "win32")(
  "ambiguous or absent process matches fail closed",
  async () => {
    await serve();
    for (const stdout of [
      "bad process list",
      ` 1 ${started} ${executable} --daemon\n`,
      ` 424242 ${started} ${executable} --daemon\n 424243 ${started} ${executable} --daemon\n`,
    ]) {
      mock.ps.mockResolvedValueOnce({ stdout });
      await expect(legacyDaemon(home, "/code")).rejects.toThrow("identity unavailable");
    }
    mock.ps.mockRejectedValueOnce(new Error("ps failed"));
    await expect(legacyDaemon(home, "/code")).rejects.toThrow("ps failed");
    expect(mock.kill).not.toHaveBeenCalled();
  },
);

test.skipIf(process.platform === "win32")(
  "a stale socket and a stalled peer have bounded failures without signaling",
  async () => {
    await serve();
    const path = join(home, ".foom-host", "host.sock");
    const moved = `${path}.stale`;
    await rename(path, moved);
    await new Promise<void>((resolve) => {
      server?.close(() => {
        resolve();
      });
    });
    await rename(moved, path);
    await expect(legacyDaemon(home, "/code")).rejects.toThrow("unavailable");
    await rm(path);
    await serve(2, build, "stall");
    await expect(legacyDaemon(home, "/code")).rejects.toThrow("unavailable");
    expect(mock.kill).not.toHaveBeenCalled();
  },
);
test.skipIf(process.platform === "win32")(
  "socket replacement, excessive cache identities and unsafe versions fail closed",
  async () => {
    await serve();
    const checked = vi.spyOn(paths, "checkSocket");
    checked
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("replaced");
      });
    await expect(legacyDaemon(home, "/code")).rejects.toThrow("unavailable");
    checked.mockRestore();
    const version = join(home, ".foom-host", "0.1.0");
    await chmod(version, 0o777);
    await expect(legacyDaemon(home, "/code")).rejects.toThrow("Unsafe");
    await chmod(version, 0o700);
    await writeFile(join(version, "not-a-build"), "ignored");
    for (let index = 0; index < 33; index++) {
      const directory = join(version, index.toString(16).padStart(64, "0"));
      await mkdir(directory, { mode: 0o700 });
      await writeFile(join(directory, "foom-host"), "fixture", { mode: 0o700 });
    }
    await expect(legacyDaemon(home, "/code")).rejects.toThrow("limit");
    expect(mock.kill).not.toHaveBeenCalled();
  },
);

test.skipIf(process.platform === "win32")(
  "cancelled inspection and cleanup leave no work or signal behind",
  async () => {
    await serve(2, build, "stall");
    const cancellation = new AbortController();
    const pending = legacyDaemon(home, "/code", cancellation.signal);
    const assertion = expect(pending).rejects.toThrow();
    await new Promise<void>((resolve) => setImmediate(resolve));
    cancellation.abort();
    await assertion;
    await expect(legacyDaemon(home, "/code", cancellation.signal)).rejects.toThrow("cancelled");
    await expect(
      endLegacyDaemon({ executable, pid: 424242, started, count: 2 }, cancellation.signal),
    ).rejects.toThrow("changed");
    expect(mock.kill).not.toHaveBeenCalled();
  },
);

// The OS implementation changes, while the confirmed End guard stays the same.
test.skipIf(process.platform === "win32")(
  "Linux start-time mismatch refuses legacy End",
  async () => {
    const { daemonHostPlatform } = await import(
      "../../../../src/terminal-host/remote/host-platform"
    );
    const { linuxHostPlatform } = await import(
      "../../../../src/terminal-host/remote/host-platform-linux"
    );
    const proc = join(home, "proc");
    await mkdir(join(proc, "424242"), { recursive: true });
    const stat = (ticks: string) =>
      `424242 (foom host) S ${[...Array<string>(18).fill("0"), ticks].join(" ")}\n`;
    await writeFile(join(proc, "424242", "stat"), stat("1234"));
    await writeFile(join(proc, "424242", "cmdline"), `${executable}\0--daemon\0`);
    const platform = linuxHostPlatform(proc);
    vi.spyOn(daemonHostPlatform, "processIdentity").mockImplementation((executable, signal) =>
      platform.processIdentity(executable, signal),
    );
    await serve();
    const observed = await legacyDaemon(home, "/code");
    expect(observed?.started).toBe("1234");
    if (!observed) throw new Error("No daemon");
    await writeFile(join(proc, "424242", "stat"), stat("5678"));
    await expect(endLegacyDaemon(observed)).rejects.toThrow("changed");
    expect(mock.kill).not.toHaveBeenCalled();
  },
);
