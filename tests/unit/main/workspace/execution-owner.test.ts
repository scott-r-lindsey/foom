import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import piModelError from "../../../fixtures/agent-detection/pi-model-error.json";
import { agentProvider } from "../../../../src/main/agents/providers/registry";
import { reduceV2 } from "../../../../src/shared/agent-hook-events";
import { V2ExecutionHooks, V2Health } from "../../../../src/main/agents/providers/v2-health";
import { VerdictLog } from "../../../../src/main/evaluator/verdict-log";
import { isReply } from "../../../../src/main/terminals/terminal-reports";
import { ExecutionOwner } from "../../../../src/main/workspace/execution-owner";
import type { ExecutionOwnerDependencies } from "../../../../src/main/workspace/execution-owner";
import { evaluateRules } from "../../../../src/main/evaluator/evaluator";
import type { EvaluationInput, VerdictRecord } from "../../../../src/shared/evaluator";
import type { HookSignal } from "../../../../src/shared/hooks";
import type { TerminalState } from "../../../../src/shared/workspace";

function deferred<T>() {
  return Promise.withResolvers<T>();
}

function setup(agent: boolean | string = false) {
  let closed = false;
  let count = 0;
  let waiting = 0;
  let unread: number | undefined;
  let tail = ["Continue? (y/n)"];
  const states: TerminalState[] = [];
  const queues = new Map<string, Promise<void>>();
  const record = (input: EvaluationInput): VerdictRecord => ({
    id: `v${String(++count)}`,
    terminalId: input.terminalId,
    timestamp: "now",
    verdict: evaluateRules(input),
  });
  const deps: ExecutionOwnerDependencies = {
    terminal: vi.fn<ExecutionOwnerDependencies["terminal"]>(() =>
      agent
        ? {
            kind: "agent",
            agent: typeof agent === "string" ? agent : "claude",
            attention: typeof agent === "string" ? "evaluator" : "hooks",
          }
        : { kind: "shell", agent: "shell", attention: "evaluator" },
    ),
    tail: vi.fn(() => Promise.resolve(tail)),
    verdicts: {
      classify: vi.fn((input: EvaluationInput) => Promise.resolve(record(input))),
      commit: vi.fn(() => Promise.resolve()),
      forget: vi.fn(),
      recordAction: vi.fn(() => Promise.resolve()),
    },
    enqueue: (id, work) => {
      const next = (queues.get(id) ?? Promise.resolve())
        .then(async () => {
          if (owner.has(id) && !closed) await work();
        })
        .catch((error: unknown) => {
          console.error("Unable to evaluate terminal:", error);
        });
      queues.set(id, next);
      return next;
    },
    closed: () => closed,
    refresh: vi.fn(),
    recheck: vi.fn(),
    exited: vi.fn(),
    reset: vi.fn(),
    publishChildEvents: vi.fn(),
    waitingOn: () => waiting,
    unreadAt: () => unread,
    onExecution: vi.fn(),
    onState: vi.fn((state: TerminalState) => {
      states.push(state);
    }),
    now: () => 123,
  };
  const owner = new ExecutionOwner(deps);
  owner.ensure("t1");
  if (agent) owner.launched("t1");
  const hook = (action: HookSignal["action"], extra: Partial<HookSignal> = {}) =>
    owner.hook("t1", { terminalId: "launch-key", action, signal: `plugin:${action}`, ...extra });
  return {
    owner,
    deps,
    states,
    record,
    hook,
    close: () => {
      closed = true;
    },
    tail: (value: string[]) => {
      tail = value;
    },
    waiting: (value: number) => {
      waiting = value;
    },
    unread: (value: number | undefined) => {
      unread = value;
    },
  };
}

afterEach(() => vi.restoreAllMocks());

