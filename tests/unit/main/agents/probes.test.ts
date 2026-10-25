import { mkdtemp, access, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { AgentProbes } from "../../../../src/main/agents/probes";
import {
  agentProvider,
  replaceConfigProviders,
} from "../../../../src/main/agents/providers/registry";
import type { TerminalSpec } from "../../../../src/shared/desktop";
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture(limit = 600000) {
  const cwd = await mkdtemp(join(tmpdir(), "foom-probe-unit-"));
  const configRoot = await mkdtemp(join(tmpdir(), "foom-probe-config-"));
  roots.push(cwd, configRoot);
  const backend = {
    create: vi.fn((_spec: TerminalSpec) => Promise.resolve("terminal")),
    stop: vi.fn(() => Promise.resolve()),
    kill: vi.fn(() => Promise.resolve()),
    reply: vi.fn(() => Promise.resolve()),
    screen: vi.fn<() => Promise<{ lines: string[]; title: string; cols?: number; rows?: number }>>(
      () => Promise.resolve({ lines: ["approve?"], title: "ready", cols: 80, rows: 1 }),
    ),
    show: vi.fn(() => Promise.resolve()),
    removed: vi.fn(),
  };
  const provider = agentProvider("claude");
  const operations = {
    environment: vi.fn(() => Promise.resolve({ PATH: "/fixture" })),
    scratch: vi.fn(() => Promise.resolve(cwd)),
    provider: vi.fn(() => Promise.resolve(provider)),
    prepare: vi.fn(() =>
      Promise.resolve({
        spec: { command: "/fixture/claude", args: [], cwd, cols: 80, rows: 24 },
        dispose: vi.fn(),
        agentVersion: "1.2.3",
        conversationId: "conversation",
      }),
    ),
  };
  const probes = new AgentProbes(backend, configRoot, operations, limit);
  const token = probes.grant();
  const start = async () => {
    const result: unknown = await probes.call(token, { action: "start", agent: "claude" });
    if (
      typeof result !== "object" ||
      result === null ||
      !("probe" in result) ||
      typeof result.probe !== "string"
    )
      throw Error("Missing probe");
    return result.probe;
  };
  return { cwd, configRoot, backend, operations, probes, token, start };
}
test("owns unguessable probes, drives only the owner and exposes visible JSON", async () => {
  const f = await fixture();
  try {
    const probe = await f.start();
    expect(probe).toMatch(/^[a-f0-9]{64}$/u);
    const foreign = f.probes.grant();
    for (const action of ["screen", "state", "events", "stop", "send", "keys", "wait"])
      await expect(
        f.probes.call(foreign, {
          action,
          probe,
          ...(action === "send"
            ? { text: "secret" }
            : action === "keys"
              ? { key: "enter" }
              : action === "wait"
                ? { quiet: 1 }
                : {}),
        }),
      ).rejects.toThrow("not_found");
    await expect(f.start()).rejects.toThrow("conflict");
    expect(await f.probes.call(f.token, { action: "events", probe })).toEqual({
      hooks: [],
      mcp: { connected: false, listedTools: false, pinged: false },
    });
    await f.probes.call(f.token, { action: "send", probe, text: "yes" });
    await f.probes.call(f.token, { action: "keys", probe, key: "ctrl-c" });
    expect(f.backend.reply.mock.calls).toEqual([
      ["terminal", "yes\r"],
      ["terminal", "\x03"],
    ]);
    expect(await f.probes.call(f.token, { action: "screen", probe })).toEqual({
      lines: ["approve?"],
      title: "ready",
      cols: 80,
      rows: 1,
    });
    expect(await f.probes.call(f.token, { action: "state", probe })).toMatchObject({
      state: "needs_input",
      hookEvent: null,
      conversationId: "conversation",
    });
    await f.probes.call(f.token, { action: "stop", probe });
    await expect(access(f.cwd)).rejects.toThrow();
    expect(f.backend.stop).toHaveBeenCalledWith("terminal");
    expect(f.backend.kill).toHaveBeenCalledWith("terminal");
    await expect(f.probes.call(f.token, { action: "screen", probe })).rejects.toThrow("not_found");
    await expect(f.probes.call("bad", { action: "screen", probe })).rejects.toThrow("unauthorized");
  } finally {
    await f.probes.close();
  }
});
test("quiet waits reset on output, timeout waits do not, and lifetime terminates", async () => {
  const f = await fixture(10000);
  vi.useFakeTimers();
  try {
    const probe = await f.start();
    let done = false;
    const quiet = f.probes.call(f.token, { action: "wait", probe, quiet: 2 }).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(1000);
    f.probes.output("terminal");
    await vi.advanceTimersByTimeAsync(1500);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    await quiet;
    done = false;
    const timeout = f.probes.call(f.token, { action: "wait", probe, timeout: 2 }).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(1000);
    f.probes.output("terminal");
    f.probes.output("unrelated");
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await timeout;
    const waiting = f.probes.call(f.token, { action: "wait", probe, quiet: 600 });
    const refused = expect(waiting).rejects.toThrow("not_found");
    await vi.advanceTimersByTimeAsync(5000);
    await refused;
    await f.probes.close();
    expect(f.backend.stop).toHaveBeenCalledTimes(1);
    await expect(access(f.cwd)).rejects.toThrow();
  } finally {
    vi.useRealTimers();
    await f.probes.close();
  }
});
test("rechecks ownership after reads and revokes on config exit", async () => {
  const f = await fixture();
  const probe = await f.start();
  let resolve!: (value: { lines: string[]; title: string }) => void;
  f.backend.screen.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const reading = f.probes.call(f.token, { action: "screen", probe });
  const rejected = expect(reading).rejects.toThrow("not_found");
  await f.probes.revoke(f.token);
  resolve({ lines: ["secret"], title: "secret" });
  await rejected;
  await expect(f.probes.call(f.token, { action: "state", probe })).rejects.toThrow("unauthorized");
  await f.probes.close();
});
test.each(["provider", "environment", "scratch", "prepare", "create", "show"] as const)(
  "cleans up failed %s and releases the reserved slot",
  async (stage) => {
    const f = await fixture();
    const method = stage === "create" || stage === "show" ? f.backend[stage] : f.operations[stage];
    method.mockRejectedValueOnce(Error("fixture failure"));
    await expect(f.start()).rejects.toThrow("fixture failure");
    expect(f.operations.prepare.mock.calls.length).toBeLessThanOrEqual(1);
    await f.probes.close();
  },
);
test("cleanup awaits a launch revoked while PTY creation is pending", async () => {
  const f = await fixture();
  let resolve!: (id: string) => void;
  f.backend.create.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const starting = f.start();
  const rejected = expect(starting).rejects.toThrow("not_found");
  await vi.waitFor(() => {
    expect(f.backend.create).toHaveBeenCalled();
  });
  const closing = f.probes.close();
  resolve("late-terminal");
  await rejected;
  await closing;
  expect(f.backend.kill).toHaveBeenCalledWith("late-terminal");
  await expect(access(f.cwd)).rejects.toThrow();
});
test("probe exit and duplicate stop clean up once", async () => {
  const f = await fixture();
  const probe = await f.start();
  await Promise.all([
    f.probes.exited("unrelated"),
    f.probes.exited("terminal"),
    f.probes.exited("terminal"),
  ]);
  expect(f.backend.kill).toHaveBeenCalledTimes(1);
  await expect(f.probes.call(f.token, { action: "screen", probe })).rejects.toThrow("not_found");
  await f.probes.close();
});

test("separate config credentials can probe concurrently without cross-reading", async () => {
  const f = await fixture();
  const other = f.probes.grant();
  f.backend.create.mockResolvedValueOnce("first-terminal").mockResolvedValueOnce("second-terminal");
  const secondCwd = await mkdtemp(join(tmpdir(), "foom-probe-second-"));
  roots.push(secondCwd);
  f.operations.scratch.mockResolvedValueOnce(f.cwd).mockResolvedValueOnce(secondCwd);
  try {
    const first = await f.start();
    const second: unknown = await f.probes.call(other, {
      action: "start",
      agent: "claude",
      resume: "resumed-conversation",
    });
    if (
      typeof second !== "object" ||
      second === null ||
      !("probe" in second) ||
      typeof second.probe !== "string"
    )
      throw Error("Missing second probe");
    expect(second.probe).not.toBe(first);
    await expect(
      f.probes.call(f.token, { action: "send", probe: second.probe, text: "secret" }),
    ).rejects.toThrow("not_found");
    expect(f.backend.reply).not.toHaveBeenCalled();
    await f.probes.revoke(f.token);
    expect(await f.probes.call(other, { action: "state", probe: second.probe })).toMatchObject({
      conversationId: "resumed-conversation",
    });
    expect(f.backend.kill).toHaveBeenCalledWith("first-terminal");
    expect(f.backend.kill).not.toHaveBeenCalledWith("second-terminal");
  } finally {
    await f.probes.close();
  }
});

test("expiry can address a host ID while its create acknowledgement is pending", async () => {
  const f = await fixture();
  const prepared = {
    spec: { id: "reserved-host", command: "fixture", args: [], cwd: f.cwd, cols: 80, rows: 24 },
    dispose: vi.fn(),
    agentVersion: "1.2.3",
    conversationId: "conversation",
  };
  f.operations.prepare.mockResolvedValueOnce(prepared);
  let created!: (id: string) => void;
  f.backend.create.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        created = resolve;
      }),
  );
  const starting = f.start();
  const refused = expect(starting).rejects.toThrow("not_found");
  await vi.waitFor(() => {
    expect(f.backend.create).toHaveBeenCalledWith(expect.objectContaining({ id: "reserved-host" }));
  });
  const closing = f.probes.close();
  await vi.waitFor(() => {
    expect(f.backend.stop).toHaveBeenCalledWith("reserved-host");
  });
  created("reserved-host");
  await refused;
  await closing;
  expect(f.backend.kill).toHaveBeenCalledWith("reserved-host");
});

