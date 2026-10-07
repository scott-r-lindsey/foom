import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AgentHooks, AgentId, AgentLaunch, AgentScan } from "../../../../src/shared/agents";
import type { EvaluationInput, VerdictRecord } from "../../../../src/shared/evaluator";
import type { HookAgent, HookLaunch, HookSignal } from "../../../../src/shared/hooks";
import type { TerminalState } from "../../../../src/shared/workspace";
import { evaluateRules } from "../../../../src/main/evaluator/evaluator";
import { Workspace } from "../../../../src/main/workspace/workspace";
import type { WorkspaceDependencies } from "../../../../src/main/workspace/workspace";

type Launched = { id: string; attention: "hooks" | "evaluator" };
const repo = { path: "/repos/app", name: "app" };
const tree = {
  path: "/trees/app/feature",
  head: "abc",
  bare: false,
  branch: "feature",
  locked: false,
  prunable: false,
  managed: true,
};
const scan: AgentScan = {
  path: "/login/bin",
  warning: null,
  agents: [{ id: "claude", path: "/bin/claude", version: "2.1.285", hooks: true, reason: "ok" }],
};

let states: TerminalState[];
let tails: Map<string, string[]>;
let evaluated: EvaluationInput[];
let prepare: ((agent: AgentId) => Promise<AgentHooks>) | undefined;
let agents: {
  scan: ReturnType<typeof vi.fn<() => Promise<AgentScan>>>;
  launch: ReturnType<typeof vi.fn<(request: AgentLaunch) => Promise<Launched>>>;
  release: ReturnType<typeof vi.fn<(id: string) => void>>;
  dispose: ReturnType<typeof vi.fn<() => void>>;
  setHooksEnabled: ReturnType<typeof vi.fn<(enabled: boolean) => void>>;
};
let deps: WorkspaceDependencies;
let receiver: {
  register: ReturnType<typeof vi.fn<(key: string, agent: HookAgent) => HookLaunch>>;
  close: ReturnType<typeof vi.fn<() => Promise<void>>>;
};
let verdictCount: number;
const recordAction = vi.fn<(id: string, verdictId: string, action: string) => Promise<void>>();
const terminalTail = vi.fn((id: string) => {
  const tail = tails.get(id);
  return tail ? Promise.resolve(tail) : Promise.reject(new Error("gone"));
});
const classify = vi.fn((input: EvaluationInput): Promise<VerdictRecord> => {
  evaluated.push(input);
  return Promise.resolve({
    id: `v${String(++verdictCount)}`,
    terminalId: input.terminalId,
    timestamp: "now",
    verdict: evaluateRules(input),
  });
});
const commit = vi.fn<(record: VerdictRecord) => Promise<void>>();
const startReceiver = vi.fn(() => Promise.resolve(receiver));