test("classifies host tails and publishes committed verdicts with revisions and child events", async () => {
  const { owner, deps } = setup();
  owner.output("t1");
  await owner.quiet("t1");
  expect(deps.tail).toHaveBeenCalledWith("t1", 40);
  expect(owner.currentState("t1")).toMatchObject({
    state: "needs_input",
    verdictId: "v1",
    outputRevision: 1,
    inputRevision: 0,
    timestamp: 123,
  });
  expect(deps.publishChildEvents).toHaveBeenCalledTimes(2);
  await owner.quiet("t1");
  expect(deps.verdicts.commit).toHaveBeenCalledTimes(1);
});

test("host failure still classifies hooks and final exit", async () => {
  const { owner, deps, hook } = setup(true);
  vi.mocked(deps.tail).mockRejectedValue(new Error("host unavailable"));
  await hook("needs_input");
  expect(owner.currentState("t1")?.state).toBe("needs_input");
  await owner.exited("t1", 2);
  expect(owner.currentState("t1")?.state).toBe("failed");
  expect(deps.exited).toHaveBeenCalledWith("t1");
  expect(deps.recheck).toHaveBeenCalledWith("t1");
});

test("a failed classifier leaves the queue usable", async () => {
  const { owner, deps } = setup();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(deps.verdicts.classify).mockRejectedValueOnce(new Error("classification failed"));
  await owner.quiet("t1");
  expect(owner.currentState("t1")).toBeNull();
  await owner.quiet("t1");
  expect(owner.currentState("t1")?.state).toBe("needs_input");
  expect(error).toHaveBeenCalledWith("Unable to evaluate terminal:", expect.any(Error));
});

test("failed storage publishes an unstored verdict and retries unchanged classification", async () => {
  const { owner, deps } = setup();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(deps.verdicts.commit).mockRejectedValueOnce(new Error("disk full"));
  await owner.quiet("t1");
  expect(owner.currentState("t1")).toMatchObject({ verdictId: null, state: "needs_input" });
  await owner.quiet("t1");
  expect(owner.currentState("t1")?.verdictId).toBe("v2");
});

test.each(["input", "output", "shell", "reset", "removed", "closed"] as const)(
  "%s invalidates classification in flight",
  async (change) => {
    const { owner, deps, close } = setup();
    const started = deferred<undefined>();
    const result = deferred<VerdictRecord>();
    vi.mocked(deps.verdicts.classify).mockImplementationOnce(() => {
      started.resolve(undefined);
      return result.promise;
    });
    const work = owner.quiet("t1");
    await started.promise;
    if (change === "input") owner.input("t1");
    if (change === "output") owner.output("t1");
    if (change === "shell") owner.shellState("t1", { phase: "running" });
    if (change === "reset") {
      owner.reset("t1");
      owner.ensure("t1");
    }
    if (change === "removed") owner.removed("t1");
    if (change === "closed") close();
    result.resolve({
      id: "stale",
      terminalId: "t1",
      timestamp: "now",
      verdict: { state: "needs_input", signal: "old", reason: "old", confidence: 1 },
    });
    await work;
    expect(deps.verdicts.commit).not.toHaveBeenCalled();
    expect(owner.currentState("t1")?.verdictId).not.toBe("stale");
  },
);

test.each(["input", "output", "reset", "closed"] as const)(
  "%s during commit suppresses publication",
  async (change) => {
    const { owner, deps, close, states } = setup();
    const started = deferred<undefined>();
    const stored = deferred<undefined>();
    vi.mocked(deps.verdicts.commit).mockImplementationOnce(() => {
      started.resolve(undefined);
      return stored.promise;
    });
    const work = owner.quiet("t1");
    await started.promise;
    if (change === "input") owner.input("t1");
    if (change === "output") owner.output("t1");
    if (change === "reset") {
      owner.reset("t1");
      owner.ensure("t1");
    }
    if (change === "closed") close();
    stored.resolve(undefined);
    await work;
    expect(states.every((state) => state.verdictId === null)).toBe(true);
  },
);