test("stale screens after probe input, output or revocation cannot raise driver attention", async () => {
  const f = await fixture();
  try {
    await f.start();
    f.probes.input("terminal");
    vi.useFakeTimers();
    for (const change of [
      () => {
        f.probes.input("terminal");
      },
      () => {
        f.probes.output("terminal");
      },
    ]) {
      const read = Promise.withResolvers<{ lines: string[]; title: string }>();
      f.backend.screen.mockReturnValueOnce(read.promise);
      const work = f.probes.quiet("terminal");
      change();
      read.resolve({ lines: ["Continue? (y/n)"], title: "probe" });
      await work;
      await vi.advanceTimersByTimeAsync(60000);
      expect(f.probes.waitingAt(f.token)).toBeUndefined();
    }
    await f.probes.quiet("missing");
    await f.probes.quiet("terminal");
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.probes.waitingAt(f.token)).toBeDefined();
    f.backend.screen.mockResolvedValueOnce({ lines: ["Working"], title: "working" });
    await f.probes.quiet("terminal");
    expect(f.probes.waitingAt(f.token)).toBeUndefined();
    const read = Promise.withResolvers<{ lines: string[]; title: string }>();
    f.backend.screen.mockReturnValueOnce(read.promise);
    const work = f.probes.quiet("terminal");
    await f.probes.revoke(f.token);
    read.resolve({ lines: ["Continue? (y/n)"], title: "probe" });
    await work;
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.probes.waitingAt(f.token)).toBeUndefined();
  } finally {
    await f.probes.close();
  }
});

