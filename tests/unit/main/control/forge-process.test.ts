import type * as ChildProcessModule from "node:child_process";
import type * as Fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { ChildProcess, execFile, spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { access, realpath, stat } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { executeForge, resolveForgeExecutable } from "../../../../src/main/control/forge-process";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof ChildProcessModule>();
  return {
    ...actual,
    spawn: vi.fn(),
    execFile: vi.fn(
      (_file: string, _args: readonly string[], _options: unknown, callback: () => void) => {
        callback();
      },
    ),
  };
});
vi.mock("node:fs/promises", () => ({ access: vi.fn(), realpath: vi.fn(), stat: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function childFixture(pid: number | undefined = 12345) {
  const child = new ChildProcess();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  child.stdout = stdout;
  child.stderr = stderr;
  Object.defineProperty(child, "pid", { value: pid, configurable: true });
  const kill = vi.spyOn(child, "kill").mockImplementation(() => {
    queueMicrotask(() => child.emit("close", null));
    return true;
  });
  vi.mocked(spawn).mockReturnValue(child);
  return { child, stdout, stderr, kill };
}
it("uses fixed system taskkill tree arguments on Windows and waits for close", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.stubEnv("SystemRoot", "/windows");
  const { kill } = childFixture();
  const controller = new AbortController();
  const pending = executeForge(
    "/fixture/gh.exe",
    ["auth", "status"],
    "/neutral",
    {},
    controller.signal,
  );
  controller.abort();
  await expect(pending).rejects.toThrow("cancelled");
  expect(execFile).toHaveBeenCalledWith(
    expect.stringMatching(/System32[/\\]taskkill\.exe$/u),
    ["/pid", "12345", "/T", "/F"],
    { windowsHide: true, timeout: 5000 },
    expect.any(Function),
  );
  expect(kill).toHaveBeenCalledWith("SIGKILL");
  expect(spawn).toHaveBeenCalledWith(
    "/fixture/gh.exe",
    ["auth", "status"],
    expect.objectContaining({ cwd: "/neutral", shell: false, detached: false }),
  );
});
it("refuses missing system roots before spawning and handles absent PIDs/group termination failure", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.stubEnv("SystemRoot", "");
  let fixture = childFixture();
  let controller = new AbortController();
  let pending = executeForge("/fixture", [], "/neutral", {}, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow("unavailable");
  expect(fixture.kill).not.toHaveBeenCalled();
  vi.stubEnv("SystemRoot", "/windows");
  fixture = childFixture();
  Object.defineProperty(fixture.child, "pid", { value: undefined });
  controller = new AbortController();
  pending = executeForge("/fixture", [], "/neutral", {}, controller.signal);
  controller.abort();
  fixture.child.emit("error", new Error("secret-token"));
  fixture.child.emit("close", -1);
  await expect(pending).rejects.toThrow("cancelled");
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  fixture = childFixture();
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw new Error("already exited");
  });
  controller = new AbortController();
  pending = executeForge("/fixture", [], "/neutral", {}, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow("cancelled");
  expect(fixture.kill).toHaveBeenCalled();
});
it("bounds combined stdout/stderr and handles abort occurring while spawn returns", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const fixture = childFixture();
  vi.spyOn(process, "kill").mockImplementation(() => {
    queueMicrotask(() => fixture.child.emit("close", null));
    return true;
  });
  let pending = executeForge("/fixture", [], "/neutral", {}, new AbortController().signal);
  fixture.stdout.write("x".repeat(128 * 1024));
  fixture.stderr.write("x".repeat(128 * 1024 + 1));
  fixture.stderr.write("extra");
  await expect(pending).rejects.toThrow("unavailable");
  const controller = new AbortController();
  vi.mocked(spawn).mockImplementation(() => {
    controller.abort();
    return fixture.child;
  });
  pending = executeForge("/fixture", [], "/neutral", {}, controller.signal);
  await expect(pending).rejects.toThrow("cancelled");
});
it("retains numeric exit codes and separate bounded streams without raw error causes", async () => {
  const { child, stdout, stderr } = childFixture();
  const pending = executeForge("/fixture", [], "/neutral", {}, new AbortController().signal);
  stdout.write("[]");
  stderr.write("diagnostic");
  child.emit("close", 8);
  expect(await pending).toEqual({ code: 8, stdout: "[]", stderr: "diagnostic" });
});
it("Windows resolution skips wrappers and non-files and selects only canonical native files", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.mocked(realpath)
    .mockResolvedValueOnce("/bin/gh.cmd")
    .mockResolvedValueOnce("/bin/gh.com")
    .mockResolvedValueOnce("/bin/gh.exe");
  vi.mocked(access).mockResolvedValue(undefined);
  const fs = await vi.importActual<typeof Fs>("node:fs/promises");
  const directory = await fs.stat(tmpdir());
  const file = await fs.stat(process.execPath);
  vi.mocked(stat).mockResolvedValueOnce(directory).mockResolvedValueOnce(file);
  expect((await resolveForgeExecutable(["gh"], "/bin")).executable).toBe("/bin/gh.exe");
});
