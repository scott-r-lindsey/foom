import { mkdtemp, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { AgentProbes } from "../../../../src/main/agents/probes";
import { agentProvider } from "../../../../src/main/agents/providers/registry";
import type { TerminalSpec } from "../../../../src/shared/desktop";
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture(limit = 600000) {
  const cwd = await mkdtemp(join(tmpdir(), "foom-probe-unit-"));
  roots.push(cwd);
  const backend = {
    create: vi.fn((_spec: TerminalSpec) => Promise.resolve("terminal")),
    stop: vi.fn(() => Promise.resolve()),
    kill: vi.fn(() => Promise.resolve()),
    reply: vi.fn(() => Promise.resolve()),
    screen: vi.fn(() => Promise.resolve({ lines: ["approve?"], title: "ready" })),
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
        conversationId: "conversation",
      }),
    ),
  };
  const probes = new AgentProbes(backend, "/config", operations, limit);
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
  return { cwd, backend, operations, probes, token, start };
}
test("owns unguessable probes, drives only the owner and exposes visible JSON", async () => {
  const f = await fixture();
  try {
    const probe = await f.start();
    expect(probe).toMatch(/^[a-f0-9]{64}$/u);
    const foreign = f.probes.grant();
    for (const action of ["screen", "state", "stop", "send", "keys", "wait"])
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
    await f.probes.call(f.token, { action: "send", probe, text: "yes" });
    await f.probes.call(f.token, { action: "keys", probe, key: "ctrl-c" });
    expect(f.backend.reply.mock.calls).toEqual([
      ["terminal", "yes\r"],
      ["terminal", "\x03"],
    ]);
    expect(await f.probes.call(f.token, { action: "screen", probe })).toEqual({
      lines: ["approve?"],
      title: "ready",
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
