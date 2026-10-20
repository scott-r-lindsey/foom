import { expect, test, vi } from "vitest";
import { Workspace } from "../../../../src/main/workspace/workspace";
import type { VerdictRecord } from "../../../../src/shared/evaluator";
import type { ExecutionTransition } from "../../../../src/shared/execution";
import type { HookSignal } from "../../../../src/shared/hooks";
import {
  bound,
  classify,
  commit,
  deps,
  held,
  launched,
  recordAction,
  repo,
  states,
  tails,
  terminalTail,
  tree,
} from "./workspace-fixture";

test("resumed output discards deferred inference before publication or logging", async () => {
  const workspace = await launched();
  const response = Promise.withResolvers<VerdictRecord>();
  classify.mockReturnValueOnce(response.promise);
  const pending = workspace.quiet("t1");
  await vi.waitFor(() => {
    expect(classify).toHaveBeenCalled();
  });
  workspace.output("t1");
  response.resolve({
    id: "obsolete",
    terminalId: "t1",
    timestamp: "now",
    verdict: {
      state: "done",
      reason: "Model detected successful completion",
      signal: "model:classification",
      confidence: 1,
    },
  });
  await pending;
  expect(states).toEqual([]);
  expect(commit).not.toHaveBeenCalled();
  await workspace.quiet("t1");
  expect(states.at(-1)?.state).toBe("needs_input");
  workspace.output("t1");
  expect(states.at(-1)).toMatchObject({
    state: "needs_input",
    signal: "pattern:confirmation",
  });
  const count = states.length;
  workspace.output("t1");
  expect(states).toHaveLength(count);
  expect(recordAction).not.toHaveBeenCalled();
  await workspace.exited("t1", 0);
  workspace.output("t1");
  expect(states.at(-1)?.state).toBe("done");
});

test("output preserves a permission hook even while its evaluation is pending", async () => {
  const workspace = await launched();
  const key = await bound();
  const reading = Promise.withResolvers<string[]>();
  terminalTail.mockReturnValueOnce(reading.promise);
  const pending = workspace.hook({
    terminalId: key,
    action: "needs_input",
    signal: "plugin:claude:PermissionRequest",
  });
  await vi.waitFor(() => {
    expect(terminalTail).toHaveBeenCalled();
  });
  workspace.output("t1");
  reading.resolve(["redrawn dialog"]);
  await pending;
  workspace.output("t1");
  expect(states.at(-1)?.state).toBe("needs_input");
});

test("execution is immediate, independent across agents, and conclusions wait for classification", async () => {
  const workspace = await launched();
  const key = await bound();
  const events: ExecutionTransition[] = [];
  const off = workspace.subscribeExecution((event) => events.push(event));
  tails.set("t1", ["All done."]);
  await workspace.evidence("t1", { title: "✳ Ready", progress: null });
  expect(workspace.snapshot().terminals[0]?.state?.state).toBe("quiet_ok");
  expect(events.at(-1)).toMatchObject({ from: "starting", to: "idle", turn: 0 });
  await workspace.hook({
    terminalId: key,
    action: "working",
    signal: "plugin:claude:UserPromptSubmit",
  });
  expect(events.at(-1)).toMatchObject({ to: "working", turn: 1 });
  workspace.output("t1");
  workspace.input("t1");
  expect(workspace.snapshot().terminals[0]?.execution?.phase).toBe("working");
  const response = held<VerdictRecord>();
  classify.mockReturnValueOnce(response.promise);
  const ending = workspace.hook({
    terminalId: key,
    action: "classify",
    signal: "plugin:claude:Stop",
  });
  expect(events.at(-1)).toMatchObject({ from: "working", to: "idle", turn: 1 });
  await vi.waitFor(() => {
    expect(classify).toHaveBeenCalledTimes(2);
  });
  response.resolve({
    id: "end",
    terminalId: "t1",
    timestamp: "now",
    verdict: { state: "working", signal: "rules:ambiguous", reason: "Ambiguous", confidence: 0.25 },
  });
  await ending;
  expect(states.at(-1)?.state).toBe("done");
  const count = events.length;
  await workspace.evidence("t1", { title: "✳ Finished", progress: null });
  expect(events).toHaveLength(count);
  await workspace.hook({
    terminalId: key,
    action: "working",
    signal: "plugin:claude:UserPromptSubmit",
  });
  await workspace.exited("t1", 0);
  expect(states.at(-1)?.state).toBe("failed");
  expect(events.at(-1)?.to).toBe("exited");
  off();
  await workspace.dispose();
});