test("relaunch during evaluation advances identity and protects the replacement verdict", async () => {
  const { owner, deps, hook } = setup(true);
  const oldLaunch = owner.view("t1").execution?.launch;
  const started = deferred<undefined>();
  const result = deferred<VerdictRecord>();
  vi.mocked(deps.verdicts.classify).mockImplementationOnce(() => {
    started.resolve(undefined);
    return result.promise;
  });
  const oldWork = owner.quiet("t1");
  await started.promise;
  owner.reset("t1");
  owner.launched("t1");
  await hook("working");
  expect(owner.view("t1").execution?.launch).toBeGreaterThan(oldLaunch ?? 0);
  result.resolve({
    id: "old",
    terminalId: "t1",
    timestamp: "now",
    verdict: { state: "failed", signal: "old", reason: "old", confidence: 1 },
  });
  await oldWork;
  expect(deps.verdicts.commit).not.toHaveBeenCalled();
  expect(owner.view("t1").execution?.phase).toBe("working");
  expect(owner.currentState("t1")).toBeNull();
});

test("lifecycle transitions invalidate queued quiet evaluations before tail reads", async () => {
  const { owner, deps, hook } = setup(true);
  const work = owner.quiet("t1");
  await hook("working");
  await work;
  expect(deps.tail).not.toHaveBeenCalled();
});

test("reply is recorded once for agents without proving resumed execution", async () => {
  const { owner, deps, hook } = setup(true);
  await hook("needs_input");
  owner.input("t1");
  owner.input("t1");
  expect(deps.verdicts.recordAction).toHaveBeenCalledTimes(1);
  expect(owner.view("t1").execution?.phase).toBe("blocked");
  expect(owner.currentState("t1")?.state).toBe("needs_input");
  await hook("working");
  expect(owner.view("t1").execution?.phase).toBe("working");
});

test.each(["y", "\u001b[<0;10;5M", "\u001b[M *%"])(
  "dismisses the current agent verdict after reply input %j without a second log action",
  async (input) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "foom-dismiss-"));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    const { owner, deps, hook } = setup(true);
    deps.verdicts = new VerdictLog(dir);
    await hook("needs_input");
    const id = owner.currentState("t1")?.verdictId ?? "missing";
    expect(isReply(input)).toBe(true);
    owner.input("t1");
    expect(owner.currentState("t1")).toMatchObject({ state: "needs_input", verdictId: id });
    await expect(owner.feedback("t1", id, "dismissed")).resolves.toBeUndefined();
    expect(owner.currentState("t1")).toMatchObject({ state: "quiet_ok", signal: "user:dismissed" });
    expect(owner.view("t1").execution?.phase).toBe("blocked");
    await owner.quiet("t1");
    expect(owner.currentState("t1")?.state).toBe("quiet_ok");
    const log = await readFile(path.join(dir, "verdicts.jsonl"), "utf8");
    expect(log.match(/"type":"action"/g)).toHaveLength(1);
    expect(log).toContain('"action":"replied"');
  },
);

test("dismisses a current verdict whose pending log entry was forgotten", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "foom-dismiss-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const { owner, deps, hook } = setup(true);
  const log = new VerdictLog(dir);
  deps.verdicts = log;
  await hook("needs_input");
  const id = owner.currentState("t1")?.verdictId ?? "missing";
  log.forget("t1");
  await owner.feedback("t1", id, "dismissed");
  expect(owner.currentState("t1")).toMatchObject({ state: "quiet_ok", signal: "user:dismissed" });
  expect(await readFile(path.join(dir, "verdicts.jsonl"), "utf8")).not.toContain('"type":"action"');
});

test("rejects forged, superseded and invalid feedback before touching storage", async () => {
  const { owner, deps, hook, tail } = setup(true);
  await hook("needs_input");
  const old = owner.currentState("t1")?.verdictId ?? "missing";
  await hook("working");
  tail(["Tests failed"]);
  await owner.quiet("t1");
  const current = owner.currentState("t1");
  expect(current?.verdictId).not.toBe(old);
  for (const id of [old, "forged", null])
    await expect(owner.feedback("t1", id, "dismissed")).rejects.toThrow("Invalid verdict feedback");
  await expect(
    Reflect.apply(owner.feedback.bind(owner), owner, ["t1", current?.verdictId, "opened"]),
  ).rejects.toThrow("Invalid verdict feedback");
  expect(owner.currentState("t1")).toEqual(current);
  expect(deps.verdicts.recordAction).not.toHaveBeenCalled();
});