test("config status is refreshed only for a live config credential and never grants decisions", async () => {
  const f = await fixture();
  const status = {
    folder: "/config",
    available: true,
    pending: {
      id: "digest",
      file: "settings.json",
      action: "change arguments",
      detail: "agentArguments.fixturecode",
    },
    rejected: [],
  };
  const read = vi.fn(() => Promise.resolve(status));
  const broker = new AgentProbes({ ...f.backend, configStatus: read }, "/config", f.operations);
  const token = broker.grant();
  try {
    await expect(broker.call("foreign", { action: "config-status" })).rejects.toThrow(
      "unauthorized",
    );
    expect(read).not.toHaveBeenCalled();
    expect(() => broker.call(token, { action: "config-status", decision: "allow" })).toThrow(
      "invalid_request",
    );
    await expect(broker.call(token, { action: "config-status" })).resolves.toEqual(status);
    let resolve: ((value: typeof status) => void) | undefined;
    read.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = broker.call(token, { action: "config-status" });
    await broker.revoke(token);
    resolve?.(status);
    await expect(pending).rejects.toThrow("unauthorized");
    await expect(f.probes.call(f.token, { action: "config-status" })).rejects.toThrow(
      "unavailable",
    );
  } finally {
    await broker.close();
    await f.probes.close();
  }
});

test("credential-owned events and state reflect accepted hooks without exposing payloads", async () => {
  const f = await fixture();
  let action: "ready" | "working" | "needs_input" | "failed" | "classify" = "ready";
  f.operations.prepare.mockImplementation(() =>
    Promise.resolve({
      spec: { command: "/fixture/claude", args: [], cwd: f.cwd, cols: 80, rows: 24 },
      dispose: vi.fn(),
      agentVersion: "1.2.3",
      conversationId: "conversation",
      events: () => ({ hooks: [], mcp: { connected: true, listedTools: true, pinged: true } }),
      hook: () => ({
        terminalId: "probe",
        action,
        caseId: "observed",
        signal: "plugin:fixture:observed",
      }),
    }),
  );
  try {
    const probe = await f.start();
    expect(await f.probes.call(f.token, { action: "events", probe })).toEqual({
      hooks: [],
      mcp: { connected: true, listedTools: true, pinged: true },
    });
    for (const [next, state] of [
      ["ready", "quiet_ok"],
      ["working", "working"],
      ["needs_input", "needs_input"],
      ["failed", "failed"],
      ["classify", "needs_input"],
    ] as const) {
      action = next;
      expect(await f.probes.call(f.token, { action: "state", probe })).toMatchObject({
        state,
        hookEvent: "observed",
      });
    }
  } finally {
    await f.probes.close();
  }
});