beforeEach(() => {
  states = [];
  evaluated = [];
  verdictCount = 0;
  tails = new Map([["t1", ["Continue? (y/n)"]]]);
  recordAction.mockReset().mockResolvedValue();
  terminalTail.mockClear();
  classify.mockClear();
  commit.mockReset().mockResolvedValue();
  startReceiver.mockClear();
  receiver = {
    register: vi.fn<(key: string, agent: HookAgent) => HookLaunch>(() => ({
      env: { FOOM_SESSION: "s", FOOM_TOKEN: "t", FOOM_HOOK_URL: "http://127.0.0.1:1/hooks" },
      revoke: vi.fn(),
    })),
    close: vi.fn<() => Promise<void>>().mockResolvedValue(),
  };
  agents = {
    scan: vi.fn<() => Promise<AgentScan>>().mockResolvedValue(scan),
    launch: vi
      .fn<(request: AgentLaunch) => Promise<Launched>>()
      .mockResolvedValue({ id: "t1", attention: "hooks" }),
    release: vi.fn<(id: string) => void>(),
    dispose: vi.fn<() => void>(),
    setHooksEnabled: vi.fn<(enabled: boolean) => void>(),
  };
  deps = {
    acknowledgeCodex: vi.fn(async () => {}),
    worktrees: {
      listRepositories: vi.fn(() => [repo]),
      addRepository: vi.fn(() => Promise.resolve(repo)),
      listWorktrees: vi.fn(() => Promise.resolve([tree])),
      validateBranch: vi.fn(async () => {}),
      launchIdentity: vi.fn(() => Promise.resolve("identity")),
      removalIdentity: vi.fn(() => Promise.resolve("identity")),
      changes: vi.fn(() => Promise.resolve("")),
      removeRepository: vi.fn(async () => {}),
      removeWorktree: vi.fn(async () => {}),
      createWorktree: vi.fn(() => Promise.resolve(tree.path)),
    },
    terminals: {
      stop: vi.fn(async () => {}),
      kill: vi.fn(async () => {}),
      create: vi.fn(() => Promise.resolve("t1")),
      tail: terminalTail,
    },
    verdicts: {
      classify,
      commit,
      recordAction,
    },
    receiver: startReceiver,
    onState: (state) => {
      states.push(state);
    },
    agents: (next) => {
      prepare = next;
      return agents;
    },
    now: () => 1000,
  };
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function launched(): Promise<Workspace> {
  const workspace = new Workspace(deps);
  await workspace.launch({
    agent: "claude",
    repository: repo.path,
    worktree: tree.path,
    cols: 80,
    rows: 24,
  });
  return workspace;
}

test("launches into a known repository and lists the terminal with its branch", async () => {
  const workspace = await launched();
  expect(agents.scan).toHaveBeenCalledOnce();
  expect(workspace.snapshot()).toEqual({
    repositories: [repo],
    terminals: [
      {
        id: "t1",
        kind: "agent",
        agent: "claude",
        repository: repo.path,
        worktree: tree.path,
        branch: "feature",
        attention: "hooks",
        bypass: false,
        state: null,
        exited: false,
      },
    ],
  });
  await workspace.quiet("t1");
  expect(workspace.snapshot().terminals[0]?.state?.state).toBe("needs_input");
});

test("records an unknown branch as null and rejects unknown repositories", async () => {
  vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([]);
  const workspace = await launched();
  expect(workspace.snapshot().terminals[0]?.branch).toBeNull();
  await expect(
    workspace.launch({ agent: "claude", repository: "/other", worktree: "/x", cols: 80, rows: 24 }),
  ).rejects.toThrow("Repository has not been added");
  await expect(workspace.worktrees("/other")).rejects.toThrow("Repository has not been added");
  await expect(workspace.createWorktree("/other", "b", "root")).rejects.toThrow(
    "Repository has not been added",
  );
});

test("adds repositories, lists and creates worktrees through the service", async () => {
  const changed = vi.fn();
  const workspace = new Workspace({ ...deps, onChange: changed });
  await expect(workspace.addRepository("/repos/app")).resolves.toBe(repo);
  expect(changed).toHaveBeenCalledOnce();
  await expect(workspace.worktrees(repo.path)).resolves.toEqual([tree]);
  await expect(workspace.createWorktree(repo.path, "feature", "adjacent")).resolves.toBe(tree);
  expect(vi.mocked(deps.worktrees.createWorktree)).toHaveBeenCalledWith(repo.path, "feature", {
    location: "adjacent",
  });
  vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([]);
  await expect(workspace.createWorktree(repo.path, "feature", "root")).rejects.toThrow(
    "Created worktree is missing",
  );
});

test("caches agent scans until a refresh and retries after a failed scan", async () => {
  const workspace = new Workspace(deps);
  await expect(workspace.scanAgents(false)).resolves.toEqual({
    warning: null,
    agents: scan.agents,
  });
  await workspace.scanAgents(false);
  expect(agents.scan).toHaveBeenCalledOnce();
  await workspace.scanAgents(true);
  expect(agents.scan).toHaveBeenCalledTimes(2);
  agents.scan.mockRejectedValueOnce(new Error("probe"));
  await expect(workspace.scanAgents(true)).rejects.toThrow("probe");
  await workspace.scanAgents(false);
  expect(agents.scan).toHaveBeenCalledTimes(4);
});

test("uses the real agent service by default", async () => {
  const defaults: WorkspaceDependencies = { ...deps };
  delete defaults.agents;
  const workspace = new Workspace(defaults);
  await expect(
    workspace.launch({
      agent: "claude",
      repository: repo.path,
      worktree: "relative",
      cols: 80,
      rows: 24,
    }),
  ).rejects.toThrow("Invalid worktree path");
});

test("quiet terminals are evaluated from their tail and reported", async () => {
  const workspace = new Workspace(deps);
  tails.set("shell", ["$ ls", "README.md"]);
  await workspace.quiet("shell");
  expect(evaluated[0]).toEqual({ terminalId: "shell", tail: ["$ ls", "README.md"] });
  expect(states).toEqual([
    {
      id: "shell",
      verdictId: "v1",
      state: "working",
      reason: "No completion or input request detected",
      signal: "rules:ambiguous",
      confidence: 0.25,
      timestamp: 1000,
    },
  ]);
});

test("a permission hook stays in force across later quiet evaluations until a reply", async () => {
  const workspace = await launched();
  const hooks = await prepare?.("claude");
  if (!hooks?.bind) throw new Error("Missing hooks");
  hooks.bind("t1");
  const key = receiver.register.mock.calls[0]?.[0] ?? "";
  tails.set("t1", ["╭ Allow Bash(npm test)? ╮"]);
  const signal: HookSignal = {
    terminalId: key,
    action: "needs_input",
    signal: "claude:PermissionRequest",
  };
  await workspace.hook(signal);
  expect(evaluated[0]?.hook).toEqual({ ...signal, terminalId: "t1" });
  expect(states.at(-1)).toMatchObject({ state: "needs_input", signal: "claude:PermissionRequest" });
  // The TUI's dialog doesn't match any text rule; the hook keeps the verdict.
  await workspace.quiet("t1");
  expect(states.at(-1)).toMatchObject({ state: "needs_input", verdictId: "v2" });

  workspace.input("t1");
  expect(states.at(-1)).toMatchObject({ state: "working", verdictId: null, signal: "user:reply" });
  expect(recordAction).toHaveBeenCalledWith("t1", "v2", "replied");
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
  await workspace.hook({ terminalId: key, action: "classify", signal: "claude:Stop" });
  expect(evaluated[0]?.hook).toBeUndefined();
  expect(states.at(-1)?.state).toBe("working");
  await workspace.hook({
    terminalId: "nobody",
    action: "needs_input",
    signal: "claude:PermissionRequest",
  });
  expect(evaluated).toHaveLength(1);
  // A disposed binding no longer maps its key.
  hooks?.dispose();
  await workspace.hook({ terminalId: key, action: "classify", signal: "claude:Stop" });
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
    signal: "claude:PermissionRequest",
  });
  await workspace.exited("t1", 0);
  expect(evaluated).toHaveLength(1);
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
  const workspace = await launched();
  await workspace.quiet("t1");
  await workspace.feedback("t1", "v1", "ignored");
  expect(states.at(-1)?.state).toBe("needs_input");
  await workspace.quiet("t1");
  await workspace.feedback("t1", "v1", "dismissed");
  expect(states.at(-1)?.verdictId).toBe("v2");
  await workspace.feedback("t1", "v2", "dismissed");
  expect(recordAction).toHaveBeenLastCalledWith("t1", "v2", "dismissed");
  expect(states.at(-1)).toMatchObject({ state: "quiet_ok", signal: "user:dismissed" });
  await workspace.quiet("t1");
  await workspace.feedback("t1", "v3", "replied");
  expect(states.at(-1)).toMatchObject({ state: "working", signal: "user:reply" });
  recordAction.mockRejectedValueOnce(new Error("Invalid verdict feedback"));
  await expect(workspace.feedback("t1", "v3", "dismissed")).rejects.toThrow("Invalid verdict");
});

test("a failed reply record is logged, not thrown into the input path", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const workspace = await launched();
  await workspace.quiet("t1");
  recordAction.mockRejectedValueOnce(new Error("disk full"));
  workspace.input("t1");
  await vi.waitFor(() => {
    expect(error).toHaveBeenCalledWith("Unable to record reply:", expect.any(Error));
  });
});