test("shell reply clears attention even when reply logging fails", async () => {
  const { owner, deps } = setup();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  await owner.quiet("t1");
  vi.mocked(deps.verdicts.recordAction).mockRejectedValueOnce(new Error("disk"));
  owner.input("t1");
  await Promise.resolve(undefined);
  expect(owner.currentState("t1")).toMatchObject({ state: "working", signal: "user:reply" });
  expect(error).toHaveBeenCalledWith("Unable to record reply:", expect.any(Error));
});

test("dismissal suppresses matching agent attention until a new permission hook", async () => {
  const { owner, hook } = setup(true);
  await hook("needs_input");
  const id = owner.currentState("t1")?.verdictId ?? null;
  await owner.feedback("t1", id, "dismissed");
  expect(owner.currentState("t1")?.state).toBe("quiet_ok");
  await owner.quiet("t1");
  expect(owner.currentState("t1")?.state).toBe("quiet_ok");
  await hook("needs_input");
  expect(owner.currentState("t1")?.state).toBe("needs_input");
});

test("feedback failure restores reply deduplication and allows retry", async () => {
  const { owner, deps, hook } = setup(true);
  await hook("needs_input");
  const id = owner.currentState("t1")?.verdictId ?? "missing";
  vi.mocked(deps.verdicts.recordAction).mockRejectedValueOnce(new Error("disk"));
  await expect(owner.feedback("t1", id, "dismissed")).rejects.toThrow("disk");
  owner.input("t1");
  expect(deps.verdicts.recordAction).toHaveBeenLastCalledWith("t1", id, "replied");
});

test("dismissal waits for reply storage failure, preserves attention and permits retry", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "foom-dismiss-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const { owner, deps, hook } = setup(true);
  deps.verdicts = new VerdictLog(dir);
  vi.spyOn(console, "error").mockImplementation(() => {});
  await hook("needs_input");
  const before = owner.currentState("t1");
  const id = before?.verdictId ?? "missing";
  await rm(dir, { recursive: true });
  await writeFile(dir, "not a directory");
  owner.input("t1");
  await expect(owner.feedback("t1", id, "dismissed")).rejects.toThrow();
  expect(owner.currentState("t1")).toEqual(before);
  await rm(dir);
  await owner.feedback("t1", id, "dismissed");
  expect(owner.currentState("t1")?.state).toBe("quiet_ok");
  expect(await readFile(path.join(dir, "verdicts.jsonl"), "utf8")).toContain(
    '"feedback":"not_attention"',
  );
});

test.each(["reset", "removed"] as const)(
  "feedback finishing after %s cannot clear a replacement invocation",
  async (change) => {
    const { owner, deps, hook, states } = setup(true);
    await hook("needs_input");
    const stored = deferred<undefined>();
    vi.mocked(deps.verdicts.recordAction).mockReturnValueOnce(stored.promise);
    const work = owner.feedback("t1", "v1", "dismissed");
    owner[change]("t1");
    owner.launched("t1");
    const count = states.length;
    stored.resolve(undefined);
    await work;
    expect(owner.currentState("t1")).toBeNull();
    expect(states).toHaveLength(count);
  },
);

test("feedback finishing after a newer verdict cannot clear it", async () => {
  const { owner, deps, tail } = setup();
  await owner.quiet("t1");
  const stored = deferred<undefined>();
  vi.mocked(deps.verdicts.recordAction).mockReturnValueOnce(stored.promise);
  const work = owner.feedback("t1", "v1", "dismissed");
  tail(["Tests failed"]);
  owner.output("t1");
  await owner.quiet("t1");
  const newer = owner.currentState("t1");
  stored.resolve(undefined);
  await work;
  expect(owner.currentState("t1")).toEqual(newer);
  expect(newer?.verdictId).toBe("v2");
});

