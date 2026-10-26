import { expect, test, vi } from "vitest";
import { evaluateRules } from "../../../../src/main/evaluator/evaluator";
import { Workspace } from "../../../../src/main/workspace/workspace";
import type { VerdictRecord } from "../../../../src/shared/evaluator";
import type { HookSignal } from "../../../../src/shared/hooks";
import {
  agents,
  bound,
  classify,
  commit,
  deps,
  evaluated,
  forget,
  held,
  launched,
  prepare,
  receiver,
  recordAction,
  repo,
  states,
  tails,
  terminalTail,
  tree,
} from "./workspace-fixture";

test("quiet terminals are evaluated from their tail and reported", async () => {
  const workspace = new Workspace(deps);
  tails.set("shell", ["$ ls", "README.md"]);
  await workspace.quiet("shell");
  expect(evaluated[0]).toEqual({ terminalId: "shell", tail: ["$ ls", "README.md"] });
  expect(states).toEqual([
    {
      id: "shell",
      verdictId: "v1",
      inputRevision: 0,
      outputRevision: 0,
      state: "working",
      reason: "No completion or input request detected",
      signal: "rules:ambiguous",
      confidence: 0.25,
      timestamp: 1000,
    },
  ]);
});

test("a permission hook stays in force across later quiet evaluations until positive execution evidence", async () => {
  const workspace = await launched();
  const hooks = await prepare?.("claude");
  if (!hooks?.bind) throw new Error("Missing hooks");
  hooks.bind("t1");
  const key = receiver.register.mock.calls[0]?.[0] ?? "";
  tails.set("t1", ["╭ Allow Bash(npm test)? ╮"]);
  const signal: HookSignal = {
    terminalId: key,
    action: "needs_input",
    signal: "plugin:claude:PermissionRequest",
  };
  await workspace.hook(signal);
  expect(evaluated[0]?.hook).toEqual({ ...signal, terminalId: "t1" });
  expect(states.at(-1)).toMatchObject({
    state: "needs_input",
    signal: "plugin:claude:PermissionRequest",
  });
  // The TUI's dialog doesn't match any text rule; the hook keeps the verdict.
  await workspace.quiet("t1");
  expect(states.at(-1)).toMatchObject({ state: "needs_input", verdictId: "v1" });

  workspace.input("t1");
  expect(states.at(-1)?.state).toBe("needs_input");
  await workspace.hook({ terminalId: key, action: "working", signal: "plugin:claude:PreToolUse" });
  expect(recordAction).toHaveBeenCalledWith("t1", "v1", "replied");
  await workspace.quiet("t1");
  expect(evaluated.at(-1)?.hook).toBeUndefined();
  // Typing when nothing is waiting records nothing.
  workspace.input("t1");
  workspace.input("unknown");
  expect(recordAction).toHaveBeenCalledOnce();
});

test("completion hooks classify without forcing attention; unknown keys are ignored", async () => {
  const workspace = await launched();
  const hooks = await prepare?.("claude");
  hooks?.bind?.("t1");
  const key = receiver.register.mock.calls[0]?.[0] ?? "";
  tails.set("t1", ["All done."]);
  await workspace.hook({ terminalId: key, action: "classify", signal: "plugin:claude:Stop" });
  expect(evaluated[0]?.hook).toBeUndefined();
  expect(states.at(-1)?.state).toBe("quiet_ok");
  await workspace.hook({
    terminalId: "nobody",
    action: "needs_input",
    signal: "plugin:claude:PermissionRequest",
  });
  expect(evaluated).toHaveLength(1);
  // A disposed binding no longer maps its key.
  hooks?.dispose();
  await workspace.hook({ terminalId: key, action: "classify", signal: "plugin:claude:Stop" });
  expect(evaluated).toHaveLength(1);
});

test("exit is final: releases the launch and ignores later quiet and hook events", async () => {
  const workspace = await launched();
  const hooks = await prepare?.("claude");
  hooks?.bind?.("t1");
  const key = receiver.register.mock.calls[0]?.[0] ?? "";
  await workspace.exited("t1", 1);
  expect(agents.release).toHaveBeenCalledWith("t1");
  expect(states.at(-1)).toMatchObject({ state: "failed", signal: "process:exit" });
  await workspace.quiet("t1");
  await workspace.hook({
    terminalId: key,
    action: "needs_input",
    signal: "plugin:claude:PermissionRequest",
  });
  await workspace.exited("t1", 0);
  expect(evaluated).toHaveLength(1);
  workspace.removed("t1");
  expect(agents.release).toHaveBeenCalledExactlyOnceWith("t1");
});