test("hook preparation starts the receiver once, retries a failed start, and refuses agy", async () => {
  const workspace = new Workspace(deps);
  startReceiver.mockRejectedValueOnce(new Error("port"));
  await expect(prepare?.("claude")).rejects.toThrow("port");
  const first = await prepare?.("claude");
  const second = await prepare?.("codex");
  expect(startReceiver).toHaveBeenCalledTimes(2);
  expect(first?.claudeCommand).toMatch(/^sh '.*claude\.sh'$/u);
  expect(second?.codexCommand.at(-1)).toMatch(/codex\.sh$/u);
  await expect(prepare?.("agy")).rejects.toThrow("Antigravity hooks are not supported");
  first?.dispose();
  second?.dispose();
  await workspace.dispose();
  expect(receiver.close).toHaveBeenCalledOnce();
});

test("dispose releases agents, closes the receiver once, and refuses new work", async () => {
  const workspace = await launched();
  await workspace.dispose();
  await workspace.dispose();
  expect(agents.dispose).toHaveBeenCalledOnce();
  expect(receiver.close).not.toHaveBeenCalled();
  await expect(
    workspace.launch({
      agent: "claude",
      repository: repo.path,
      worktree: tree.path,
      cols: 80,
      rows: 24,
    }),
  ).rejects.toThrow("Workspace is closed");
  await workspace.quiet("t1");
  expect(evaluated).toHaveLength(0);
});

test("dispose tolerates a receiver that fails while starting", async () => {
  const workspace = new Workspace(deps);
  let fail: (error: Error) => void = () => {};
  startReceiver.mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      fail = reject;
    }),
  );
  const attempt = prepare?.("claude");
  const disposing = workspace.dispose();
  fail(new Error("port"));
  await expect(attempt).rejects.toThrow("port");
  await expect(disposing).resolves.toBeUndefined();
});

/** Returns a promise and its resolver, for holding a dependency mid-evaluation. */
function held<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Prepares and binds a Claude launch to t1, returning its hook key. */
async function bound(): Promise<string> {
  const hooks = await prepare?.("claude");
  hooks?.bind?.("t1");
  return receiver.register.mock.calls.at(-1)?.[0] ?? "";
}