test("an old classification cannot stop a newer turn; blocking screens outrank working titles", async () => {
  const workspace = await launched();
  const key = await bound();
  const response = held<VerdictRecord>();
  classify.mockReturnValueOnce(response.promise);
  const pending = workspace.quiet("t1");
  await vi.waitFor(() => {
    expect(classify).toHaveBeenCalledOnce();
  });
  await workspace.hook({
    terminalId: key,
    action: "working",
    signal: "plugin:claude:UserPromptSubmit",
  });
  response.resolve({
    id: "old",
    terminalId: "t1",
    timestamp: "now",
    verdict: { state: "needs_input", signal: "old", reason: "old", confidence: 1 },
  });
  await pending;
  expect(commit).not.toHaveBeenCalled();
  expect(workspace.snapshot().terminals[0]?.execution?.phase).toBe("working");
  tails.set("t1", ["────────────────────────────", "esc to cancel", "enter to confirm"]);
  await workspace.evidence("t1", { title: "◐ Working", progress: null });
  expect(workspace.snapshot().terminals[0]?.execution?.phase).toBe("blocked");
  workspace.input("t1");
  await workspace.feedback("t1", states.at(-1)?.verdictId ?? null, "dismissed");
  expect(workspace.snapshot().terminals[0]?.execution?.phase).toBe("blocked");
  await workspace.dispose();
});

test("consecutive hook-only turns publish fresh completion verdicts and spinner frames do not add turns", async () => {
  const workspace = await launched();
  const key = await bound();
  tails.set("t1", ["Finished"]);
  for (const turn of [1, 2]) {
    await workspace.hook({
      terminalId: key,
      action: "working",
      signal: "plugin:claude:UserPromptSubmit",
    });
    await workspace.hook({ terminalId: key, action: "classify", signal: "plugin:claude:Stop" });
    expect(states.at(-1)).toMatchObject({ state: "done", execution: { turn, phase: "idle" } });
  }
  expect(states.filter((state) => state.state === "done")).toHaveLength(2);
  await workspace.evidence("t1", { title: "◐ Thinking", progress: null });
  const snapshot = workspace.snapshot().terminals[0]?.execution;
  await workspace.evidence("t1", { title: "◓ Thinking", progress: null });
  expect(workspace.snapshot().terminals[0]?.execution).toEqual(snapshot);
  await workspace.evidence("t1", { title: "✳ Idle after Esc", progress: null });
  expect(workspace.snapshot().terminals[0]?.execution?.phase).toBe("idle");
  await workspace.dispose();
});

test("input during an agent dismissal records no second action and failed feedback can be retried", async () => {
  const workspace = await launched();
  await workspace.quiet("t1");
  const write = held<undefined>();
  recordAction.mockReturnValueOnce(write.promise);
  const dismissing = workspace.feedback("t1", "v1", "dismissed");
  workspace.input("t1");
  expect(recordAction).toHaveBeenCalledTimes(1);
  write.resolve(undefined);
  await dismissing;
  recordAction.mockRejectedValueOnce(new Error("disk"));
  await expect(workspace.feedback("t1", "v1", "dismissed")).rejects.toThrow("disk");
  workspace.input("t1");
  expect(recordAction).toHaveBeenCalledTimes(2);
  await workspace.dispose();
});