test("a failed host still produces an exit verdict without a tail", async () => {
  const workspace = new Workspace(deps);
  await workspace.exited("lost", -1);
  expect(evaluated[0]).toEqual({ terminalId: "lost", tail: [], exitCode: -1 });
  expect(states[0]?.state).toBe("failed");
});

test("evaluations for one terminal run in order and failures don't block the queue", async () => {
  const workspace = new Workspace(deps);
  let release: () => void = () => {};
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  terminalTail
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve(["slow"]);
          };
        }),
    )
    .mockResolvedValueOnce(["fast"]);
  const slow = workspace.quiet("t9");
  const fast = workspace.exited("t9", 0);
  await vi.waitFor(() => {
    expect(terminalTail).toHaveBeenCalledOnce();
  });
  release();
  await Promise.all([slow, fast]);
  expect(evaluated.map((input) => input.tail)).toEqual([["slow"], ["fast"]]);
  expect(states.at(-1)?.state).toBe("done");

  classify.mockRejectedValueOnce(new Error("classifier"));
  await workspace.quiet("t8");
  expect(error).toHaveBeenCalledWith("Unable to evaluate terminal:", expect.any(Error));
  tails.set("t8", ["Continue? (y/n)"]);
  await workspace.quiet("t8");
  expect(states.at(-1)).toMatchObject({ id: "t8", state: "needs_input" });
});

test("removal forgets the terminal and releases its launch", async () => {
  const workspace = await launched();
  workspace.removed("t1");
  expect(agents.release).toHaveBeenCalledWith("t1");
  expect(workspace.snapshot().terminals).toEqual([]);
  await expect(workspace.feedback("t1", "v1", "dismissed")).rejects.toThrow("Unknown terminal");
});

test("dismissal records feedback and clears attention; stale or ignored feedback doesn't", async () => {
  const workspace = new Workspace(deps);
  await workspace.quiet("t1");
  await workspace.feedback("t1", "v1", "ignored");
  expect(states.at(-1)?.state).toBe("needs_input");
  tails.set("t1", ["Password:"]);
  await workspace.quiet("t1");
  await expect(workspace.feedback("t1", "v1", "dismissed")).rejects.toThrow(
    "Invalid verdict feedback",
  );
  expect(states.at(-1)?.verdictId).toBe("v2");
  await workspace.feedback("t1", "v2", "dismissed");
  expect(recordAction).toHaveBeenLastCalledWith("t1", "v2", "dismissed", true);
  expect(states.at(-1)).toMatchObject({ state: "quiet_ok", signal: "user:dismissed" });
  await workspace.quiet("t1");
  await workspace.feedback("t1", "v3", "replied");
  expect(states.at(-1)).toMatchObject({ state: "working", signal: "user:reply" });
  await expect(workspace.feedback("t1", "v3", "dismissed")).rejects.toThrow("Invalid verdict");
});

test("a failed reply record is logged, not thrown into the input path", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const workspace = new Workspace(deps);
  await workspace.quiet("t1");
  recordAction.mockRejectedValueOnce(new Error("disk full"));
  workspace.input("t1");
  await vi.waitFor(() => {
    expect(error).toHaveBeenCalledWith("Unable to record reply:", expect.any(Error));
  });
});

test("an evaluation that was in flight during a reply can't restore attention", async () => {
  const workspace = new Workspace(deps);
  await workspace.quiet("t1");
  expect(states.at(-1)).toMatchObject({ state: "needs_input", verdictId: "v1" });
  // A different signal classifies, then waits on its log write.
  tails.set("t1", ["Password:"]);
  const write = held<undefined>();
  commit.mockReturnValueOnce(write.promise);
  const pending = workspace.quiet("t1");
  await vi.waitFor(() => {
    expect(commit).toHaveBeenCalledTimes(2);
  });
  workspace.input("t1");
  write.resolve(undefined);
  await pending;
  expect(states.map((state) => state.signal)).toEqual(["pattern:confirmation", "user:reply"]);
  expect(recordAction).toHaveBeenCalledExactlyOnceWith("t1", "v1", "replied");

  // A dismissal also invalidates an evaluation still reading the screen.
  await workspace.quiet("t1");
  const screen = held<string[]>();
  terminalTail.mockReturnValueOnce(screen.promise);
  const reading = workspace.quiet("t1");
  await vi.waitFor(() => {
    expect(terminalTail).toHaveBeenCalledTimes(3);
  });
  await workspace.feedback("t1", "v3", "dismissed");
  screen.resolve(["Continue? (y/n)"]);
  await reading;
  expect(states.at(-1)).toMatchObject({ signal: "user:dismissed" });
  expect(commit).toHaveBeenCalledTimes(3);
});

