import { DEFAULT_SETTINGS } from "../../../src/main/setup/settings";
import { interfaceThemes } from "../../../src/shared/interface-themes";
import { resolveTerminalTheme } from "../../../src/shared/terminal-themes";
import type { DialogRequest } from "../../../src/shared/confirmation";
import type { SetupState } from "../../../src/shared/setup";
import type {
  WorkspaceSnapshot,
  SidebarInventory,
  AgentReport,
} from "../../../src/shared/workspace";

export const requestId = (n = 0) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const previewId = (n = 0) => n.toString(16).padStart(32, "0");
export const theme = {
  ...interfaceThemes["eclipse-dark"],
  version: 2 as const,
  areas: { dialogs: { bg: "#000000" } },
  states: { focus: "#ffffff" },
  shape: { radius: 4, "panel-radius": 8, border: 1, shadow: 0.5 },
};
export const themes = {
  interface: [{ id: "user:custom.json" as const, theme }],
  terminal: [
    {
      id: "user:custom.json" as const,
      name: "Custom",
      theme: resolveTerminalTheme("dracula", true),
    },
  ],
  errors: [
    {
      file: "custom.json",
      path: "$.colors",
      reason: "contrast" as const,
      severity: "warning" as const,
      kind: "theme" as const,
      detail: "Contrast",
    },
  ],
};
export const setup: SetupState = {
  settings: {
    ...DEFAULT_SETTINGS,
    agentHooks: { custom: true },
    showPullRequests: true,
    interfaceTheme: theme,
    terminalTheme: themes.terminal[0]?.theme ?? "follow",
  },
  themes,
  updates: { status: "downloaded", runningAgents: 2 },
  worktreeRoot: "/worktrees",
};
export const config = {
  folder: "/config",
  available: true,
  pending: { id: "digest", action: "turn off hooks", file: "settings.json", detail: "Hooks" },
  rejected: [{ file: "invalid.json", reason: "invalid-value" }],
  error: "Unavailable",
  agentPlugins: [
    {
      id: "custom",
      name: "Custom",
      mark: "C",
      command: "custom",
      file: "custom.json",
      state: "rejected",
      reason: "Invalid",
    },
  ],
  forgePlugins: [
    {
      id: "forge",
      name: "Forge",
      badge: "F",
      executables: ["forge"],
      file: "forge.json",
      reason: "Invalid",
    },
  ],
};
export const repository = { path: "/repo", name: "Repo" };
export const worktree = {
  path: "/worktrees/feature",
  head: "abc",
  bare: false,
  branch: "feature",
  locked: false,
  prunable: false,
  managed: true,
  pullRequest: {
    number: 780,
    state: "OPEN" as const,
    requestLabel: "Merge request" as const,
    numberPrefix: "!" as const,
    title: "Feature",
    url: "https://example.com/pr/780",
    sourceName: "Forge",
    checksMeaning: "required" as const,
    requiredChecks: "success" as const,
    checks: { passed: 1, failed: 0, pending: 0 },
  },
};
export const execution = {
  terminalId: "one",
  launch: 1,
  revision: 2,
  turn: 1,
  phase: "working" as const,
};
export const state = {
  id: "one",
  verdictId: "verdict",
  state: "working" as const,
  reason: "Working",
  signal: "hook",
  confidence: 1,
  timestamp: 1,
  waitingOn: 0,
  outputRevision: 0,
  inputRevision: 0,
  execution,
  attentionKind: "question" as const,
};
export const cleanup = {
  id: "cleanup",
  total: 1,
  done: 0,
  phase: "remove" as const,
  stopped: false,
  items: [
    {
      id: "item",
      path: "/worktrees/feature",
      branch: "feature",
      state: "kept" as const,
      reason: "uncommitted changes" as const,
      changes: "?? new\0",
      omittedChanges: 0,
    },
  ],
};
export const workspace: WorkspaceSnapshot = {
  repositories: [repository],
  terminals: [
    {
      id: "one",
      kind: "agent",
      agent: "codex",
      repository: "/repo",
      worktree: "/worktrees/feature",
      branch: "feature",
      attention: "hooks",
      state,
      foregroundProgram: "codex",
      outputRevision: 0,
      inputRevision: 0,
      mcpConnection: "connected",
      execution,
      attentionKind: "question",
      providerOrigin: "bundled",
      exited: false,
      conversationId: "conversation",
      dormant: false,
      launchVersion: 1,
      bypass: false,
      home: false,
      config: false,
      probe: false,
      probeOwner: "owner",
      probeNote: false,
      startedAt: 1,
      exitCode: 0,
      launchFlags: ["--flag"],
      environment: ["HTTPS_PROXY"],
      roleNotRestored: false,
      orchestration: {
        role: "orchestrator",
        active: true,
        children: 1,
        history: [
          { id: "operation", action: "launch", label: "Launch", status: "succeeded", at: 1 },
        ],
      },
      handoff: {
        seq: 1,
        status: "done",
        summary: "Complete",
        links: ["https://example.com"],
        timestamp: "2026-10-23T00:00:00Z",
        review: {
          verdict: "findings",
          findings: [{ file: "file.ts", line: 1, summary: "Finding", scenario: "Scenario" }],
        },
      },
      review: {
        rounds: 3,
        agent: "claude",
        postFindings: true,
        parentWaitMinutes: 180,
        authorId: "one",
        round: 1,
        phase: "building",
        reason: "restored",
        waiting: false,
      },
    },
  ],
};
export const sidebar: SidebarInventory = {
  shell: "bash",
  repositories: [
    {
      ...repository,
      worktrees: [worktree],
      cleanup,
      canDeleteMerged: true,
      mergedCount: 1,
      mergedError: "Unavailable",
    },
  ],
  home: { directory: "/home/fixture", path: "/bin/bash", version: "1" },
  previews: [
    {
      id: previewId(),
      network: false,
      repository: "/repo",
      worktree: "/worktrees/feature",
      relativePath: "index.html",
      kind: "html",
      openedBy: { terminalId: "one", agent: "codex" },
    },
  ],
  previewActions: [{ id: "action", terminalId: "one", path: "index.html", at: 1 }],
};
export const agents: AgentReport = {
  warning: "Warning",
  agents: [
    {
      id: "codex",
      name: "Codex",
      mark: "C",
      command: "codex",
      path: "/fixture/codex",
      version: "1",
      hooks: true,
      attentionSignal: true,
      resume: true,
      resumePaste: [{ command: "resume", selector: "id" }],
      restoreControl: true,
      source: "bundled",
      bypassArguments: ["--flag"],
      setup: { state: "installed", offer: "Update", actions: [{ id: "update", label: "Update" }] },
      agyPlugin: { state: "installed", version: 1 },
      inline: true,
      cliGuidance: true,
      mcp: true,
      mcpReason: "Ready",
      healthSupported: true,
      notifierReplacement: true,
      healthInstructions: "Ready",
      hookState: "trusted",
      reason: "Ready",
    },
  ],
};
export const environment = {
  lists: {
    all: [{ name: "HTTPS_PROXY", secret: true, value: null }],
    claude: [],
    codex: [{ name: "NO_PROXY", secret: false, value: "localhost" }],
    agy: [],
    custom: [{ name: "SSL_CERT_FILE", secret: false, value: "/cert" }],
  },
  windows: false,
  secrets: true,
};
export const scan = {
  folder: "/code",
  repositories: [
    {
      path: "/code/app",
      name: "App",
      relative: "app",
      branch: "main",
      lastActive: 1,
      recent: true,
      added: true,
    },
  ],
  folders: 1,
  truncated: false,
};
export const command = {
  id: "settings",
  label: "Settings",
  shortcut: "Ctrl+,",
  enabled: true,
  checked: true,
  badge: "C",
};
export const dialog: DialogRequest = {
  presented: true,
  id: "one",
  theme,
  title: "Confirm",
  accept: "Continue",
  cancel: "Not now",
  detail: "Detail",
  quiet: "Quiet",
  subject: "Subject",
  glyph: "shield",
  note: "Note",
  reply: { context: "Context", text: "Reply" },
  removals: [
    {
      id: "item",
      branch: "feature",
      path: "/worktrees/feature",
      changes: "?? file\0",
      pullRequest: { number: 780, state: "MERGED" },
    },
  ],
  cleanup: {
    stage: "ready",
    checkingCount: 1,
    fetchedAt: 1,
    error: "fetch failed",
    progress: {
      ...cleanup,
      items: cleanup.items.map((item) => ({
        id: item.id,
        branch: item.branch,
        state: item.state,
        reason: item.reason,
        changes: item.changes,
        omittedChanges: item.omittedChanges,
      })),
    },
  },
  sections: [
    {
      label: "Section",
      items: ["Literal\ntext\0"],
      arguments: true,
      summary: [{ text: "Summary", title: "Full summary" }],
    },
  ],
  facts: [{ label: "Fact", value: "Value", mono: true }],
  arguments: ["--flag"],
  pairing: { code: "ABCD1234", expiresAt: 1 },
  worktrees: [{ branch: "feature", reason: "Dirty" }],
  changes: "?? file\0",
  sessions: [{ id: "one", name: "Codex", location: "/repo", state: "working" }],
};
export const replies: Record<string, unknown> = {
  "workspace:snapshot": workspace,
  "workspace:add-repository": repository,
  "workspace:worktrees": [worktree],
  "workspace:branches": {
    head: "main",
    local: [{ name: "main", worktree: "/repo" }],
    remote: "origin",
    remoteBranches: ["main"],
  },
  "workspace:create-worktree": { ...worktree, outcome: "new" },
  "workspace:sidebar": sidebar,
  "workspace:start": "one",
  "workspace:remove": true,
  "workspace:panel-facts": {
    changes: 1,
    upstream: { ahead: 1, behind: 0 },
    commit: { hash: "abc", subject: "Commit", timestamp: 1 },
    remote: "origin",
    defaultBranch: "main",
    lastFetch: 1,
    fetchFailed: false,
    merged: true,
  },
  "workspace:action-log": {
    entries: [
      {
        operationId: "operation",
        timestamp: "2026-10-23T00:00:00Z",
        actorId: "one",
        parentId: null,
        repository: "/repo",
        worktree: "/worktrees/feature",
        action: "launch",
        targetId: "one",
        resultId: "two",
        status: "succeeded",
        reason: "Ready",
        path: "/repo",
        session: "one",
        proposal: "Proposal",
        inputHash: "abc",
      },
    ],
    total: 1,
  },
  "agents:scan": agents,
  "agents:setup": agents,
  "agents:agy-plugin": agents,
  "agents:launch": { id: "one", attention: "hooks" },
  "setup:state": setup,
  "setup:save": setup,
  "setup:terminal-fonts": ["Hack Nerd Font Mono"],
  "theme:list": themes,
  "config:status": config,
  "config:decide": config,
  "environment:state": environment,
  "environment:save": environment,
  "environment:remove": environment,
  "environment:import": environment,
  "environment:read-shell": [{ name: "HTTPS_PROXY", display: "http://***@proxy", status: "new" }],
  "setup:scan-code": scan,
  "setup:code-suggestions": [{ path: "/code", repositories: 1, more: false }],
  "setup:apply-repositories": {
    repositories: [repository],
    failures: [{ path: "/code/refused", message: "Refused" }],
  },
  "sound:list": [
    { kind: "done", source: "user", file: "bell.wav", name: "Bell", error: "Unavailable" },
  ],
  "sound:read": { bytes: new Uint8Array([1, 2]) },
  "sound:notices": "Credits",
  "app-menu:list": [
    null,
    { ...command, kind: "command" },
    { kind: "submenu", id: "file", label: "File", items: [null, command] },
    { kind: "size", label: "Size", scale: 100, smaller: command, bigger: command },
  ],
  "app-menu:shortcuts": [
    { title: "Navigation", lead: "Ctrl", rows: [{ label: "Settings", keys: "," }] },
  ],
  "windows:sync": ["one"],
  "windows:select": true,
  "preview:pick": "preview",
};