test("null feedback is restricted to the current unstored verdict; ignored keeps state", async () => {
  const { owner, deps } = setup();
  await expect(owner.feedback("missing", null, "dismissed")).rejects.toThrow("Unknown terminal");
  await expect(owner.feedback("t1", null, "dismissed")).rejects.toThrow("Invalid verdict feedback");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(deps.verdicts.commit).mockRejectedValue(new Error("disk"));
  await owner.quiet("t1");
  const before = owner.currentState("t1");
  await owner.feedback("t1", null, "ignored");
  expect(owner.currentState("t1")).toEqual(before);
  await owner.feedback("t1", null, "dismissed");
  await expect(owner.feedback("t1", null, "dismissed")).rejects.toThrow("Invalid verdict feedback");
});

test("process exit is final despite input, hooks and duplicate exits", async () => {
  const { owner, deps, hook } = setup(true);
  await hook("working");
  await owner.exited("t1", 0);
  expect(owner.currentState("t1")).toMatchObject({
    state: "failed",
    signal: "execution:interrupted",
  });
  owner.input("t1");
  await hook("needs_input");
  await owner.exited("t1", 9);
  expect(owner.view("t1").exitCode).toBe(0);
  expect(deps.exited).toHaveBeenCalledTimes(1);
});

test("shell markers own shell readiness, execution and command completion", async () => {
  const { owner, deps } = setup();
  owner.shellState("t1", { phase: "prompt", exitCode: 0 });
  expect(owner.currentState("t1")?.state).toBe("quiet_ok");
  owner.shellState("t1", { phase: "prompt", exitCode: 0 });
  expect(deps.onState).toHaveBeenCalledTimes(1);
  owner.shellState("t1", { phase: "running" });
  owner.shellState("t1", { phase: "prompt", exitCode: 2 });
  expect(owner.currentState("t1")?.state).toBe("failed");
  await owner.quiet("t1");
  owner.output("t1");
  expect(owner.currentState("t1")?.state).toBe("failed");
  expect(deps.tail).not.toHaveBeenCalled();
});

test("launch consumes an early exit and foreground changes refresh once", () => {
  const { owner, deps } = setup();
  owner.markExited("t1", -1);
  owner.launched("t1");
  expect(owner.view("t1").execution?.phase).toBe("exited");
  owner.foreground("t1", "ignored");
  expect(owner.view("t1").foregroundProgram).toBeUndefined();
  owner.ensure("t2");
  owner.foreground("t2", "vim");
  owner.foreground("t2", "vim");
  expect(owner.view("t2").foregroundProgram).toBe("vim");
  expect(deps.refresh).toHaveBeenCalledTimes(2);
  expect(owner.view("missing")).toMatchObject({ outputRevision: 0, inputRevision: 0 });
});

test("subscriptions are disposable and verdicts are forgotten on removal and shutdown", async () => {
  const { owner, deps, hook } = setup(true);
  const listener = vi.fn();
  const unsubscribe = owner.subscribeExecution(listener);
  await hook("working");
  unsubscribe();
  await hook("ready");
  expect(listener).toHaveBeenCalledTimes(1);
  owner.subscribeExecution(listener);
  owner.disposeSubscriptions();
  await hook("working");
  expect(listener).toHaveBeenCalledTimes(1);
  owner.removed("t1");
  expect(owner.has("t1")).toBe(false);
  owner.input("t1");
  owner.ensure("t2");
  owner.forgetVerdicts();
  expect(deps.verdicts.forget).toHaveBeenNthCalledWith(1, "t1");
  expect(deps.verdicts.forget).toHaveBeenNthCalledWith(2, "t2");
});

