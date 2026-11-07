import { mkdtemp, readFile, stat, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import {
  recordHostExit,
  recordHostTimeout,
  recordHostNearMiss,
  initializeHostLog,
  flushHostExits,
} from "../../../../src/main/terminals/terminal-host-log";
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
  const read = async (): Promise<unknown> => {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof value !== "object" || value === null || !("exits" in value))
      throw new Error("Invalid history");
    return value.exits;
  };
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

test("a real xterm parser error cannot put terminal-supplied parameters in the durable log", async () => {
  const { Terminal } = await import("@xterm/headless");
  const { format } = await import("node:util");
  const profile = await mkdtemp(join(tmpdir(), "foom-parser-log-"));
  const marker = "10821082";
  let stderr = "";
  const error = vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    stderr += format(...values);
  });
  const terminal = new Terminal({ allowProposedApi: true });
  try {
    await new Promise<void>((resolve) => {
      terminal.write(`\x1b[${marker}\u00a0`, resolve);
    });
  } finally {
    terminal.dispose();
    error.mockRestore();
  }
  expect(stderr).toContain("Parsing error");
  expect(stderr).toContain(marker);
  const input = { ...diagnostic, stderr };
  recordHostExit(profile, input);
  await flushHostExits();
  expect(
    await readFile(join(profile, "terminal-host-diagnostics", "exits.json"), "utf8"),
  ).not.toContain(marker);
});

test("timeout storms have a separate bounded reserve and cannot erase exits or payload privacy", async () => {
  const profile = await mkdtemp(join(tmpdir(), "foom-timeout-log-"));
  recordHostExit(profile, diagnostic);
  for (let elapsed = 10000; elapsed < 10050; elapsed++)
    recordHostTimeout(profile, "attach", elapsed);
  await flushHostExits();
  const raw = await readFile(join(profile, "terminal-host-diagnostics", "exits.json"), "utf8");
  const value: unknown = JSON.parse(raw);
  expect(value).toMatchObject({
    version: 3,
    exits: [expect.stringContaining('"reason":"crashed"')],
  });
  expect(raw.match(/elapsedMs/g)).toHaveLength(16);
  expect(raw).toContain("10049");
  expect(raw).not.toContain("stderr");
  expect(raw).not.toContain('"id"');
});

test("startup sanitizes old stderr records without adding an exit or timeout", async () => {
  const profile = await mkdtemp(join(tmpdir(), "foom-legacy-log-"));
  const directory = join(profile, "terminal-host-diagnostics");
  await mkdir(directory, { mode: 0o700 });
  const path = join(directory, "exits.json");
  await writeFile(
    path,
    JSON.stringify([
      JSON.stringify({
        ...diagnostic,
        stderr: "TERMINAL_MARKER",
        gone: { type: "Utility", reason: "crashed", exitCode: 9, payload: "TERMINAL_MARKER" },
      }),
    ]),
    { mode: 0o600 },
  );
  initializeHostLog(profile);
  await flushHostExits();
  const raw = await readFile(path, "utf8");
  expect(raw).not.toContain("TERMINAL_MARKER");
  expect(raw).not.toContain("stderr");
  expect(JSON.parse(raw)).toMatchObject({
    version: 3,
    exits: [expect.stringContaining('"exitCode":9')],
    timeouts: [],
  });
});

test("invalid fixed timeout metadata is ignored and missing startup history stays absent", async () => {
  const profile = await mkdtemp(join(tmpdir(), "foom-empty-log-"));
  initializeHostLog(profile);
  recordHostTimeout(profile, "UNTRUSTED_CONTENT", 10000);
  recordHostTimeout(profile, null, 10000);
  recordHostTimeout(profile, "tail", -1);
  recordHostTimeout(profile, "tail", 1.5);
  recordHostTimeout(profile, "tail", Infinity);
  await flushHostExits();
  await expect(
    readFile(join(profile, "terminal-host-diagnostics", "exits.json")),
  ).rejects.toThrow();
});

test("near-miss reserve is bounded independently, sanitized and retained on restart", async () => {
  const profile = await mkdtemp(join(tmpdir(), "foom-near-miss-log-"));
  const path = join(profile, "terminal-host-diagnostics", "exits.json");
  recordHostExit(profile, {
    ...diagnostic,
    cause: "watchdog-kill",
    snapshot: {
      liveTerminals: 2,
      hostMemoryKB: null,
      lastMessageAgeMs: 15000,
      mainLagMs: 120,
    },
  });
  for (let i = 0; i < 50; i++)
    recordHostNearMiss(profile, {
      kind: "late-drain",
      replyLatencyMs: null,
      probeElapsedMs: 5000 + i,
      lateCycles: i,
      mainLagMs: 100,
      ...{ terminal: "PRIVATE_CONTENT" },
    });
  await flushHostExits();
  vi.resetModules();
  const restarted = await import("../../../../src/main/terminals/terminal-host-log");
  restarted.initializeHostLog(profile);
  await restarted.flushHostExits();
  const raw = await readFile(path, "utf8");
  const history: unknown = JSON.parse(raw);
  if (
    typeof history !== "object" ||
    history === null ||
    !("nearMisses" in history) ||
    !("exits" in history) ||
    !Array.isArray(history.nearMisses) ||
    !Array.isArray(history.exits)
  )
    throw new Error("Missing history");
  expect(history.nearMisses).toHaveLength(16);
  expect(history.exits).toHaveLength(1);
  const exit: unknown = history.exits[0];
  if (typeof exit !== "string") throw new Error("Missing exit");
  expect(JSON.parse(exit)).toMatchObject({
    cause: "watchdog-kill",
    snapshot: {
      liveTerminals: 2,
      hostMemoryKB: null,
      lastMessageAgeMs: 15000,
      mainLagMs: 120,
    },
  });
  const nearMiss: unknown = history.nearMisses[15];
  if (typeof nearMiss !== "string") throw new Error("Missing near miss");
  expect(JSON.parse(nearMiss)).toMatchObject({ probeElapsedMs: 5049 });
  expect(raw).not.toContain("PRIVATE_CONTENT");
});
