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
      changes: vi.fn(() => Promise.resolve("")),
      removeWorktree: vi.fn(async () => {}),
      createWorktree: vi.fn(() => Promise.resolve(tree.path)),
    },
    terminals: {
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
        state: null,
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
  expect(deps.worktrees.createWorktree).toHaveBeenCalledWith(repo.path, "feature", {
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
      reason: "Quiet without decisive evidence",
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

test("launches a shell in a managed worktree and refuses a duplicate live terminal", async () => {
  const workspace = new Workspace(deps);
  expect(await workspace.startWorktree(start)).toBe("t1");
  expect(vi.spyOn(deps.terminals, "create")).toHaveBeenCalledWith(
    expect.objectContaining({ cwd: tree.path, cols: 80, rows: 24 }),
  );
  expect(workspace.snapshot().terminals[0]).toMatchObject({ kind: "shell", branch: "feature" });
  await expect(workspace.startWorktree(start)).rejects.toThrow("already running");
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
  expect(deps.worktrees.createWorktree).toHaveBeenCalledWith(repo.path, "feature", {
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
  expect(deps.worktrees.removeWorktree).not.toHaveBeenCalled();
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
    expect(deps.worktrees.removeWorktree).toHaveBeenCalledWith(
      repo.path,
      tree.path,
      changes.length > 0,
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