test("an evaluation that was in flight during a reply can't restore attention", async () => {
  const workspace = await launched();
  await workspace.quiet("t1");
  expect(states.at(-1)).toMatchObject({ state: "needs_input", verdictId: "v1" });
  // The second evaluation classifies, then waits on its log write.
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

test("a reply before the first permission verdict answers the hook", async () => {
  const workspace = await launched();
  const key = await bound();
  tails.set("t1", ["╭ Allow Bash(npm test)? ╮"]);
  const screen = held<string[]>();
  terminalTail.mockReturnValueOnce(screen.promise);
  const signal: HookSignal = {
    terminalId: key,
    action: "needs_input",
    signal: "claude:PermissionRequest",
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
  expect(states).toEqual([]);
  expect(recordAction).not.toHaveBeenCalled();
  await workspace.quiet("t1");
  expect(evaluated.at(-1)?.hook).toBeUndefined();
  expect(states.at(-1)?.state).toBe("working");
});

test("a verdict that can't be stored is still reported, with no feedback target", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const workspace = await launched();
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

test("the branch is looked up before spawning, so a failed lookup launches nothing", async () => {
  vi.mocked(deps.worktrees.listWorktrees).mockRejectedValueOnce(new Error("git"));
  const workspace = new Workspace(deps);
  await expect(
    workspace.launch({
      agent: "claude",
      repository: repo.path,
      worktree: tree.path,
      cols: 80,
      rows: 24,
    }),
  ).rejects.toThrow("git");
  expect(agents.launch).not.toHaveBeenCalled();
  expect(workspace.snapshot().terminals).toEqual([]);
});

test("a hook that arrives before launch returns is kept", async () => {
  const workspace = new Workspace(deps);
  tails.set("t1", ["╭ Allow Bash(npm test)? ╮"]);
  let early: Promise<void> = Promise.resolve();
  agents.launch.mockImplementationOnce(async () => {
    const key = await bound();
    early = workspace.hook({
      terminalId: key,
      action: "needs_input",
      signal: "claude:PermissionRequest",
    });
    await early;
    return { id: "t1", attention: "hooks" };
  });
  await workspace.launch({
    agent: "claude",
    repository: repo.path,
    worktree: tree.path,
    cols: 80,
    rows: 24,
  });
  expect(states.at(-1)).toMatchObject({ state: "needs_input", signal: "claude:PermissionRequest" });
  await workspace.quiet("t1");
  expect(workspace.snapshot().terminals[0]?.state).toMatchObject({ state: "needs_input" });
});

test("preflight settings control hooks and which agents may launch", async () => {
  const workspace = new Workspace(deps);
  workspace.configure({ hooks: false, agents: { claude: false, codex: true, agy: true } });
  expect(agents.setHooksEnabled).toHaveBeenCalledWith(false);
  await expect(
    workspace.launch({
      agent: "claude",
      repository: repo.path,
      worktree: tree.path,
      cols: 80,
      rows: 24,
    }),
  ).rejects.toThrow("turned off in preflight");
  expect(agents.launch).not.toHaveBeenCalled();
  workspace.configure({ hooks: true, agents: { claude: true, codex: true, agy: true } });
  await workspace.launch({
    agent: "claude",
    repository: repo.path,
    worktree: tree.path,
    cols: 80,
    rows: 24,
  });
  expect(agents.launch).toHaveBeenCalledOnce();
});

const start = {
  repository: repo.path,
  branch: "feature",
  run: "shell" as const,
  acknowledgeCodexNotifierReplacement: false,
};

test("launches multiple shells in a managed worktree", async () => {
  const workspace = new Workspace(deps);
  expect(await workspace.startWorktree(start)).toBe("t1");
  expect(vi.spyOn(deps.terminals, "create")).toHaveBeenCalledWith(
    expect.objectContaining({ cwd: tree.path, cols: 80, rows: 24 }),
  );
  expect(workspace.snapshot().terminals[0]).toMatchObject({ kind: "shell", branch: "feature" });
  vi.spyOn(deps.terminals, "create").mockResolvedValueOnce("t2");
  expect(await workspace.startWorktree(start)).toBe("t2");
  expect(workspace.snapshot().terminals).toHaveLength(2);
  await workspace.exited("t1", 0);
  await workspace.startWorktree(start);
  await workspace.dispose();
});

test("creates missing worktrees at the configured location and persists Codex acknowledgement once", async () => {
  const listing = vi
    .spyOn(deps.worktrees, "listWorktrees")
    .mockResolvedValueOnce([])
    .mockResolvedValue([tree]);
  const workspace = new Workspace(deps);
  workspace.configure({
    hooks: true,
    agents: { claude: true, codex: true, agy: true },
    worktreeLocation: "adjacent",
  });
  await workspace.startWorktree({
    ...start,
    run: "codex",
    acknowledgeCodexNotifierReplacement: true,
  });
  expect(vi.mocked(deps.worktrees.createWorktree)).toHaveBeenCalledWith(repo.path, "feature", {
    location: "adjacent",
  });
  expect(vi.spyOn(deps, "acknowledgeCodex")).toHaveBeenCalledOnce();
  expect(agents.launch).toHaveBeenCalledWith(
    expect.objectContaining({ agent: "codex", acknowledgeCodexNotifierReplacement: true }),
  );
  await workspace.exited("t1", 0);
  await workspace.startWorktree({
    ...start,
    run: "codex",
    acknowledgeCodexNotifierReplacement: true,
  });
  expect(vi.spyOn(deps, "acknowledgeCodex")).toHaveBeenCalledOnce();
  expect(listing).toHaveBeenCalled();
  await workspace.dispose();
});

test("refuses unknown, unmanaged, locked, prunable and invalid branches without spawning", async () => {
  const workspace = new Workspace(deps);
  await expect(workspace.startWorktree({ ...start, repository: "/unknown" })).rejects.toThrow(
    "not been added",
  );
  for (const change of [{ managed: false }, { locked: true }, { prunable: true }]) {
    vi.spyOn(deps.worktrees, "listWorktrees").mockResolvedValueOnce([{ ...tree, ...change }]);
    await expect(workspace.startWorktree(start)).rejects.toThrow();
  }
  vi.spyOn(deps.worktrees, "validateBranch").mockRejectedValueOnce(new Error("Invalid branch"));
  await expect(workspace.startWorktree(start)).rejects.toThrow("Invalid branch");
  expect(vi.spyOn(deps.terminals, "create")).not.toHaveBeenCalled();
  await workspace.dispose();
  await expect(workspace.startWorktree(start)).rejects.toThrow("closed");
});

test("serializes branch launches and unlocks after failure", async () => {
  const deferred = Promise.withResolvers<undefined>();
  vi.spyOn(deps.worktrees, "validateBranch").mockReturnValueOnce(deferred.promise);
  const workspace = new Workspace(deps);
  const first = workspace.startWorktree(start);
  await expect(workspace.startWorktree(start)).rejects.toThrow("busy");
  deferred.reject(new Error("invalid"));
  await expect(first).rejects.toThrow("invalid");
  await workspace.startWorktree(start);
  await workspace.dispose();
});

test("cancelled or stale dirty-file confirmations never kill or remove", async () => {
  const workspace = new Workspace(deps);
  await workspace.startWorktree(start);
  const dirty = " M file.ts\0?? notes.txt\0";
  vi.spyOn(deps.worktrees, "changes").mockResolvedValue(dirty);
  const confirm = vi.fn(() => Promise.resolve(false));
  expect(await workspace.removeWorktree("t1", confirm)).toBe(false);
  expect(confirm).toHaveBeenCalledWith("feature", dirty);
  vi.spyOn(deps.worktrees, "changes")
    .mockResolvedValueOnce(dirty)
    .mockResolvedValueOnce("?? new.txt\0");
  await expect(workspace.removeWorktree("t1", () => Promise.resolve(true))).rejects.toThrow(
    "Review them",
  );
  expect(vi.spyOn(deps.terminals, "kill")).not.toHaveBeenCalled();
  expect(vi.mocked(deps.worktrees.removeWorktree)).not.toHaveBeenCalled();
  await workspace.dispose();
});

test.each(["", "?? file.txt\0"])(
  "confirmed removal stops the terminal and removes only its owned worktree (%s)",
  async (changes) => {
    const workspace = new Workspace(deps);
    await workspace.startWorktree(start);
    vi.spyOn(deps.worktrees, "changes").mockResolvedValue(changes);
    expect(await workspace.removeWorktree("t1", () => Promise.resolve(true))).toBe(true);
    expect(vi.spyOn(deps.terminals, "kill")).toHaveBeenCalledWith("t1");
    expect(vi.mocked(deps.worktrees.removeWorktree)).toHaveBeenCalledWith(
      repo.path,
      tree.path,
      changes.length > 0,
      "identity",
    );
    expect(workspace.snapshot().terminals).toEqual([]);
    await expect(workspace.removeWorktree("t1", () => Promise.resolve(true))).rejects.toThrow(
      "Unknown",
    );
    await workspace.dispose();
  },
);

test("failed removal leaves the row available for retry and excludes overlapping operations", async () => {
  const workspace = new Workspace(deps);
  await workspace.startWorktree(start);
  const confirmation = Promise.withResolvers<boolean>();
  const removing = workspace.removeWorktree("t1", () => confirmation.promise);
  await expect(workspace.removeWorktree("t1", () => Promise.resolve(true))).rejects.toThrow("busy");
  await expect(workspace.startWorktree(start)).rejects.toThrow("busy");
  vi.spyOn(deps.worktrees, "removeWorktree").mockRejectedValueOnce(new Error("filesystem busy"));
  confirmation.resolve(true);
  await expect(removing).rejects.toThrow("filesystem busy");
  expect(workspace.snapshot().terminals).toHaveLength(1);
  await workspace.removeWorktree("t1", () => Promise.resolve(true));
  expect(workspace.snapshot().terminals).toHaveLength(0);
  await workspace.dispose();
});

test.each(["", "?? reviewed.txt\0"])(
  "shutdown changes require fresh review and permit retry (%s)",
  async (changes) => {
    const workspace = new Workspace(deps);
    await workspace.startWorktree(start);
    const changed = changes + "?? NEW-AFTER-CONFIRM.txt\0";
    vi.spyOn(deps.worktrees, "changes").mockResolvedValue(changes);
    const shutdown = Promise.withResolvers<undefined>();
    const stop = vi.spyOn(deps.terminals, "stop").mockImplementationOnce(async () => {
      await shutdown.promise;
      vi.spyOn(deps.worktrees, "changes").mockResolvedValue(changed);
    });
    const removal = workspace.removeWorktree("t1", () => Promise.resolve(true));
    const rejected = expect(removal).rejects.toThrow("Review them");
    await vi.waitFor(() => {
      expect(stop).toHaveBeenCalled();
    });
    expect(vi.mocked(deps.worktrees.removeWorktree)).not.toHaveBeenCalled();
    shutdown.resolve(undefined);
    await rejected;
    expect(vi.spyOn(deps.terminals, "kill")).not.toHaveBeenCalled();
    expect(vi.mocked(deps.worktrees.removeWorktree)).not.toHaveBeenCalled();
    expect(workspace.snapshot().terminals).toHaveLength(1);
    expect(workspace.snapshot().terminals[0]?.state?.state).toBe("failed");
    const confirm = vi.fn(() => Promise.resolve(true));
    await workspace.removeWorktree("t1", confirm);
    expect(confirm).toHaveBeenCalledWith("feature", changed);
    expect(workspace.snapshot().terminals).toHaveLength(0);
    await workspace.dispose();
  },
);

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
  expect(states.at(-1)).toMatchObject({ state: "working", signal: "process:output" });
  expect(commit).not.toHaveBeenCalled();
  await workspace.quiet("t1");
  expect(states.at(-1)?.state).toBe("needs_input");
  workspace.output("t1");
  expect(states.at(-1)).toMatchObject({
    state: "working",
    signal: "process:output",
    verdictId: null,
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
    signal: "claude:PermissionRequest",
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

test("sidebar inventory includes empty trees and the actual shell; launches use registered location identities", async () => {
  const workspace = new Workspace(deps);
  vi.stubEnv("SHELL", "/bin/zsh");
  expect(await workspace.sidebarInventory()).toEqual({
    repositories: [{ ...repo, worktrees: [tree] }],
    shell: process.platform === "win32" ? "powershell.exe" : "zsh",
  });
  await workspace.sidebarCommand(
    { kind: "launch", repository: repo.path, worktree: tree.path, run: "shell" },
    () => Promise.resolve(true),
  );
  expect(vi.spyOn(deps.terminals, "create")).toHaveBeenCalledWith(
    expect.objectContaining({
      cwd: tree.path,
      args: process.platform === "win32" ? ["-NoLogo"] : ["-l"],
    }),
  );
  await workspace.sidebarCommand(
    { kind: "launch", repository: repo.path, worktree: tree.path, run: "claude" },
    () => Promise.resolve(true),
  );
  await expect(
    workspace.sidebarCommand(
      { kind: "launch", repository: "/foreign", worktree: tree.path, run: "shell" },
      () => Promise.resolve(true),
    ),
  ).rejects.toThrow("not been added");
  await expect(
    workspace.sidebarCommand(
      { kind: "launch", repository: repo.path, worktree: "/foreign", run: "shell" },
      () => Promise.resolve(true),
    ),
  ).rejects.toThrow("unavailable");
  for (const unavailable of [
    { ...tree, locked: true },
    { ...tree, bare: true },
    { ...tree, prunable: true },
  ]) {
    vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([unavailable]);
    await expect(
      workspace.sidebarCommand(
        { kind: "launch", repository: repo.path, worktree: tree.path, run: "shell" },
        () => Promise.resolve(true),
      ),
    ).rejects.toThrow("unavailable");
  }
  vi.unstubAllEnvs();
});
test("main checkout supports shells and confirms a second agent; cancellation creates nothing", async () => {
  const workspace = new Workspace(deps);
  vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([
    { ...tree, path: repo.path, managed: false },
  ]);
  const command = {
    kind: "launch",
    repository: repo.path,
    worktree: repo.path,
    run: "claude",
  } as const;
  const confirm = vi.fn(() => Promise.resolve(false));
  await workspace.sidebarCommand(command, confirm);
  expect(confirm).not.toHaveBeenCalled();
  expect(agents.launch).toHaveBeenCalledWith(
    expect.objectContaining({ mainCheckout: true, sharedCheckout: true }),
  );
  await workspace.sidebarCommand(command, confirm);
  expect(confirm).toHaveBeenCalledWith("Run another agent in this checkout?", expect.any(String));
  expect(agents.launch).toHaveBeenCalledTimes(1);
  confirm.mockResolvedValue(true);
  agents.launch.mockResolvedValue({ id: "t2", attention: "hooks" });
  await workspace.sidebarCommand(command, confirm);
  expect(workspace.snapshot().terminals).toHaveLength(2);
  vi.spyOn(deps.terminals, "create").mockResolvedValue("shell");
  await workspace.sidebarCommand({ ...command, run: "shell" }, confirm);
  expect(workspace.snapshot().terminals).toHaveLength(3);
});
test("sidebar Codex launches disclose notifier replacement, persist consent and serialize while confirming", async () => {
  const workspace = new Workspace(deps);
  agents.scan.mockResolvedValue({
    ...scan,
    agents: [{ id: "codex", path: "/bin/codex", hooks: true, version: "1", reason: "" }],
  });
  const command = {
    kind: "launch",
    repository: repo.path,
    worktree: tree.path,
    run: "codex",
  } as const;
  await workspace.sidebarCommand(command, () => Promise.resolve(false));
  expect(agents.launch).not.toHaveBeenCalled();
  let resolve: ((answer: boolean) => void) | undefined;
  const starting = workspace.sidebarCommand(
    command,
    () =>
      new Promise((answer) => {
        resolve = answer;
      }),
  );
  await vi.waitFor(() => {
    expect(resolve).toBeTypeOf("function");
  });
  await expect(workspace.sidebarCommand(command, () => Promise.resolve(true))).rejects.toThrow(
    "busy",
  );
  resolve?.(true);
  await starting;
  expect(vi.spyOn(deps, "acknowledgeCodex")).toHaveBeenCalledOnce();
  expect(agents.launch).toHaveBeenCalledWith(
    expect.objectContaining({ acknowledgeCodexNotifierReplacement: true }),
  );
});
test("stop preserves a session and Close only removes exited sessions, never a worktree", async () => {
  const workspace = await launched();
  const confirm = vi.fn(() => Promise.resolve(true));
  await workspace.sidebarCommand({ kind: "stop", id: "t1" }, confirm);
  expect(vi.spyOn(deps.terminals, "stop")).toHaveBeenCalledWith("t1");
  expect(workspace.snapshot().terminals).toHaveLength(1);
  await expect(workspace.sidebarCommand({ kind: "close", id: "t1" }, confirm)).rejects.toThrow(
    "still running",
  );
  await workspace.exited("t1", 0);
  await expect(workspace.sidebarCommand({ kind: "restart", id: "t1" }, confirm)).rejects.toThrow(
    "Only shells",
  );
  await workspace.sidebarCommand({ kind: "close", id: "t1" }, confirm);
  expect(workspace.snapshot().terminals).toHaveLength(0);
  expect(vi.mocked(deps.worktrees.removeWorktree)).not.toHaveBeenCalled();
  await expect(
    workspace.sidebarCommand({ kind: "restart", id: "foreign" }, confirm),
  ).rejects.toThrow("Unknown session");
});
test("an exited shell restarts in its original location and frees its old terminal", async () => {
  const workspace = new Workspace(deps);
  await workspace.sidebarCommand(
    { kind: "launch", repository: repo.path, worktree: tree.path, run: "shell" },
    () => Promise.resolve(true),
  );
  await workspace.exited("t1", 0);
  vi.spyOn(deps.terminals, "create").mockResolvedValue("t2");
  await workspace.sidebarCommand({ kind: "restart", id: "t1" }, () => Promise.resolve(true));
  expect(workspace.snapshot().terminals.map((entry) => entry.id)).toEqual(["t2"]);
  expect(vi.spyOn(deps.terminals, "kill")).toHaveBeenCalledWith("t1");
});
test("repository and external worktree removal confirm and protect the main checkout", async () => {
  const workspace = new Workspace(deps);
  await workspace.sidebarCommand({ kind: "remove-repository", repository: repo.path }, () =>
    Promise.resolve(false),
  );
  expect(vi.mocked(deps.worktrees.removeRepository)).not.toHaveBeenCalled();
  await workspace.sidebarCommand({ kind: "remove-repository", repository: repo.path }, () =>
    Promise.resolve(true),
  );
  expect(vi.mocked(deps.worktrees.removeRepository)).toHaveBeenCalledWith(repo.path);
  vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([{ ...tree, managed: false }]);
  for (const changes of ["", "?? private.txt\0"]) {
    vi.mocked(deps.worktrees.changes).mockResolvedValue(changes);
    const confirm = vi.fn(() => Promise.resolve(true));
    await workspace.sidebarCommand(
      { kind: "remove-worktree", repository: repo.path, worktree: tree.path },
      confirm,
    );
    expect(confirm).toHaveBeenCalledWith(
      "Remove feature?",
      expect.stringContaining(changes ? "private.txt" : "branch is kept"),
    );
  }
  await expect(
    workspace.sidebarCommand(
      { kind: "remove-worktree", repository: repo.path, worktree: repo.path },
      () => Promise.resolve(true),
    ),
  ).rejects.toThrow("main checkout");
  vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([tree]);
  await workspace.sidebarCommand(
    { kind: "launch", repository: repo.path, worktree: tree.path, run: "shell" },
    () => Promise.resolve(true),
  );
  await expect(
    workspace.sidebarCommand({ kind: "remove-repository", repository: repo.path }, () =>
      Promise.resolve(true),
    ),
  ).rejects.toThrow("Close");
  await workspace.dispose();
  await expect(
    workspace.sidebarCommand({ kind: "stop", id: "t1" }, () => Promise.resolve(true)),
  ).rejects.toThrow("closed");
});

const launchEntries = [
  "sidebar-shell",
  "sidebar-agent",
  "agent-ipc",
  "worktree-shell",
  "worktree-agent",
  "create-worktree",
] as const;
function startRepositoryOperation(
  workspace: Workspace,
  entry: (typeof launchEntries)[number],
): Promise<unknown> {
  if (entry === "agent-ipc")
    return workspace.launch({
      agent: "claude",
      repository: repo.path,
      worktree: tree.path,
      cols: 80,
      rows: 24,
    });
  if (entry === "create-worktree") return workspace.createWorktree(repo.path, "feature", "root");
  if (entry === "worktree-shell" || entry === "worktree-agent")
    return workspace.startWorktree({
      repository: repo.path,
      branch: "feature",
      run: entry === "worktree-shell" ? "shell" : "claude",
      acknowledgeCodexNotifierReplacement: false,
    });
  return workspace.sidebarCommand(
    {
      kind: "launch",
      repository: repo.path,
      worktree: repo.path,
      run: entry === "sidebar-shell" ? "shell" : "claude",
    },
    () => Promise.resolve(true),
  );
}

test.each(launchEntries)(
  "repository removal blocks %s through confirmation and deregistration",
  async (entry) => {
    const workspace = new Workspace(deps);
    const answer = Promise.withResolvers<boolean>();
    const deleted = Promise.withResolvers<undefined>();
    vi.mocked(deps.worktrees.removeRepository).mockReturnValue(deleted.promise);
    const removing = workspace.sidebarCommand(
      { kind: "remove-repository", repository: repo.path },
      () => answer.promise,
    );
    await expect(startRepositoryOperation(workspace, entry)).rejects.toThrow(
      "removal is in progress",
    );
    await expect(workspace.removeRepository(repo.path)).rejects.toThrow("busy");
    answer.resolve(true);
    await vi.waitFor(() => {
      expect(vi.mocked(deps.worktrees.removeRepository)).toHaveBeenCalledOnce();
    });
    await expect(startRepositoryOperation(workspace, entry)).rejects.toThrow(
      "removal is in progress",
    );
    expect(vi.spyOn(deps.terminals, "create")).not.toHaveBeenCalled();
    expect(agents.launch).not.toHaveBeenCalled();
    vi.mocked(deps.worktrees.listRepositories).mockReturnValue([]);
    deleted.resolve(undefined);
    await removing;
    await expect(startRepositoryOperation(workspace, entry)).rejects.toThrow("not been added");
    expect(workspace.snapshot().terminals).toEqual([]);
  },
);

test.each(launchEntries)(
  "an in-flight %s reserves its repository before the terminal exists",
  async (entry) => {
    const workspace = new Workspace(deps);
    const listing = Promise.withResolvers<readonly (typeof tree)[]>();
    vi.mocked(deps.worktrees.listWorktrees).mockReturnValue(listing.promise);
    const starting = startRepositoryOperation(workspace, entry);
    await vi.waitFor(() => {
      expect(deps.worktrees.listWorktrees).toHaveBeenCalled();
    });
    const confirm = vi.fn(() => Promise.resolve(true));
    await expect(
      workspace.sidebarCommand({ kind: "remove-repository", repository: repo.path }, confirm),
    ).rejects.toThrow("busy");
    await expect(workspace.removeRepository(repo.path)).rejects.toThrow("busy");
    expect(confirm).not.toHaveBeenCalled();
    expect(deps.worktrees.removeRepository).not.toHaveBeenCalled();
    listing.resolve([tree, { ...tree, path: repo.path, managed: false }]);
    await starting;
    if (entry !== "create-worktree") {
      await expect(workspace.removeRepository(repo.path)).rejects.toThrow("Close");
      await workspace.exited("t1", 0);
      await expect(workspace.removeRepository(repo.path)).rejects.toThrow("Close");
      workspace.removed("t1");
    }
    await workspace.removeRepository(repo.path);
    expect(vi.mocked(deps.worktrees.removeRepository)).toHaveBeenCalledOnce();
  },
);

test("repository reservations are scoped and release after cancellation, confirmation failure and write failure", async () => {
  const workspace = new Workspace(deps);
  const answer = Promise.withResolvers<boolean>();
  const other = { path: "/repos/other", name: "other" };
  vi.mocked(deps.worktrees.listRepositories).mockReturnValue([repo, other]);
  const removing = workspace.removeRepository(repo.path, () => answer.promise);
  await workspace.launch({
    agent: "claude",
    repository: other.path,
    worktree: tree.path,
    cols: 80,
    rows: 24,
  });
  answer.resolve(false);
  await removing;
  expect(deps.worktrees.removeRepository).not.toHaveBeenCalled();
  await expect(
    workspace.removeRepository(repo.path, () => Promise.reject(new Error("dialog"))),
  ).rejects.toThrow("dialog");
  vi.mocked(deps.worktrees.removeRepository).mockRejectedValueOnce(new Error("write"));
  await expect(workspace.removeRepository(repo.path)).rejects.toThrow("write");
  await workspace.removeRepository(repo.path);
  await workspace.dispose();
  await expect(workspace.removeRepository(repo.path)).rejects.toThrow("closed");
});

test("failed and overlapping launches retain the reservation until the last operation settles", async () => {
  const workspace = new Workspace(deps);
  const first = Promise.withResolvers<Launched>();
  const second = Promise.withResolvers<Launched>();
  agents.launch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([
    tree,
    { ...tree, path: "/second", branch: "second" },
  ]);
  const a = startRepositoryOperation(workspace, "agent-ipc");
  const b = workspace.launch({
    agent: "claude",
    repository: repo.path,
    worktree: "/second",
    cols: 80,
    rows: 24,
  });
  await vi.waitFor(() => {
    expect(agents.launch).toHaveBeenCalledTimes(2);
  });
  const failed = expect(a).rejects.toThrow("spawn");
  first.reject(new Error("spawn"));
  await failed;
  await expect(workspace.removeRepository(repo.path)).rejects.toThrow("busy");
  const alsoFailed = expect(b).rejects.toThrow("spawn");
  second.reject(new Error("spawn"));
  await alsoFailed;
  await workspace.removeRepository(repo.path);
  expect(vi.mocked(deps.worktrees.removeRepository)).toHaveBeenCalledOnce();
});

test("repository removal cannot pass while a main-checkout shell is still spawning", async () => {
  const workspace = new Workspace(deps);
  vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([
    { ...tree, path: repo.path, managed: false },
  ]);
  const spawned = Promise.withResolvers<string>();
  const create = vi.spyOn(deps.terminals, "create").mockReturnValueOnce(spawned.promise);
  const starting = startRepositoryOperation(workspace, "sidebar-shell");
  await vi.waitFor(() => {
    expect(create).toHaveBeenCalledOnce();
  });
  await expect(workspace.removeRepository(repo.path)).rejects.toThrow("busy");
  expect(workspace.snapshot().terminals).toEqual([]);
  spawned.resolve("t1");
  await starting;
  await expect(workspace.removeRepository(repo.path)).rejects.toThrow("Close");
  expect(vi.mocked(deps.worktrees.removeRepository)).not.toHaveBeenCalled();
  expect(workspace.snapshot().terminals[0]?.repository).toBe(repo.path);
});

test.each(["shell", "claude", "codex", "agy"] as const)(
  "sidebar launches %s in an external checkout without adopting it",
  async (run) => {
    const workspace = new Workspace(deps);
    vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([
      { ...tree, managed: false, branch: null },
    ]);
    await workspace.sidebarCommand(
      { kind: "launch", repository: repo.path, worktree: tree.path, run },
      () => Promise.resolve(true),
    );
    expect(deps.worktrees.launchIdentity).toHaveBeenCalledWith(repo.path, tree.path);
    if (run === "shell")
      expect(vi.spyOn(deps.terminals, "create")).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: tree.path }),
      );
    else
      expect(agents.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          worktree: tree.path,
          checkoutIdentity: "identity",
          mainCheckout: false,
          sharedCheckout: true,
        }),
      );
    expect(workspace.snapshot().terminals[0]).toMatchObject({ worktree: tree.path, branch: null });
    expect(deps.worktrees.createWorktree).not.toHaveBeenCalled();
  },
);

test("a checkout replaced before shell creation is refused and remains retryable", async () => {
  const workspace = new Workspace(deps);
  vi.mocked(deps.worktrees.launchIdentity)
    .mockResolvedValueOnce("old")
    .mockResolvedValueOnce("new");
  const command = {
    kind: "launch",
    repository: repo.path,
    worktree: tree.path,
    run: "shell",
  } as const;
  await expect(workspace.sidebarCommand(command, () => Promise.resolve(true))).rejects.toThrow(
    "Worktree has changed",
  );
  expect(vi.spyOn(deps.terminals, "create")).not.toHaveBeenCalled();
  await workspace.sidebarCommand(command, () => Promise.resolve(true));
  expect(vi.spyOn(deps.terminals, "create")).toHaveBeenCalledOnce();
});

test.each(["sidebar", "dialog", "agent-ipc"] as const)(
  "%s warns only for another live agent, supports cancellation and allows shells",
  async (entry) => {
    const workspace = new Workspace(deps);
    const confirm = vi.fn(() => Promise.resolve(false));
    vi.spyOn(deps.terminals, "create")
      .mockResolvedValueOnce("s1")
      .mockResolvedValueOnce("s2")
      .mockResolvedValueOnce("s3");
    await workspace.startWorktree(start, confirm);
    await workspace.sidebarCommand(
      { kind: "launch", repository: repo.path, worktree: tree.path, run: "shell" },
      confirm,
    );
    expect(confirm).not.toHaveBeenCalled();
    let next = 0;
    agents.launch.mockImplementation(() =>
      Promise.resolve({
        id: `a${String(++next)}`,
        attention: "hooks",
      }),
    );
    const launch = () =>
      entry === "sidebar"
        ? workspace.sidebarCommand(
            { kind: "launch", repository: repo.path, worktree: tree.path, run: "claude" },
            confirm,
          )
        : entry === "dialog"
          ? workspace.startWorktree({ ...start, run: "claude" }, confirm)
          : workspace.launch(
              { agent: "claude", repository: repo.path, worktree: tree.path, cols: 80, rows: 24 },
              confirm,
            );
    await launch();
    expect(confirm).not.toHaveBeenCalled();
    await launch();
    expect(confirm).toHaveBeenCalledWith(
      "Run another agent in this checkout?",
      expect.stringContaining("same files"),
    );
    expect(agents.launch).toHaveBeenCalledTimes(1);
    confirm.mockResolvedValue(true);
    await launch();
    expect(agents.launch).toHaveBeenCalledTimes(2);
    expect(agents.launch).toHaveBeenLastCalledWith(
      expect.objectContaining({ sharedCheckout: true }),
    );
    confirm.mockClear();
    await workspace.sidebarCommand(
      { kind: "launch", repository: repo.path, worktree: tree.path, run: "shell" },
      confirm,
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(workspace.snapshot().terminals).toHaveLength(5);
    tails.set("a1", []);
    tails.set("a2", []);
    await workspace.exited("a1", 0);
    await workspace.exited("a2", 0);
    await launch();
    expect(confirm).not.toHaveBeenCalled();
    expect(agents.launch).toHaveBeenCalledTimes(3);
  },
);

test("simultaneous legacy launches cannot bypass the active-agent warning", async () => {
  const workspace = new Workspace(deps);
  const pending = Promise.withResolvers<Launched>();
  agents.launch.mockReturnValueOnce(pending.promise);
  const request = {
    agent: "claude",
    repository: repo.path,
    worktree: tree.path,
    cols: 80,
    rows: 24,
  } as const;
  const first = workspace.launch(request);
  await vi.waitFor(() => {
    expect(agents.launch).toHaveBeenCalledOnce();
  });
  await expect(workspace.launch(request)).rejects.toThrow("busy");
  pending.resolve({ id: "a1", attention: "hooks" });
  await first;
  expect(await workspace.launch(request)).toBeNull();
  expect(agents.launch).toHaveBeenCalledOnce();
  expect(await workspace.startWorktree({ ...start, run: "claude" })).toBeNull();
});

test("removing a shared worktree stops every session before the final status check and removal", async () => {
  const workspace = new Workspace(deps);
  vi.spyOn(deps.terminals, "create").mockResolvedValueOnce("s1").mockResolvedValueOnce("s2");
  await workspace.startWorktree(start);
  await workspace.startWorktree(start);
  agents.launch.mockResolvedValueOnce({ id: "a1", attention: "hooks" });
  await workspace.startWorktree({ ...start, run: "claude" });
  const stopped: string[] = [];
  vi.spyOn(deps.terminals, "stop").mockImplementation((id) => {
    stopped.push(id);
    return Promise.resolve();
  });
  for (const id of ["s1", "s2", "a1"]) tails.set(id, []);
  vi.mocked(deps.worktrees.changes)
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce("")
    .mockImplementation(() => {
      expect(stopped).toEqual(["s1", "s2", "a1"]);
      return Promise.resolve("");
    });
  await workspace.removeWorktree("s1", () => Promise.resolve(true));
  expect(vi.spyOn(deps.terminals, "kill").mock.calls.map(([id]) => id)).toEqual(["s1", "s2", "a1"]);
  expect(workspace.snapshot().terminals).toEqual([]);
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
  workspace.shellState("t1", { phase: "running" });
  expect(states.at(-1)).toMatchObject({ state: "done", signal: "process:exit" });
});

test.each(["finish", "output", "prompt", "reject"])(
  "slow evaluation shows Checking and survives %s",
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
    expect(states.at(-1)?.state).toBe("checking");
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
      action === "finish" ? "needs_input" : action === "prompt" ? "quiet_ok" : "working",
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
    signal: "claude:PermissionRequest",
  });
  workspace.shellState("t1", { phase: "running" });
  workspace.shellState("t1", { phase: "prompt", exitCode: 0 });
  expect(states.at(-1)?.state).toBe("needs_input");
});

