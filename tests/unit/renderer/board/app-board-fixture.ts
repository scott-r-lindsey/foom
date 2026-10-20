import type { ExecutionTransition } from "../../../../src/shared/execution";
// @vitest-environment jsdom
import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import type { BoardCommand } from "../../../../src/shared/board-command";
import type { TerminalActivity } from "../../../../src/shared/desktop";
import type { ConfigStatus } from "../../../../src/shared/foom-config";
import type { SetupState } from "../../../../src/shared/setup";
import type { TerminalState, WorkspaceSnapshot } from "../../../../src/shared/workspace";
import { installation, report, setupState } from "../../../fixtures/setup";
const mock = vi.hoisted(() => ({
  configStatus: vi.fn(() =>
    Promise.resolve({
      folder: "/home/.foom/config",
      available: true,
      pending: null,
      rejected: [],
    } as ConfigStatus),
  ),
  configListener: undefined as ((status: ConfigStatus) => void) | undefined,
  viewAvailable: undefined as ((id: string) => boolean) | undefined,
  viewExited: undefined as ((id: string) => boolean) | undefined,
  execution: undefined as ((event: ExecutionTransition) => void) | undefined,
  command: undefined as ((command: BoardCommand) => void) | undefined,
  state: undefined as ((state: TerminalState) => void) | undefined,
  changed: undefined as (() => void) | undefined,
  exit: undefined as ((id: string, code: number) => void) | undefined,
  availability: undefined as
    | ((id: string, available: boolean, reset?: boolean) => void)
    | undefined,
  activity: undefined as ((batch: TerminalActivity[]) => void) | undefined,
  workspace: vi.fn<() => Promise<WorkspaceSnapshot>>(),
  create: vi.fn<() => Promise<{ id: string; title: string }>>(),
  kill: vi.fn(),
  feedback: vi.fn(),
  tail: vi.fn(),
  branches: vi.fn(() =>
    Promise.resolve({ head: "main", local: [], remote: null, remoteBranches: [] }),
  ),
  createWorktree: vi.fn(() => Promise.resolve({ path: "/r/feature", outcome: "new" })),
  sidebarInventory: vi.fn(() => Promise.resolve({ repositories: [], shell: "bash" })),
  removeWorktree: vi.fn(),
  addRepository: vi.fn(),
  sidebarCommand: vi.fn(),
  off: vi.fn(),
  setupState: vi.fn<() => Promise<SetupState>>(),
  mount: vi.fn(),
  dispose: vi.fn(),
  open: vi.fn(),
  hide: vi.fn(),
  focus: vi.fn(),
}));
vi.mock("../../../../src/renderer/terminal/terminal-view-source", () => ({
  createTerminalView: (
    _schedule: unknown,
    _owners: unknown,
    available: (id: string) => boolean,
    hasExited: (id: string) => boolean,
  ) => {
    mock.viewAvailable = available;
    mock.viewExited = hasExited;
    return {
      mount: (element: HTMLElement) => {
        mock.mount(element);
        return mock.dispose;
      },
      open: mock.open,
      hide: mock.hide,
      focus: mock.focus,
      subscribe: () => () => {},
      getSnapshot: () => terminalView,
    };
  },
}));
export const terminalView = {
  status: "Terminal",
  state: "quiet_ok",
  visible: false,
  toggleLabel: "Open terminal",
  toggleDisabled: true,
  restartDisabled: true,
};
vi.mock("../../../../src/renderer/preflight/scale-preflight", () => ({ scalePreflight: vi.fn() }));
vi.mock("../../../../src/renderer/preflight/center-step", () => ({ centerStep: vi.fn() }));
export const agent = (id: string, state: TerminalState | null = null) => ({
  id,
  kind: "agent" as const,
  agent: "claude" as const,
  repository: "/code/app",
  worktree: `/code/${id}`,
  branch: id,
  attention: "hooks" as const,
  state,
});
export const verdict = (id: string, timestamp = 100): TerminalState => ({
  id,
  state: "needs_input",
  verdictId: `v-${String(timestamp)}`,
  timestamp,
  reason: "Continue?",
  signal: "pattern:confirmation",
  confidence: 1,
});
export async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.useFakeTimers();
  mock.create.mockResolvedValue({ id: "real-id", title: "bash" });
  mock.open.mockResolvedValue(undefined);
  mock.hide.mockResolvedValue(undefined);
  mock.workspace.mockResolvedValue({
    repositories: [{ path: "/code/app", name: "app" }],
    terminals: [],
  });
  mock.setupState.mockResolvedValue(setupState({ setupComplete: true }));
  mock.tail.mockResolvedValue(["real output"]);
  mock.feedback.mockResolvedValue(undefined);
  mock.removeWorktree.mockResolvedValue(true);
  mock.addRepository.mockResolvedValue(null);
  mock.sidebarCommand.mockResolvedValue(undefined);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  });
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      sounds: {
        list: () => Promise.resolve([]),
        read: () => Promise.resolve({ error: "unavailable" }),
        onChange: () => () => {},
        openFolder: async () => {},
        notices: () => Promise.resolve(""),
      },
      setupState: mock.setupState,
      environmentState: () =>
        Promise.resolve({
          lists: { all: [], claude: [], codex: [], agy: [] },
          windows: false,
          secrets: true,
        }),
      onSetupChange: () => () => {},
      configStatus: mock.configStatus,
      decideConfig: mock.configStatus,
      revertConfig: mock.configStatus,
      openConfigFolder: async () => {},
      onConfigChange: (listener: (status: ConfigStatus) => void) => {
        mock.configListener = listener;
        return () => {
          mock.configListener = undefined;
        };
      },
      codeSuggestions: () => Promise.resolve([]),
      saveSetup: (patch: Partial<SetupState["settings"]>) =>
        Promise.resolve(setupState({ ...patch, setupComplete: true })),
      scanAgents: () =>
        Promise.resolve(report(installation("claude"), installation("codex"), installation("agy"))),
      sidebarInventory: mock.sidebarInventory,
      sidebarCommand: mock.sidebarCommand,
      workspace: mock.workspace,
      create: mock.create,
      kill: mock.kill,
      feedback: mock.feedback,
      tail: mock.tail,
      branches: mock.branches,
      createWorktree: mock.createWorktree,
      removeWorktree: mock.removeWorktree,
      addRepository: mock.addRepository,
      onBoardCommand: (listener: (command: BoardCommand) => void) => {
        mock.command = listener;
        return () => {
          mock.command = undefined;
        };
      },
      onWorkspaceChange: (listener: () => void) => {
        mock.changed = listener;
        return mock.off;
      },
      onTerminalAvailability: (
        listener: (id: string, available: boolean, reset?: boolean) => void,
      ) => {
        mock.availability = listener;
        return mock.off;
      },
      onExecution: (listener: (event: ExecutionTransition) => void) => {
        mock.execution = listener;
        return mock.off;
      },
      onState: (listener: (state: TerminalState) => void) => {
        mock.state = listener;
        return mock.off;
      },
      onExit: (listener: (id: string, code: number) => void) => {
        mock.exit = listener;
        return mock.off;
      },
      onActivity: (listener: (batch: TerminalActivity[]) => void) => {
        mock.activity = listener;
        return mock.off;
      },
    },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

export { mock };
