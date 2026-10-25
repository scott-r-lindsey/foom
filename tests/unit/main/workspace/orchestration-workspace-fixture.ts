import { agentProvider } from "../../../../src/main/agents/providers/registry";
import { afterEach, beforeEach, vi } from "vitest";
import { Workspace } from "../../../../src/main/workspace/workspace";
import type { WorkspaceDependencies } from "../../../../src/main/workspace/workspace-types";
import type { Principal } from "../../../../src/main/control/types";
import type { ControlRuntime } from "../../../../src/main/control/runtime";
import type { AgentLaunch, AgentScan } from "../../../../src/shared/agents";
import type { WorkspaceConfirmation } from "../../../../src/shared/confirmation";
import type { VerdictRecord } from "../../../../src/shared/evaluator";
import { worktreeFake } from "./worktree-fake";

export const repo = { path: "/repos/app", name: "app" };
export const main = {
  path: repo.path,
  head: "abc",
  bare: false,
  branch: "main",
  locked: false,
  prunable: false,
  managed: false,
};
export const child = { ...main, path: "/trees/app/feature", branch: "feature", managed: true };
export const scan = (mcp: boolean): AgentScan => ({
  path: "/login/bin",
  warning: null,
  agents: [
    { id: "claude", path: "/bin/claude", version: "2.1.293", hooks: false, mcp, reason: "ok" },
  ],
});

export let deps: WorkspaceDependencies;
export let launch: ReturnType<
  typeof vi.fn<(request: AgentLaunch) => Promise<{ id: string; attention: "evaluator" }>>
>;
export const scans: { current: AgentScan } = { current: scan(true) };
export let stop: ReturnType<typeof vi.fn<(id: string) => Promise<boolean>>>;
export let tail: ReturnType<typeof vi.fn<(id: string, lines: number) => Promise<string[]>>>;
export let confirm: ReturnType<typeof vi.fn<(request: WorkspaceConfirmation) => Promise<boolean>>>;
export let setRole: ReturnType<typeof vi.fn<ControlRuntime["setRole"]>>;

beforeEach(() => {
  agentProvider("codex").discover("/bin/codex", "codex-cli 0.161.0", "-c");
  scans.current = scan(true);
  launch = vi.fn((_request: AgentLaunch) =>
    Promise.resolve({ id: "parent", attention: "evaluator" as const }),
  );
  stop = vi.fn((_id: string) => Promise.resolve(true));
  tail = vi.fn((_id: string, _lines: number) => Promise.resolve(["done"]));
  confirm = vi.fn((_request: WorkspaceConfirmation) => Promise.resolve(true));
  setRole = vi.fn<ControlRuntime["setRole"]>();
  deps = {
    control: () =>
      Promise.resolve({
        prepare: vi.fn<ControlRuntime["prepare"]>(),
        close: vi.fn(async () => {}),
        setRole,
      }),
    worktrees: worktreeFake(repo, child, {
      listWorktrees: vi.fn(() => Promise.resolve([main, child])),
    }),
    terminals: {
      stop,
      kill: vi.fn(async () => {}),
      create: vi.fn(() => Promise.resolve("shell")),
      tail,
    },
    verdicts: {
      forget: vi.fn(),
      classify: vi.fn(() => Promise.reject<VerdictRecord>(new Error("no evaluator"))),
      commit: vi.fn(async () => {}),
      recordAction: vi.fn(async () => {}),
    },
    receiver: vi.fn(() => Promise.reject(new Error("no hooks"))),
    onState: vi.fn(),
    onChange: vi.fn(),
    reveal: vi.fn(),
    placeChild: vi.fn(),
    dialog: vi.fn(() => Promise.resolve(true)),
    agents: () => ({
      scan: vi.fn(() => Promise.resolve(scans.current)),
      launch,
      release: vi.fn(),
      dispose: vi.fn(),
      setHooksEnabled: vi.fn(),
      setBypassIdentities: vi.fn(),
    }),
    now: () => 1000,
  };
});

export const make = (workspace: Workspace, id = "parent") =>
  workspace.sidebarCommand({ kind: "make-orchestrator", id }, confirm);
/** An ordinary agent in the main checkout, then elevated from its session menu. */
export const orchestrate = async (workspace: Workspace) => {
  await workspace.sidebarCommand(
    { kind: "launch", repository: repo.path, worktree: repo.path, run: "claude" },
    confirm,
  );
  await make(workspace);
};

export function principal(): Principal {
  return Object.freeze({
    grantedAt: "2026-10-15T00:00:00.000Z",
    generation: "generation",
    sessionId: "session",
    repository: repo.path,
    worktree: repo.path,
    terminalId: "parent",
    parentId: null,
    role: "orchestrator" as const,
  });
}

const workspaces = new Set<Workspace>();
export function createWorkspace(dependencies: WorkspaceDependencies = deps): Workspace {
  const workspace = new Workspace(dependencies);
  workspaces.add(workspace);
  return workspace;
}

afterEach(async () => {
  try {
    await Promise.all([...workspaces].map((workspace) => workspace.dispose()));
  } finally {
    workspaces.clear();
    vi.restoreAllMocks();
  }
});
