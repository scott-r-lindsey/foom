import { mkdtemp, readFile, stat, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { recordHostExit, flushHostExits } from "../../../../src/main/terminals/terminal-host-log";
vi.mock("../../../../src/node-common/private-file-permissions", () => ({
  windowsAcl: vi.fn().mockResolvedValue(undefined),
}));
const diagnostic = {
  reason: "crashed",
  serviceName: "host-fixture",
  exitCode: 9,
  pid: 123,
  stderr: "native failure",
};

test("private diagnostic history survives a new module instance, flushes and bounds retention", async () => {
  const profile = await mkdtemp(join(tmpdir(), "foom-host-log-"));
  const path = join(profile, "terminal-host-diagnostics", "exits.json");
  const read = async (): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));
  recordHostExit(profile, {
    ...diagnostic,
    gone: { type: "Utility", reason: "crashed", exitCode: 9 },
  });
  await flushHostExits();
  expect(await read()).toEqual([expect.stringContaining('"reason":"crashed"')]);
  if (process.platform !== "win32") {
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(profile, "terminal-host-diagnostics"))).mode & 0o777).toBe(0o700);
  }
  vi.resetModules();
  const restarted = await import("../../../../src/main/terminals/terminal-host-log");
  restarted.recordHostExit(profile, { ...diagnostic, reason: "liveness-timeout" });
  await restarted.flushHostExits();
  expect(await read()).toEqual([
    expect.stringContaining('"reason":"crashed"'),
    expect.stringContaining('"reason":"liveness-timeout"'),
  ]);
  for (let index = 0; index < 33; index++) recordHostExit(profile, { ...diagnostic, pid: index });
  await flushHostExits();
  expect(await read()).toHaveLength(32);
  expect(await readFile(path, "utf8")).toContain('\\"pid\\":32');
});

test.each(["malformed", "wrong shape", "unavailable", "redirected"])(
  "log storage errors stay contained: %s",
  async (mode) => {
    const profile = await mkdtemp(join(tmpdir(), "foom-host-log-"));
    const directory = join(profile, "terminal-host-diagnostics");
    const path = join(directory, "exits.json");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    if (mode === "unavailable") await writeFile(directory, "occupied");
    else if (mode === "redirected") {
      const target = await mkdtemp(join(tmpdir(), "foom-host-log-target-"));
      await symlink(target, directory, "junction");
    } else {
      await mkdir(directory, { mode: 0o700 });
      await writeFile(path, mode === "malformed" ? "{" : "[1]", { mode: 0o600 });
    }
    recordHostExit(profile, diagnostic);
    await flushHostExits();
    expect(error).toHaveBeenCalledWith("Unable to persist terminal host diagnostics");
    error.mockRestore();
  },
);

test("missing exit codes are explicit and unrelated fields cannot enter the durable log", async () => {
  const profile = await mkdtemp(join(tmpdir(), "foom-host-log-"));
  const input = {
    reason: "liveness-timeout",
    serviceName: "fixture",
    stderr: "",
    terminal: "private terminal contents",
  };
  recordHostExit(profile, input);
  await flushHostExits();
  const text = await readFile(join(profile, "terminal-host-diagnostics", "exits.json"), "utf8");
  expect(text).toContain('\\"exitCode\\":null');
  expect(text).not.toContain(input.terminal);
});