test("screen blockers clear on verified progress, including subsequent spinner frames", async () => {
  const workspace = await launched();
  tails.set("t1", ["───", "Continue?", "enter to confirm · esc to cancel"]);
  await workspace.evidence("t1", { title: "◐ Working", progress: null });
  expect(workspace.snapshot().terminals[0]?.execution?.phase).toBe("blocked");
  await workspace.evidence("t1", { title: "◓ Working", progress: null });
  expect(workspace.snapshot().terminals[0]?.execution?.phase).toBe("blocked");
  tails.set("t1", ["Making progress"]);
  await workspace.evidence("t1", { title: "◑ Working", progress: null });
  expect(states.at(-1)).toMatchObject({
    state: "working",
    execution: { phase: "working", turn: 1 },
  });
  tails.set("t1", ["───", "Continue?", "enter to confirm · esc to cancel"]);
  await workspace.quiet("t1");
  tails.set("t1", ["Making progress"]);
  await workspace.quiet("t1");
  expect(states.at(-1)).toMatchObject({
    state: "working",
    execution: { phase: "working", turn: 1 },
  });
  await workspace.dispose();
});

test("ambiguous output and spinners cannot clear an explicit permission hook", async () => {
  const workspace = await launched();
  const key = await bound();
  await workspace.hook({
    terminalId: key,
    action: "needs_input",
    signal: "plugin:claude:PermissionRequest",
  });
  tails.set("t1", ["Making progress"]);
  await workspace.evidence("t1", { title: "◐ Working", progress: null });
  await workspace.evidence("t1", { title: "◓ Working", progress: null });
  expect(states.at(-1)?.state).toBe("needs_input");
  expect(workspace.snapshot().terminals[0]?.execution?.phase).toBe("blocked");
  await workspace.dispose();
});

test("dismissal survives unchanged evaluations and spinner frames until fresh screen attention", async () => {
  const workspace = await launched();
  tails.set("t1", ["───", "Continue?", "enter to confirm · esc to cancel"]);
  await workspace.evidence("t1", { title: "◐ Working", progress: null });
  await workspace.feedback("t1", states.at(-1)?.verdictId ?? null, "dismissed");
  await workspace.quiet("t1");
  tails.set("t1", ["Unrelated progress", "───", "Continue?", "enter to confirm · esc to cancel"]);
  await workspace.evidence("t1", { title: "◓ Working", progress: null });
  expect(states.at(-1)).toMatchObject({ state: "quiet_ok", execution: { phase: "blocked" } });
  tails.set("t1", ["───", "Delete files?", "enter to confirm · esc to cancel"]);
  await workspace.quiet("t1");
  expect(states.at(-1)?.state).toBe("needs_input");
  await workspace.feedback("t1", states.at(-1)?.verdictId ?? null, "dismissed");
  tails.set("t1", ["Making progress"]);
  await workspace.quiet("t1");
  expect(states.at(-1)?.state).toBe("working");
  tails.set("t1", ["───", "Delete files?", "enter to confirm · esc to cancel"]);
  await workspace.quiet("t1");
  expect(states.at(-1)?.state).toBe("needs_input");
  await workspace.dispose();
});

test("dismissed hook attention stays quiet until a new permission event", async () => {
  const workspace = await launched();
  const key = await bound();
  const signal: HookSignal = {
    terminalId: key,
    action: "needs_input",
    signal: "plugin:claude:PermissionRequest",
  };
  await workspace.hook(signal);
  await workspace.feedback("t1", states.at(-1)?.verdictId ?? null, "dismissed");
  tails.set("t1", ["Unrelated output"]);
  await workspace.quiet("t1");
  expect(states.at(-1)?.state).toBe("quiet_ok");
  await workspace.hook(signal);
  expect(states.at(-1)?.state).toBe("needs_input");
  await workspace.dispose();
});

test("permission approval needs fresh working evidence and a cleared agent form", async () => {
  const workspace = await launched();
  const key = await bound();
  await workspace.hook({
    terminalId: key,
    action: "working",
    signal: "plugin:claude:UserPromptSubmit",
  });
  await workspace.hook({
    terminalId: key,
    action: "needs_input",
    signal: "plugin:claude:PermissionRequest",
  });
  tails.set("t1", ["───", "enter to confirm · esc to cancel"]);
  workspace.input("t1");
  await workspace.quiet("t1");
  expect(states.at(-1)?.state).toBe("needs_input");
  await workspace.evidence("t1", { title: "◐ Claude Code", progress: null });
  expect(states.at(-1)?.state).toBe("needs_input");
  tails.set("t1", ["Bash(npm test)", "Running…"]);
  await workspace.evidence("t1", { title: "◓ Claude Code", progress: null });
  expect(states.at(-1)).toMatchObject({
    state: "working",
    execution: { phase: "working", turn: 1 },
  });
  await workspace.hook({
    terminalId: key,
    action: "needs_input",
    signal: "plugin:claude:PermissionRequest",
  });
  await workspace.evidence("t1", { title: "◑ Claude Code", progress: null });
  expect(states.at(-1)?.state).toBe("needs_input");
  await workspace.dispose();
});