test.each(["output", "input", "removed"] as const)(
  "no Checking or verdict after %s invalidates an evaluation",
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

test("snapshots bypass policy per launch and never accepts defaults from a renderer request", async () => {
  const workspace = new Workspace(deps);
  const config = { hooks: true, agents: { claude: true, codex: true, agy: true } };
  workspace.configure({
    ...config,
    agentArguments: { claude: ["--dangerously-skip-permissions"], codex: [], agy: [] },
  });
  const request = {
    agent: "claude" as const,
    repository: repo.path,
    worktree: tree.path,
    cols: 80,
    rows: 24,
    defaultArguments: ["--settings", "hostile"],
  };
  await workspace.launch(request);
  expect(agents.launch).toHaveBeenLastCalledWith(
    expect.objectContaining({ defaultArguments: ["--dangerously-skip-permissions"] }),
  );
  workspace.configure(config);
  expect(workspace.snapshot().terminals[0]?.bypass).toBe(true);
  await workspace.exited("t1", 0);
  agents.launch.mockResolvedValueOnce({ id: "t2", attention: "hooks" });
  await workspace.launch(request);
  expect(agents.launch).toHaveBeenLastCalledWith(expect.objectContaining({ defaultArguments: [] }));
  expect(workspace.snapshot().terminals.find(({ id }) => id === "t2")?.bypass).toBe(false);
  await workspace.dispose();
});

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