test("waiting and unread reminders project without changing verdict history", async () => {
  const { owner, hook, waiting, unread, deps } = setup(true);
  await hook("working");
  await hook("ready");
  waiting(2);
  expect(owner.currentState("t1")).toMatchObject({ waitingOn: 2 });
  unread(50);
  expect(owner.currentState("t1")).toMatchObject({
    state: "needs_input",
    signal: "orchestration:unread",
    timestamp: 50,
  });
  await hook("needs_input");
  expect(owner.currentState("t1")).toMatchObject({ attentionKind: "permission" });
  unread(undefined);
  expect(deps.verdicts.commit).toHaveBeenCalledTimes(1);
});

test("working lifecycle evidence supersedes an in-flight screen classification", async () => {
  const { owner, deps, hook } = setup(true);
  const started = deferred<undefined>();
  const result = deferred<VerdictRecord>();
  vi.mocked(deps.verdicts.classify).mockImplementationOnce(() => {
    started.resolve(undefined);
    return result.promise;
  });
  const work = owner.quiet("t1");
  await started.promise;
  await hook("working");
  result.resolve({
    id: "old",
    terminalId: "t1",
    timestamp: "now",
    verdict: {
      state: "needs_input",
      signal: "pattern:question",
      reason: "old screen",
      confidence: 1,
    },
  });
  await work;
  expect(deps.verdicts.commit).not.toHaveBeenCalled();
  expect(owner.view("t1").execution?.phase).toBe("working");
});

test("dismissal during evaluation prevents attention from reappearing", async () => {
  const { owner, deps } = setup();
  await owner.quiet("t1");
  const started = deferred<undefined>();
  const result = deferred<VerdictRecord>();
  vi.mocked(deps.verdicts.classify).mockImplementationOnce(() => {
    started.resolve(undefined);
    return result.promise;
  });
  const work = owner.quiet("t1");
  await started.promise;
  await owner.feedback("t1", "v1", "dismissed");
  result.resolve({
    id: "old",
    terminalId: "t1",
    timestamp: "now",
    verdict: {
      state: "needs_input",
      signal: "pattern:question",
      reason: "old screen",
      confidence: 1,
    },
  });
  await work;
  expect(owner.currentState("t1")).toMatchObject({ signal: "user:dismissed", state: "quiet_ok" });
  expect(deps.verdicts.commit).toHaveBeenCalledTimes(1);
});

test("permission requires positive progress and a screen clear of blockers to resume", async () => {
  const { owner, hook, tail } = setup(true);
  await hook("needs_input");
  await owner.evidence("t1", { title: "◐ Working", progress: null });
  expect(owner.view("t1").execution?.phase).toBe("blocked");
  owner.input("t1");
  tail(["Reading files"]);
  await owner.evidence("t1", { title: "◓ Working", progress: null });
  expect(owner.view("t1").execution?.phase).toBe("working");
});

test("early metadata is reconsidered once launch facts arrive", async () => {
  const { owner, deps, tail } = setup();
  vi.mocked(deps.terminal).mockReturnValue(undefined);
  tail(["Reading files"]);
  await owner.evidence("t1", { title: "◐ Working", progress: null });
  expect(deps.verdicts.classify).not.toHaveBeenCalled();
  vi.mocked(deps.terminal).mockReturnValue({
    kind: "agent",
    agent: "claude",
    attention: "evaluator",
  });
  owner.launched("t1");
  await owner.quiet("t1");
  expect(owner.view("t1").execution?.phase).toBe("working");
});

test.each(["reset", "removed"] as const)(
  "queued exit cannot mark an invocation created after %s as exited",
  async (change) => {
    const { owner, deps } = setup(true);
    const blocked = deferred<string[]>();
    vi.mocked(deps.tail).mockReturnValueOnce(blocked.promise);
    const quiet = owner.quiet("t1");
    await vi.waitFor(() => {
      expect(deps.tail).toHaveBeenCalled();
    });
    const exit = owner.exited("t1", 9);
    expect(owner.view("t1").execution?.phase).toBe("exited");
    owner[change]("t1");
    owner.ensure("t1");
    owner.launched("t1");
    blocked.resolve([]);
    await quiet;
    await exit;
    expect(owner.view("t1").exitCode).toBeUndefined();
    expect(owner.view("t1").execution?.phase).toBe("starting");
    expect(deps.exited).not.toHaveBeenCalled();
    expect(deps.verdicts.commit).not.toHaveBeenCalled();
  },
);