test("a reply before the first permission verdict does not answer the hook", async () => {
  const workspace = await launched();
  const key = await bound();
  tails.set("t1", ["╭ Allow Bash(npm test)? ╮"]);
  const screen = held<string[]>();
  terminalTail.mockReturnValueOnce(screen.promise);
  const signal: HookSignal = {
    terminalId: key,
    action: "needs_input",
    signal: "plugin:claude:PermissionRequest",
  };
  const first = workspace.hook(signal);
  await vi.waitFor(() => {
    expect(terminalTail).toHaveBeenCalledOnce();
  });
  // A second hook queued behind the first also predates the reply.
  const second = workspace.hook(signal);
  workspace.input("t1");
  screen.resolve(["╭ Allow Bash(npm test)? ╮"]);
  await Promise.all([first, second]);
  expect(states.at(-1)?.state).toBe("needs_input");
  expect(recordAction).not.toHaveBeenCalled();
  await workspace.quiet("t1");
  expect(evaluated.at(-1)?.hook).toMatchObject({ action: "needs_input" });
  expect(states.at(-1)?.state).toBe("needs_input");
});

test("a verdict that can't be stored is still reported, with no feedback target", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const workspace = new Workspace(deps);
  commit.mockRejectedValue(new Error("disk full"));
  await workspace.quiet("t1");
  expect(error).toHaveBeenCalledWith("Unable to record verdict:", expect.any(Error));
  expect(states.at(-1)).toMatchObject({ state: "needs_input", verdictId: null });
  // A reply still clears it, with nothing to record.
  workspace.input("t1");
  expect(states.at(-1)).toMatchObject({ signal: "user:reply" });
  expect(recordAction).not.toHaveBeenCalled();
  // Null feedback applies only to the current, unstored verdict.
  await expect(workspace.feedback("t1", null, "dismissed")).rejects.toThrow(
    "Invalid verdict feedback",
  );
  await workspace.quiet("t1");
  await workspace.feedback("t1", null, "ignored");
  expect(states.at(-1)?.state).toBe("needs_input");
  await workspace.feedback("t1", null, "dismissed");
  expect(states.at(-1)).toMatchObject({ state: "quiet_ok", signal: "user:dismissed" });
  expect(recordAction).not.toHaveBeenCalled();
  await expect(workspace.feedback("t9", null, "dismissed")).rejects.toThrow("Unknown terminal");
  await expect(new Workspace(deps).feedback("t1", null, "dismissed")).rejects.toThrow(
    "Unknown terminal",
  );
});

test("an exit is reported even when storage fails, and stays final after recovery", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const workspace = new Workspace(deps);
  commit.mockRejectedValueOnce(new Error("disk full"));
  await workspace.exited("t2", 1);
  expect(states).toEqual([expect.objectContaining({ id: "t2", state: "failed", verdictId: null })]);
  await workspace.exited("t2", 1);
  await workspace.quiet("t2");
  expect(states).toHaveLength(1);
  // A reply after exit can't discard the exit verdict.
  const next = new Workspace(deps);
  const screen = held<string[]>();
  terminalTail.mockReturnValueOnce(screen.promise);
  const exiting = next.exited("t3", 0);
  await vi.waitFor(() => {
    expect(terminalTail).toHaveBeenCalledTimes(2);
  });
  next.input("t3");
  screen.resolve([]);
  await exiting;
  expect(states.at(-1)).toMatchObject({ id: "t3", state: "done" });
});

test("shell lifecycle reports ready, working, done and failed, preserving completion while editing", async () => {
  const workspace = new Workspace(deps);
  workspace.shellState("t1", { phase: "prompt", exitCode: 0 });
  expect(states.at(-1)).toMatchObject({ state: "quiet_ok", reason: "Shell is ready" });
  workspace.shellState("t1", { phase: "running" });
  expect(states.at(-1)?.state).toBe("working");
  workspace.shellState("t1", { phase: "prompt", exitCode: 0 });
  expect(states.at(-1)?.state).toBe("done");
  workspace.output("t1");
  workspace.input("t1");
  workspace.shellState("t1", { phase: "prompt", exitCode: 0 });
  await workspace.quiet("t1");
  expect(states.at(-1)?.state).toBe("done");
  expect(classify).not.toHaveBeenCalled();
  workspace.shellState("t1", { phase: "running" });
  workspace.shellState("t1", { phase: "prompt", exitCode: 7 });
  expect(states.at(-1)).toMatchObject({ state: "failed", reason: "Command exited with status 7" });
  await workspace.exited("t1", 0);
  workspace.foreground("t1", "vim");
  workspace.shellState("t1", { phase: "running" });
  expect(states.at(-1)).toMatchObject({ state: "done", signal: "process:exit" });
});

