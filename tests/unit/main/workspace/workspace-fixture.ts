import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import * as agentDiscovery from "../../../../src/main/agents/agents";
import { agentProvider } from "../../../../src/main/agents/providers/registry";
import { flushV2Health } from "../../../../src/main/agents/providers/v2-health";
import { evaluateRules } from "../../../../src/main/evaluator/evaluator";
import { Workspace } from "../../../../src/main/workspace/workspace";
import type { WorkspaceDependencies } from "../../../../src/main/workspace/workspace-types";
import type { AgentHooks, AgentId, AgentLaunch, AgentScan } from "../../../../src/shared/agents";
import type { ConfirmWorkspace } from "../../../../src/shared/confirmation";
import type { EvaluationInput, VerdictRecord } from "../../../../src/shared/evaluator";
import type { HookAgent, HookLaunch, HookSignal } from "../../../../src/shared/hooks";
import type { TerminalState } from "../../../../src/shared/workspace";
import type { CreatedWorktree } from "../../../../src/shared/worktrees";

export type Launched = {
  id: string;
  attention: "hooks" | "evaluator";
  environment?: readonly string[];
};

export const repo = { path: "/repos/app", name: "app" };

export const tree = {
  path: "/trees/app/feature",
  head: "abc",
  bare: false,
  branch: "feature",
  locked: false,
  prunable: false,
  managed: true,
};

export const scan: AgentScan = {
  path: "/login/bin",
  warning: null,
  agents: [{ id: "claude", path: "/bin/claude", version: "2.1.285", hooks: true, reason: "ok" }],
};

export let states: TerminalState[];

export let tails: Map<string, string[]>;

export let evaluated: EvaluationInput[];

export let prepare: ((agent: AgentId) => Promise<AgentHooks>) | undefined;

export let agents: {
  scan: ReturnType<typeof vi.fn<() => Promise<AgentScan>>>;
  launch: ReturnType<typeof vi.fn<(request: AgentLaunch) => Promise<Launched>>>;
  release: ReturnType<typeof vi.fn<(id: string) => void>>;
  dispose: ReturnType<typeof vi.fn<() => void>>;
  setHooksEnabled: ReturnType<typeof vi.fn<(enabled: boolean) => void>>;
};

export let deps: WorkspaceDependencies;

export let receiver: {
  register: ReturnType<typeof vi.fn<(key: string, agent: HookAgent) => HookLaunch>>;
  close: ReturnType<typeof vi.fn<() => Promise<void>>>;
};

export let verdictCount: number;

export const recordAction =
  vi.fn<(id: string, verdictId: string, action: string) => Promise<void>>();

export const terminalTail = vi.fn((id: string) => {
  const tail = tails.get(id);
  return tail ? Promise.resolve(tail) : Promise.reject(new Error("gone"));
});

export const classify = vi.fn((input: EvaluationInput): Promise<VerdictRecord> => {
  evaluated.push(input);
  return Promise.resolve({
    id: `v${String(++verdictCount)}`,
    terminalId: input.terminalId,
    timestamp: "now",
    verdict: evaluateRules(input),
  });
});

export const forget = vi.fn<(id: string) => void>();

export const commit = vi.fn<(record: VerdictRecord) => Promise<void>>();

export const startReceiver = vi.fn(() => Promise.resolve(receiver));