const piWorking = ["── ⠋ Working ─────", "────────────────", "temp", "0.5%/272k (auto)"];
const piIdle = ["────────────────", "temp", "0.5%/272k (auto)"];

test("active screen opt-in detects a static-title spinner without quiet events and throttles reads", async () => {
  const { owner, deps, tail } = setup("pi");
  let now = 0;
  deps.now = () => now;
  tail(piWorking);
  owner.output("t1");
  await deps.enqueue("t1", async () => {});
  expect(owner.view("t1").execution?.phase).toBe("working");
  expect(deps.tail).toHaveBeenCalledTimes(1);
  for (now = 100; now < 1000; now += 100) owner.output("t1");
  await deps.enqueue("t1", async () => {});
  expect(deps.tail).toHaveBeenCalledTimes(1);
  tail(piIdle);
  owner.output("t1");
  await deps.enqueue("t1", async () => {});
  expect(deps.tail).toHaveBeenCalledTimes(2);
  expect(owner.view("t1").execution?.phase).toBe("idle");
  expect(owner.currentState("t1")?.state).toBe("done");
});

test("active screen sampling allows only one in-flight read and retries stale spinner frames", async () => {
  const { owner, deps, tail } = setup("pi");
  let now = 0;
  deps.now = () => now;
  const started = deferred<undefined>();
  const screen = deferred<string[]>();
  vi.mocked(deps.tail).mockImplementationOnce(() => {
    started.resolve(undefined);
    return screen.promise;
  });
  owner.output("t1");
  await started.promise;
  now = 2000;
  owner.output("t1");
  expect(deps.tail).toHaveBeenCalledTimes(1);
  screen.resolve(piWorking);
  await deps.enqueue("t1", async () => {});
  expect(owner.view("t1").execution?.phase).toBe("starting");
  now = 3000;
  tail(piWorking);
  owner.output("t1");
  await deps.enqueue("t1", async () => {});
  expect(owner.view("t1").execution?.phase).toBe("working");
});

test("active sampling requires a known rule, respects permission hooks, and excludes exited invocations", async () => {
  const { owner, deps, tail, hook } = setup("pi");
  let now = 0;
  deps.now = () => now;
  tail(["unrecognized active output"]);
  owner.output("t1");
  await deps.enqueue("t1", async () => {});
  expect(deps.verdicts.classify).not.toHaveBeenCalled();
  await hook("needs_input");
  tail(piWorking);
  now = 1000;
  owner.output("t1");
  await deps.enqueue("t1", async () => {});
  expect(owner.currentState("t1")?.state).toBe("needs_input");
  await hook("failed");
  now = 2000;
  owner.output("t1");
  await deps.enqueue("t1", async () => {});
  expect(owner.currentState("t1")?.state).toBe("failed");
  expect(owner.view("t1").execution?.phase).toBe("idle");
  owner.markExited("t1", 0);
  vi.mocked(deps.tail).mockClear();
  now = 3000;
  owner.output("t1");
  await deps.enqueue("t1", async () => {});
  expect(deps.tail).not.toHaveBeenCalled();
});