test.each(["finish", "output", "prompt", "reject"])(
  "pending evaluation preserves state and survives %s",
  async (action) => {
    vi.useFakeTimers();
    const workspace = new Workspace(deps);
    let resolve!: (record: VerdictRecord) => void;
    let reject!: (error: Error) => void;
    classify.mockImplementationOnce(
      () =>
        new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        }),
    );
    const pending = workspace.quiet("t1");
    await vi.advanceTimersByTimeAsync(151);
    expect(states.map((state) => state.state)).not.toContain("checking");
    if (action === "output") workspace.output("t1");
    if (action === "prompt") workspace.shellState("t1", { phase: "prompt", exitCode: 0 });
    if (action === "reject") reject(new Error("unavailable"));
    else
      resolve({
        id: "slow",
        terminalId: "t1",
        timestamp: "now",
        verdict: evaluateRules({ terminalId: "t1", tail: ["Password:"] }),
      });
    await pending;
    expect(states.at(-1)?.state).toBe(
      action === "finish"
        ? "needs_input"
        : action === "prompt"
          ? "quiet_ok"
          : action === "output"
            ? "working"
            : undefined,
    );
    vi.useRealTimers();
  },
);

test("shell markers do not override a permission hook", async () => {
  const workspace = await launched();
  const key = await bound();
  await workspace.hook({
    terminalId: key,
    action: "needs_input",
    signal: "plugin:claude:PermissionRequest",
  });
  workspace.shellState("t1", { phase: "running" });
  workspace.shellState("t1", { phase: "prompt", exitCode: 0 });
  expect(states.at(-1)?.state).toBe("needs_input");
});

test.each(["output", "input", "removed"] as const)(
  "no verdict after %s invalidates an evaluation",
  async (action) => {
    vi.useFakeTimers();
    const workspace = new Workspace(deps);
    const response = Promise.withResolvers<VerdictRecord>();
    classify.mockReturnValueOnce(response.promise);
    const pending = workspace.quiet("t1");
    await vi.advanceTimersByTimeAsync(1);
    workspace[action]("t1");
    const count = states.length;
    await vi.advanceTimersByTimeAsync(200);
    response.resolve({
      id: "stale",
      terminalId: "t1",
      timestamp: "now",
      verdict: evaluateRules({ terminalId: "t1", tail: ["Password:"] }),
    });
    await pending;
    expect(states).toHaveLength(count);
    expect(commit).not.toHaveBeenCalled();
    vi.useRealTimers();
  },
);

test("agent screens work without OSC and title evidence remains local to the launched agent", async () => {
  const workspace = await launched();
  tails.set("t1", ["───", "Enter to confirm · Esc to cancel"]);
  await workspace.quiet("t1");
  expect(states.at(-1)?.signal).toBe("rules:claude:live_blocked_form");
  await workspace.evidence("t1", { title: "✳ Claude Code", progress: { state: 0, value: null } });
  expect(evaluated.at(-1)?.evidence?.title).toBe("✳ Claude Code");
  await workspace.evidence("shell", { title: "Action Required", progress: null });
  expect(evaluated.at(-1)?.terminalId).toBe("t1");
  const count = evaluated.length;
  await workspace.evidence("t1", { title: "✳ Claude Code", progress: { state: 1, value: 25 } });
  await workspace.evidence("t1", { title: "unrecognized", progress: { state: 1, value: 50 } });
  expect(evaluated).toHaveLength(count);
  await workspace.quiet("t1");
  expect(evaluated.at(-1)?.evidence?.progress).toEqual({ state: 1, value: 50 });
  await workspace.exited("t1", 0);
  await workspace.evidence("t1", { title: "busy", progress: null });
  expect(states.at(-1)?.signal).toBe("process:exit");
  await workspace.dispose();
});

test("working, blocked and idle title transitions each evaluate", async () => {
  const workspace = new Workspace(deps);
  await workspace.launch({
    agent: "codex",
    repository: repo.path,
    worktree: tree.path,
    cols: 80,
    rows: 24,
  });
  tails.set("t1", []);
  for (const title of ["⠋ codex", "[ ! ] Action Required", "codex", "⠙ codex"])
    await workspace.evidence("t1", { title, progress: null });
  expect(commit).toHaveBeenCalledTimes(4);
  expect(states.map(({ signal }) => signal)).toEqual([
    "rules:codex:osc_title_working",
    "rules:codex:osc_title_blocked",
    "rules:codex:osc_title_idle",
    "rules:codex:osc_title_working",
  ]);
  workspace.removed("t1");
  expect(forget).toHaveBeenCalledWith("t1");
  await workspace.dispose();
});