test("capture save and rule replay are credential-bound and keep screen text out of responses", async () => {
  const f = await fixture();
  try {
    const probe = await f.start();
    const saved = await f.probes.call(f.token, { action: "screen", probe, save: "other" });
    expect(saved).toEqual({ capture: "captures/claude/other-1.json" });
    const capture: unknown = JSON.parse(
      await readFile(join(f.configRoot, "captures/claude/other-1.json"), "utf8"),
    );
    expect(capture).toMatchObject({
      agentVersion: "1.2.3",
      cols: 80,
      rows: 1,
      lines: ["approve?"],
    });
    const report = await f.probes.call(f.token, { action: "test-rules", agent: "claude" });
    expect(report).toMatchObject({
      passed: true,
      captures: [{ expected: "other", actual: "other", ruleId: null }],
    });
    expect(JSON.stringify(report)).not.toContain("approve?");
    await expect(
      f.probes.call("foreign", { action: "test-rules", agent: "claude" }),
    ).rejects.toThrow("unauthorized");
    const read = Promise.withResolvers<{
      lines: string[];
      title: string;
      cols: number;
      rows: number;
    }>();
    f.backend.screen.mockReturnValueOnce(read.promise);
    const saving = f.probes.call(f.token, { action: "screen", probe, save: "idle" });
    const refused = expect(saving).rejects.toThrow("not_found");
    await f.probes.revoke(f.token);
    read.resolve({ lines: ["private"], title: "idle", cols: 80, rows: 1 });
    await refused;
    await expect(access(join(f.configRoot, "captures/claude/idle-1.json"))).rejects.toThrow();
  } finally {
    await f.probes.close();
  }
});

test("rule replay rechecks a revoked token after provider validation and accepts providers without validators", async () => {
  const f = await fixture();
  const base = agentProvider("claude");
  const plain = { ...base };
  delete plain.validate;
  const provider = {
    ...plain,
    id: "fixture",
    model: {
      ...base.model,
      id: "fixture",
      attention: {
        ...base.model.attention,
        rules: [
          {
            id: "working",
            state: "working" as const,
            priority: 100,
            region: "bottom" as const,
            lines: 3,
            match: { contains: ["busy"], regex: [] },
            not: [],
            reason: "Busy",
            comment: "Fixture",
          },
        ],
      },
    },
  };
  try {
    replaceConfigProviders([provider]);
    await expect(
      f.probes.call(f.token, { action: "test-rules", agent: "fixture" }),
    ).resolves.toMatchObject({ passed: true, captures: [] });
    const validated = Promise.withResolvers<undefined>();
    replaceConfigProviders([{ ...provider, validate: () => validated.promise }]);
    const pending = f.probes.call(f.token, { action: "test-rules", agent: "fixture" });
    const refused = expect(pending).rejects.toThrow("unauthorized");
    await f.probes.revoke(f.token);
    validated.resolve(undefined);
    await refused;
  } finally {
    replaceConfigProviders([]);
    await f.probes.close();
  }
});
test("saving refuses a backend screen without actual dimensions", async () => {
  const f = await fixture();
  try {
    const probe = await f.start();
    f.backend.screen.mockResolvedValueOnce({ lines: ["private"], title: "title" });
    await expect(
      f.probes.call(f.token, { action: "screen", probe, save: "other" }),
    ).rejects.toThrow("unavailable");
  } finally {
    await f.probes.close();
  }
});

test("stop awaits attachment cleanup before deleting the scratch repository", async () => {
  const f = await fixture();
  const disposed = Promise.withResolvers<undefined>();
  const dispose = vi.fn(() => disposed.promise);
  f.operations.prepare.mockImplementation(() =>
    Promise.resolve({
      spec: { command: "/fixture/claude", args: [], cwd: f.cwd, cols: 80, rows: 24 },
      dispose,
      agentVersion: "1.2.3",
      conversationId: "conversation",
    }),
  );
  try {
    const probe = await f.start();
    const stopping = f.probes.call(f.token, { action: "stop", probe });
    await vi.waitFor(() => {
      expect(dispose).toHaveBeenCalledOnce();
    });
    await expect(access(f.cwd)).resolves.toBeUndefined();
    disposed.resolve(undefined);
    await stopping;
    await expect(access(f.cwd)).rejects.toThrow();
  } finally {
    disposed.resolve(undefined);
    await f.probes.close();
  }
});