test.each(["reset", "removed", "input", "closed", "exit"] as const)(
  "invalidates an active screen sample on %s",
  async (change) => {
    const fixture = setup("pi");
    const { owner, deps } = fixture;
    const started = deferred<undefined>();
    const screen = deferred<string[]>();
    vi.mocked(deps.tail).mockImplementationOnce(() => {
      started.resolve(undefined);
      return screen.promise;
    });
    owner.output("t1");
    await started.promise;
    if (change === "reset") {
      owner.reset("t1");
      owner.ensure("t1");
      owner.launched("t1");
    }
    if (change === "removed") owner.removed("t1");
    if (change === "input") owner.input("t1");
    if (change === "closed") fixture.close();
    if (change === "exit") owner.markExited("t1", 0);
    screen.resolve(piWorking);
    await deps.enqueue("t1", async () => {});
    expect(deps.verdicts.commit).not.toHaveBeenCalled();
  },
);

test("Pi quiet readiness is neutral, completion needs a working turn, and model failures request attention", async () => {
  const { owner, deps, tail } = setup("pi");
  tail(piIdle);
  await owner.quiet("t1");
  expect(owner.currentState("t1")?.state).toBe("quiet_ok");
  tail(piWorking);
  owner.output("t1");
  await deps.enqueue("t1", async () => {});
  expect(owner.view("t1").execution?.phase).toBe("working");
  tail(piModelError.tail);
  await owner.quiet("t1");
  expect(owner.currentState("t1")).toMatchObject({
    state: "needs_input",
    attentionKind: "provider",
  });
  tail(piWorking);
  await owner.quiet("t1");
  expect(owner.view("t1").execution?.phase).toBe("working");
  tail(piIdle);
  await owner.quiet("t1");
  expect(owner.currentState("t1")?.state).toBe("done");
});

test.each([false, true])(
  "Pi idle UI close clears its blocker and preserves active turn=%s across quiet",
  async (activeTurn) => {
    const { owner, tail } = setup("pi");
    tail(["Nothing pending"]);
    const model = agentProvider("pi").model;
    const channel = model.hooks?.channels[0];
    if (!channel) throw new Error("Missing Pi lifecycle channel");
    owner.attachHooks(
      "t1",
      new V2ExecutionHooks(
        model,
        new Map([[channel.id, channel]]),
        new V2Health("unused-pi-health-fixture", "pi", "fixture"),
      ),
    );
    const state = {};
    const emit = async (event: string, extra: Record<string, unknown> = {}) => {
      const signal = reduceV2(
        channel,
        state,
        "t1",
        "pi",
        { event, conversationId: "pi-session", ...extra },
        undefined,
        undefined,
      );
      if (!signal) throw new Error("Missing Pi hook signal");
      await owner.hook("t1", signal);
    };
    await emit("session_start");
    if (activeTurn) await emit("agent_start");
    const before = owner.view("t1").execution;
    await emit("ui_prompt_start");
    // Repeated notifications must not replace the phase to restore.
    await emit("ui_prompt_start");
    expect(owner.view("t1").execution?.phase).toBe("blocked");
    expect(owner.currentState("t1")).toMatchObject({
      state: "needs_input",
      signal: "plugin:pi:ui_prompt_start",
    });
    // Ordinary classification must still preserve explicit permission evidence.
    await owner.hook("t1", {
      terminalId: "t1",
      signal: "plugin:pi:classification",
      action: "classify",
      endsTurn: false,
    });
    await owner.quiet("t1");
    expect(owner.currentState("t1")?.state).toBe("needs_input");
    await emit("ui_prompt_end", { fullyIdle: true });
    expect(owner.view("t1").execution).toMatchObject({
      phase: activeTurn ? "working" : "idle",
      turn: before?.turn,
    });
    for (let quiet = 0; quiet < 2; quiet++) {
      await owner.quiet("t1");
      expect(owner.currentState("t1")).toMatchObject({
        state: activeTurn ? "working" : "quiet_ok",
        execution: { phase: activeTurn ? "working" : "idle", turn: before?.turn },
      });
      expect(owner.currentState("t1")?.signal).not.toBe("plugin:pi:ui_prompt_start");
    }
    if (activeTurn) {
      await emit("agent_settled", { outcome: "completed" });
      expect(owner.currentState("t1")).toMatchObject({ state: "done" });
    }
  },
);