test("slow repeated classification preserves the verdict ID while pending", async () => {
  vi.useFakeTimers();
  try {
    const workspace = new Workspace(deps);
    await workspace.quiet("t1");
    const original = states.at(-1);
    const response = Promise.withResolvers<VerdictRecord>();
    classify.mockReturnValueOnce(response.promise);
    const pending = workspace.quiet("t1");
    await vi.advanceTimersByTimeAsync(151);
    expect(states.map((state) => state.state)).not.toContain("checking");
    response.resolve({
      id: "duplicate",
      terminalId: "t1",
      timestamp: "later",
      verdict: evaluateRules({ terminalId: "t1", tail: ["Continue? (y/n)"] }),
    });
    await pending;
    expect(states.at(-1)).toBe(original);
    expect(commit).toHaveBeenCalledTimes(1);
    await workspace.dispose();
  } finally {
    vi.useRealTimers();
  }
});

test.each(["claude", "agy"] as const)(
  "%s: captures an ID, copies it and resumes in place, then starts a fresh conversation",
  async (agent) => {
    const copy = vi.fn();
    deps.copyText = copy;
    const workspace = await launched(agent);
    const key = await bound(agent);
    await workspace.hook({
      terminalId: key,
      action: "classify",
      signal: agent === "claude" ? "claude:Stop" : "agy:Stop",
      conversationId: "conversation-123",
    });
    expect(workspace.snapshot().terminals[0]?.conversationId).toBe("conversation-123");
    await expect(
      workspace.sidebarCommand({ kind: "resume", id: "t1" }, () => Promise.resolve(true)),
    ).rejects.toThrow("still running");
    await workspace.exited("t1", 0);
    await workspace.sidebarCommand({ kind: "copy-session-id", id: "t1" }, () =>
      Promise.resolve(true),
    );
    expect(copy).toHaveBeenCalledWith("conversation-123");
    agents.launch.mockRejectedValueOnce(new Error("launch failed"));
    await expect(
      workspace.sidebarCommand({ kind: "resume", id: "t1" }, () => Promise.resolve(true)),
    ).rejects.toThrow("launch failed");
    expect(workspace.snapshot().terminals[0]).toMatchObject({
      id: "t1",
      exited: true,
      conversationId: "conversation-123",
    });
    await workspace.sidebarCommand({ kind: "resume", id: "t1" }, () => Promise.resolve(true));
    expect(agents.launch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        terminalId: "t1",
        conversationId: "conversation-123",
        worktree: tree.path,
        sharedCheckout: true,
      }),
    );
    expect(workspace.snapshot().terminals).toHaveLength(1);
    expect(workspace.snapshot().terminals[0]).toMatchObject({
      id: "t1",
      exited: false,
      conversationId: "conversation-123",
    });
    await workspace.exited("t1", 1);
    await workspace.sidebarCommand({ kind: "new-conversation", id: "t1" }, () =>
      Promise.resolve(true),
    );
    expect(workspace.snapshot().terminals[0]?.conversationId).toBeUndefined();
    await workspace.dispose();
  },
);

test("host exit revokes authority and releases resources while inventory waits for its queue", async () => {
  const workspace = await launched();
  const slot = workspace.orchestration.reserve(repo.path);
  if ("existing" in slot) throw new Error("Unexpected orchestrator");
  slot.bind("t1");
  slot.release();
  const tail = Promise.withResolvers<string[]>();
  terminalTail.mockReturnValueOnce(tail.promise);
  const quiet = workspace.quiet("t1");
  await vi.waitFor(() => {
    expect(terminalTail).toHaveBeenCalled();
  });
  const exit = workspace.exited("t1", 0);
  const duplicate = workspace.exited("t1", 9);
  expect(workspace.orchestration.active(repo.path)).toBeUndefined();
  expect(agents.release).toHaveBeenCalledExactlyOnceWith("t1");
  expect(workspace.snapshot().terminals[0]).toMatchObject({
    exited: false,
    execution: { phase: "exited" },
  });
  expect(workspace.snapshot().terminals[0]?.exitCode).toBeUndefined();
  tail.resolve([]);
  await quiet;
  await Promise.all([exit, duplicate]);
  expect(workspace.snapshot().terminals[0]).toMatchObject({ exited: true, exitCode: 0 });
  workspace.removed("t1");
  expect(agents.release).toHaveBeenCalledTimes(1);
  await workspace.dispose();
});