beforeEach(async () => {
  vi.spyOn(agentDiscovery, "loginPath").mockResolvedValue({ path: "/login/bin", warning: null });
  agentProvider("codex").discover("/bin/codex", "codex-cli 0.161.0", "-c --no-alt-screen");
  states = [];
  evaluated = [];
  verdictCount = 0;
  tails = new Map([["t1", ["Continue? (y/n)"]]]);
  recordAction.mockReset().mockResolvedValue();
  terminalTail.mockClear();
  classify.mockClear();
  commit.mockReset().mockResolvedValue();
  forget.mockClear();
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
    agentPluginDirectory: await mkdtemp(join(tmpdir(), "foom-health-")),
    worktrees: {
      canAutoRemove: vi.fn(() => Promise.resolve(false)),
      panelFacts: vi.fn(),
      listRepositories: vi.fn(() => [repo]),
      addRepository: vi.fn(() => Promise.resolve(repo)),
      listWorktrees: vi.fn(() => Promise.resolve([tree])),
      validateBranch: vi.fn(async () => {}),
      launchIdentity: vi.fn(() => Promise.resolve("identity")),
      removalIdentity: vi.fn(() => Promise.resolve("identity")),
      cleanupBrokenWorktree: vi.fn(async () => {}),
      cleanupStatus: vi.fn((repository: string, path: string) =>
        deps.worktrees.changes(repository, path),
      ),
      cleanupChanges: vi.fn(() => Promise.reject(new Error("unsafe cleanup"))),
      changes: vi.fn(() => Promise.resolve("")),
      mergedFetchTime: vi.fn(() => 1000),
      mergedDefault: vi.fn(() => Promise.resolve("base")),
      mergedCommit: vi.fn(() => Promise.resolve(false)),
      deleteMergedBranches: vi.fn(() => Promise.resolve([])),
      deleteMergedBranch: vi.fn(async () => {}),
      removeRepository: vi.fn(async () => {}),
      pruneWorktree: vi.fn(async () => {}),
      removeWorktree: vi.fn(async () => {}),
      adoptWorktree: vi.fn(),
      createWorktree: vi.fn(
        (): Promise<CreatedWorktree> => Promise.resolve({ path: tree.path, outcome: "new" }),
      ),
      branches: vi.fn(() =>
        Promise.resolve({ head: "main", local: [], remote: null, remoteBranches: [] }),
      ),
    },
    terminals: {
      stop: vi.fn(() => Promise.resolve(true)),
      kill: vi.fn(async () => {}),
      create: vi.fn(() => Promise.resolve("t1")),
      tail: terminalTail,
    },
    verdicts: {
      forget,
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

afterEach(async () => {
  vi.restoreAllMocks();
  await flushV2Health();
  if (deps.agentPluginDirectory)
    await rm(deps.agentPluginDirectory, { recursive: true, force: true });
});

export async function launched(agent: AgentId = "claude"): Promise<Workspace> {
  if (agent === "agy")
    agents.scan.mockResolvedValue({
      ...scan,
      agents: [{ id: "agy", path: "/bin/agy", version: "1.3.3", hooks: true, reason: "installed" }],
    });
  const workspace = new Workspace(deps);
  await workspace.launch({
    agent,
    repository: repo.path,
    worktree: tree.path,
    cols: 80,
    rows: 24,
  });
  return workspace;
}

export function held<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function bound(agent: AgentId = "claude"): Promise<string> {
  const hooks = await prepare?.(agent);
  for (const channel of agentProvider(agent).model.hooks?.channels ?? [])
    hooks?.v2?.channels.set(channel.id, channel);
  hooks?.bind?.("t1");
  return receiver.register.mock.calls.at(-1)?.[0] ?? "";
}

export const start = {
  repository: repo.path,
  branch: "feature",
  run: "shell" as const,
};

export const launchEntries = [
  "sidebar-shell",
  "sidebar-agent",
  "agent-ipc",
  "worktree-shell",
  "worktree-agent",
  "create-worktree",
] as const;

export function startRepositoryOperation(
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

export function codexSignal(
  signal: string,
  action: HookSignal["action"],
  terminalId: string,
): HookSignal {
  const caseId = signal.slice("codex:".length);
  return {
    terminalId,
    signal: `plugin:codex:${caseId}`,
    action,
    caseId,
    channel: caseId === "agent-turn-complete" ? "notify" : "lifecycle",
    endsTurn: action === "classify" || action === "failed",
  };
}

export async function codexWorkspace() {
  agents.scan.mockResolvedValue({
    ...scan,
    agents: [
      {
        id: "codex",
        path: "/bin/codex",
        version: "codex-cli 0.161.0",
        hooks: true,
        healthSupported: true,
        reason: "ok",
      },
    ],
  });
  const workspace = new Workspace(deps);
  await workspace.launch({
    agent: "codex",
    repository: repo.path,
    worktree: tree.path,
    cols: 80,
    rows: 24,
  });
  const hooks = await prepare?.("codex");
  if (!hooks) throw new Error("Missing hook binding");
  await agentProvider("codex").prepareLaunch(
    agentProvider("codex").discover("/bin/codex", "codex-cli 0.161.0", "-c --no-alt-screen"),
    { agent: "codex", repository: repo.path, worktree: tree.path, cols: 80, rows: 24 },
    [],
    undefined,
    false,
    true,
    hooks,
  );
  hooks.bind?.("t1");
  const key = receiver.register.mock.calls.at(-1)?.[0];
  if (!key) throw new Error("Missing receiver registration");
  return { workspace, hooks, key };
}

export async function cleanupCommand(
  workspace: Workspace,
  command: Parameters<Workspace["sidebarCommand"]>[0],
  confirm: ConfirmWorkspace,
) {
  return workspace.sidebarCommand(command, async (request) => {
    if (request.kind !== "merged-worktrees" || !request.feed) return confirm(request);
    const feed = request.feed;
    await vi.waitFor(() => {
      expect(feed.current().stage).not.toBe("checking");
    });
    return confirm({
      kind: "merged-worktrees",
      worktrees: feed
        .current()
        .progress.items.map(({ branch, reason }) => ({ branch, ...(reason ? { reason } : {}) })),
    });
  });
}

export const configDep = (check = vi.fn(async () => {})) => ({
  root: "/home/.foom/config",
  cliDirectory: "/app/console",
  check,
});

export const pastedResume = {
  kind: "resume-id",
  checkout: { repository: repo.path, worktree: tree.path },
  agent: "claude",
  id: "external-123",
} as const;