test.each(["Password:", "Continue? (y/n)", "Press Enter"])(
  "working agent titles outrank generic text: %s",
  async (line) => {
    const workspace = await launched();
    const events: ExecutionTransition[] = [];
    workspace.subscribeExecution((event) => events.push(event));
    tails.set("t1", [line]);
    for (const frame of ["◐", "◓", "◑", "◒"]) {
      await workspace.evidence("t1", { title: `${frame} Claude Code`, progress: null });
      await workspace.quiet("t1");
    }
    expect(events.map(({ to }) => to)).toEqual(["working"]);
    expect(states.at(-1)?.state).toBe("working");
    await workspace.dispose();
  },
);

test("Claude title-only turn ends stay neutral, then a late Stop completes once", async () => {
  const workspace = await launched();
  const key = await bound();
  tails.set("t1", ["Ready"]);
  await workspace.hook({
    terminalId: key,
    action: "working",
    signal: "plugin:claude:UserPromptSubmit",
  });
  await workspace.evidence("t1", { title: "✳ Claude Code", progress: null });
  expect(states.at(-1)).toMatchObject({ state: "quiet_ok", execution: { phase: "idle" } });
  await workspace.hook({ terminalId: key, action: "classify", signal: "plugin:claude:Stop" });
  expect(states.at(-1)?.state).toBe("done");
  await workspace.hook({ terminalId: key, action: "classify", signal: "plugin:claude:Stop" });
  expect(states.filter(({ state }) => state === "done")).toHaveLength(1);
  await workspace.dispose();
});

test("identical dismissed prompt alerts again in a later turn", async () => {
  const workspace = await launched();
  const key = await bound();
  for (const turn of [1, 2]) {
    await workspace.hook({
      terminalId: key,
      action: "working",
      signal: "plugin:claude:UserPromptSubmit",
    });
    tails.set("t1", ["───", "Same question", "enter to confirm · esc to cancel"]);
    await workspace.quiet("t1");
    expect(states.at(-1)).toMatchObject({ state: "needs_input", execution: { turn } });
    await workspace.feedback("t1", states.at(-1)?.verdictId ?? null, "dismissed");
    await workspace.quiet("t1");
    expect(states.at(-1)?.state).toBe("quiet_ok");
    tails.set("t1", ["Finished"]);
    await workspace.hook({ terminalId: key, action: "classify", signal: "plugin:claude:Stop" });
  }
  await workspace.dispose();
});

test("provider stalls recover on a working title while the provider line remains visible", async () => {
  const workspace = new Workspace(deps);
  await workspace.launch({
    agent: "codex",
    repository: repo.path,
    worktree: tree.path,
    cols: 80,
    rows: 24,
  });
  tails.set("t1", []);
  await workspace.evidence("t1", { title: "⠋ codex", progress: null });
  tails.set("t1", ["Selected model is at capacity"]);
  await workspace.evidence("t1", { title: "codex", progress: null });
  await workspace.quiet("t1");
  expect(states.at(-1)).toMatchObject({
    state: "needs_input",
    attentionKind: "provider",
    reason: "Provider unavailable",
    execution: { phase: "blocked" },
  });
  workspace.input("t1");
  await workspace.quiet("t1");
  expect(states.at(-1)).toMatchObject({
    state: "needs_input",
    attentionKind: "provider",
    execution: { phase: "blocked" },
  });
  // Fresh working evidence resumes execution without clearing provider history.
  await workspace.evidence("t1", { title: "⠹ codex", progress: null });
  expect(states.at(-1)).toMatchObject({ state: "working", execution: { phase: "working" } });
  expect(states.at(-1)?.attentionKind).toBeUndefined();
  await workspace.dispose();
});
