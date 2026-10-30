import type {
  HostsState,
  HostResult,
  HostFacts,
  RegisteredHost,
} from "../shared/registered-hosts.d";
import type {
  CodeScan,
  CodeSuggestion,
  FoundRepository,
  RepositoryUpdate,
  Settings,
  SetupState,
} from "../shared/setup";
import type { UpdateState } from "../shared/updates";
import type { ThemeCatalog, ThemeKind, ThemeReason } from "../shared/theme-file";
import type { InterfaceTheme, InterfaceThemeChoice } from "../shared/interface-theme";
import type { TerminalTheme, TerminalThemeChoice } from "../shared/terminal-theme";
import type {
  SoundChoice,
  SoundChoices,
  SoundEntry,
  SoundKind,
  SoundRead,
  SoundSettings,
} from "../shared/sound";
import type {
  ConfigAgent,
  ConfigForge,
  ConfigPending,
  ConfigRejection,
  ConfigStatus,
} from "../shared/foom-config";
import type {
  AgentReport,
  OrchestrationEntry,
  OrchestrationView,
  PreviewSummary,
  SidebarInventory,
  TerminalState,
  WorkspaceSnapshot,
  WorkspaceTerminal,
} from "../shared/workspace";
import type { BranchInventory, Repository, Worktree } from "../shared/worktrees";
import type { ExecutionPhase, ExecutionSnapshot, ExecutionTransition } from "../shared/execution";
import type { AttentionKind, VerdictState } from "../shared/evaluator";
import type { Handoff } from "../shared/handoff";
import type { ReviewFinding, ReviewReason, ReviewState, ReviewVerdict } from "../shared/review";
import type { PreviewOpenAction, PreviewPlacement, PreviewSnapshot } from "../shared/previews";
import type { BoardPullRequest } from "../shared/forge";
import type { CleanupItem, CleanupProgress, CleanupReason } from "../shared/cleanup";
import type { GitPanelFacts, HomeShellFacts } from "../shared/panel";
import type { AgentInstallation, AgentLaunched, HookHealthState } from "../shared/agents";
import type { AgentSetupState, AgentSetupStatus } from "../shared/agent-setup";
import type { AgyPluginStatus } from "../shared/agy-plugin";
import type { ActionLogEntry, ActionLogPage } from "../shared/action-log";
import type { EnvironmentCandidate, EnvironmentRow, EnvironmentState } from "../shared/environment";
import type { AppMenuEntry, CommandItem, ShortcutGroup, ShortcutRow } from "../shared/app-menu";
import type { ReadinessReport } from "../shared/readiness";
import type { WindowAudioState, WindowView } from "../shared/windows";
import type { IpcRendererEvent } from "electron";
import type { DesktopApi, TerminalActivity } from "../shared/desktop";
import { isBoardCommand } from "../shared/board-commands";
import { contextBridge, ipcRenderer } from "electron";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
// Keep these checks inline: the sandboxed loader can require only Electron.
type Validator<T> = (value: unknown) => value is T;
// Composite validators also describe the fields that may cross the bridge.
const copies = new WeakMap<Validator<unknown>, (value: unknown) => unknown>();
function copying<T>(check: Validator<T>, copy: (value: unknown) => unknown): Validator<T> {
  copies.set(check, copy);
  return check;
}
function project(check: Validator<unknown>, value: unknown): unknown {
  const copy = copies.get(check);
  // An unregistered object validator must never forward its input unchanged.
  return copy ? copy(value) : value !== null && typeof value === "object" ? undefined : value;
}
const text: Validator<string> = (value): value is string => typeof value === "string";
const finite: Validator<number> = (value): value is number =>
  typeof value === "number" && Number.isFinite(value);
const boolean: Validator<boolean> = (value): value is boolean => typeof value === "boolean";
const absent: Validator<undefined> = (value): value is undefined => value === undefined;
const nil: Validator<null> = (value): value is null => value === null;
function literal<const T extends readonly (string | number | boolean | null | undefined)[]>(
  ...values: T
): Validator<T[number]> {
  return (value): value is T[number] => values.some((entry) => entry === value);
}
function either<T extends readonly Validator<unknown>[]>(
  ...checks: T
): Validator<T[number] extends Validator<infer U> ? U : never> {
  return copying(
    (value): value is T[number] extends Validator<infer U> ? U : never =>
      checks.some((check) => check(value)),
    (value) => {
      const check = checks.find((candidate) => candidate(value));
      return check ? project(check, value) : undefined;
    },
  );
}
function array<T>(check: Validator<T>): Validator<T[]> {
  return copying(
    (value): value is T[] =>
      Array.isArray(value) && Array.from(value).every((entry: unknown) => check(entry)),
    (value) =>
      Array.isArray(value)
        ? Array.from(value, (entry: unknown) => project(check, entry))
        : undefined,
  );
}
function dictionary<T>(check: Validator<T>): Validator<Record<string, T>> {
  return copying(
    (value): value is Record<string, T> => object(value) && Object.values(value).every(check),
    (value) =>
      object(value)
        ? Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [key, project(check, entry)]),
          )
        : undefined,
  );
}
// Require validators for optional fields too, so contract additions cannot be silently skipped.
type Contract<T> = { [K in keyof T]-?: Validator<T[K]> };
type Checked<T> = T extends Validator<infer U> ? U : never;
type Fields<T> = {
  [K in keyof T as undefined extends Checked<T[K]> ? never : K]: Checked<T[K]>;
} & {
  [K in keyof T as undefined extends Checked<T[K]> ? K : never]?: Exclude<Checked<T[K]>, undefined>;
};
function shape<T extends Record<string, Validator<unknown>>>(fields: T): Validator<Fields<T>> {
  return copying(
    (value): value is Fields<T> =>
      object(value) && Object.entries(fields).every(([key, check]) => check(value[key])),
    (value) =>
      object(value)
        ? Object.fromEntries(
            Object.entries(fields)
              .filter(([key]) => Object.hasOwn(value, key))
              .map(([key, check]) => [key, project(check, value[key])]),
          )
        : undefined,
  );
}
function both<A, B>(first: Validator<A>, second: Validator<B>): Validator<A & B> {
  return copying(
    (value): value is A & B => first(value) && second(value),
    (value) => {
      const left = project(first, value);
      const right = project(second, value);
      return object(left) && object(right)
        ? Object.fromEntries([...Object.entries(left), ...Object.entries(right)])
        : undefined;
    },
  );
}
const userThemeId: Validator<`user:${string}`> = (value): value is `user:${string}` =>
  typeof value === "string" && /^user:.+$/u.test(value);

const bytes: Validator<Uint8Array> = copying(
  (value): value is Uint8Array =>
    value instanceof Uint8Array && value.byteLength <= 8 * 1024 * 1024,
  (value) => (value instanceof Uint8Array ? Uint8Array.from(value) : undefined),
);
const count: Validator<number> = (value): value is number =>
  finite(value) && Number.isSafeInteger(value) && value >= 0;
const positiveCount: Validator<number> = (value): value is number => count(value) && value > 0;
const nonempty: Validator<string> = (value): value is string => text(value) && value.length > 0;
const color: Validator<string> = (value): value is string =>
  text(value) && /^#[a-f0-9]{6}$/iu.test(value);
function range(min: number, max: number, integer = false): Validator<number> {
  return (value): value is number =>
    finite(value) && value >= min && value <= max && (!integer || Number.isSafeInteger(value));
}
function partial<T extends Record<string, Validator<unknown>>>(
  fields: T,
): Validator<Partial<Fields<T>>> {
  return copying(
    (value): value is Partial<Fields<T>> =>
      object(value) &&
      Object.entries(fields).every(([key, check]) => value[key] === undefined || check(value[key])),
    (value) =>
      object(value)
        ? Object.fromEntries(
            Object.entries(fields)
              .filter(([key]) => Object.hasOwn(value, key))
              .map(([key, check]) => [key, project(check, value[key])]),
          )
        : undefined,
  );
}
const validUpdateState: Validator<UpdateState> = shape({
  status: literal("idle", "checking", "available", "downloaded", "error"),
  runningAgents: count,
} satisfies Contract<UpdateState>);

const interfaceColorFields = {
  bg: color,
  surface: color,
  line: color,
  ink: color,
  muted: color,
  accent: color,
  "accent-deep": color,
  attention: color,
  "attention-ink": color,
  done: color,
  "done-ink": color,
  failed: color,
  "failed-ink": color,
  hole: color,
  "space-ink": color,
  "badge-label-fill": color,
  "badge-label-ink": color,
  "badge-fill": color,
  "badge-ink": color,
  highlight: either(absent, color),
  "highlight-deep": either(absent, color),
};
const validInterfaceTheme: Validator<InterfaceTheme> = shape({
  version: literal(1, 2),
  name: text,
  base: literal("light", "dark"),
  colors: shape(interfaceColorFields),
  areas: either(
    absent,
    shape({
      sidebar: either(absent, partial(interfaceColorFields)),
      tiles: either(absent, partial(interfaceColorFields)),
      panels: either(absent, partial(interfaceColorFields)),
      dialogs: either(absent, partial(interfaceColorFields)),
      menus: either(absent, partial(interfaceColorFields)),
    }),
  ),
  states: either(
    absent,
    partial({ selected: color, hover: color, focus: color, scrollbar: color }),
  ),
  shape: either(
    absent,
    partial({
      radius: range(0, 12),
      "panel-radius": range(0, 16),
      border: range(0, 2),
      shadow: range(0, 1),
    }),
  ),
} satisfies Contract<InterfaceTheme>);

const validTerminalTheme: Validator<TerminalTheme> = shape({
  foreground: color,
  background: color,
  cursor: color,
  selectionBackground: color,
  black: color,
  red: color,
  green: color,
  yellow: color,
  blue: color,
  magenta: color,
  cyan: color,
  white: color,
  brightBlack: color,
  brightRed: color,
  brightGreen: color,
  brightYellow: color,
  brightBlue: color,
  brightMagenta: color,
  brightCyan: color,
  brightWhite: color,
} satisfies Contract<TerminalTheme>);

const validThemeReason: Validator<ThemeReason> = literal(
  "malformed-json",
  "unknown-key",
  "missing-key",
  "not-a-color",
  "attention-distinctness",
  "color-distance",
  "base-luminance",
  "hole-color",
  "contrast",
  "reserved-color",
  "too-large",
  "unsafe-file",
  "too-many-files",
  "invalid-value",
  "unreadable",
);

const validThemeKind: Validator<ThemeKind> = literal("theme", "terminal-theme");

const validThemeCatalog: Validator<ThemeCatalog> = shape({
  interface: array(
    shape({
      id: userThemeId,
      theme: validInterfaceTheme,
    }),
  ),
  terminal: array(
    shape({
      id: userThemeId,
      name: text,
      theme: validTerminalTheme,
    }),
  ),
  errors: array(
    shape({
      severity: either(absent, literal("error", "warning")),
      file: text,
      path: text,
      reason: validThemeReason,
      detail: either(absent, text),
      kind: validThemeKind,
    }),
  ),
} satisfies Contract<ThemeCatalog>);

const validInterfaceThemeChoice: Validator<InterfaceThemeChoice> = either(
  userThemeId,
  validInterfaceTheme,
  literal("follow"),
  literal("eclipse-light"),
  literal("eclipse-dark"),
  literal("high-contrast"),
  literal("deep-field"),
  literal("moonlight"),
  literal("graphite"),
  literal("midnight-indigo"),
);

const validTerminalThemeChoice: Validator<TerminalThemeChoice> = either(
  userThemeId,
  validTerminalTheme,
  literal("follow"),
  literal("foom-dark"),
  literal("foom-light"),
  literal("solarized-dark"),
  literal("solarized-light"),
  literal("dracula"),
);

const validSoundChoice: Validator<SoundChoice> = shape({
  source: literal("builtin", "user"),
  file: text,
} satisfies Contract<SoundChoice>);

const validSoundChoices: Validator<SoundChoices> = shape({
  done: validSoundChoice,
  working: validSoundChoice,
  "needs-you": validSoundChoice,
  refusal: validSoundChoice,
} satisfies Contract<SoundChoices>);

const validSoundSettings: Validator<SoundSettings> = shape({
  choices: validSoundChoices,
  volume: range(0, 1),
  muted: boolean,
  working: boolean,
  workingVolume: range(0, 1),
  alerts: boolean,
  alertVolume: range(0, 1),
} satisfies Contract<SoundSettings>);

const hostAlias: Validator<string> = (value): value is string =>
  typeof value === "string" &&
  value.length <= 253 &&
  !/\p{Cc}/u.test(value) &&
  /^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}@)?[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(value);
const hostFolder: Validator<string> = (value): value is string =>
  typeof value === "string" &&
  value.length <= 4096 &&
  value.startsWith("/") &&
  !/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(value) &&
  !value.split("/").some((part) => part === "." || part === "..");
const hostVersion: Validator<string> = (value): value is string =>
  typeof value === "string" &&
  !/\p{Cc}/u.test(value) &&
  /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/u.test(value) &&
  value.length <= 128;
const hostAgentId: Validator<string> = (value): value is string =>
  typeof value === "string" && !/\p{Cc}/u.test(value) && /^[a-z][a-z0-9-]{0,63}$/u.test(value);
const validRegisteredHost: Validator<RegisteredHost> = shape({
  host: hostAlias,
  codeFolder: hostFolder,
} satisfies Contract<RegisteredHost>);
const hostFactsShape = shape({
  codeFolder: hostFolder,
  version: hostVersion,
  sessions: count,
  cores: count,
  load: array(range(0, Number.MAX_SAFE_INTEGER)),
  memoryTotal: count,
  memoryAvailable: count,
  agents: array(shape({ id: hostAgentId, state: literal("ready", "missing", "unable") })),
} satisfies Contract<HostFacts>);
const validHostFacts: Validator<HostFacts> = copying(
  (value): value is HostFacts =>
    hostFactsShape(value) &&
    value.load.length === 3 &&
    value.memoryAvailable <= value.memoryTotal &&
    value.agents.length <= 100,
  (value) => project(hostFactsShape, value),
);
const validHostResult: Validator<HostResult> = either(
  shape({
    ok: literal(false),
    reason: literal(
      "unreachable",
      "unsupported",
      "artifact-unavailable",
      "folder-refused",
      "unsafe-folder",
      "origin-unavailable",
      "clone-failed",
      "checkout-refused",
    ),
  }),
  shape({
    ok: literal(true),
    facts: validHostFacts,
    checkout: either(
      absent,
      shape({ path: hostFolder, state: literal("clean", "changed", "absent") }),
    ),
  }),
);
const validHostsState: Validator<HostsState> = shape({
  hosts: array(
    shape({ host: hostAlias, codeFolder: hostFolder, result: either(absent, validHostResult) }),
  ),
  locations: array(shape({ repository: text, host: hostAlias, result: validHostResult })),
  result: either(absent, validHostResult),
} satisfies Contract<HostsState>);

const validSettings: Validator<Settings> = shape({
  registeredHosts: either(absent, array(validRegisteredHost)),
  setupComplete: boolean,
  checkForUpdates: boolean,
  agyPluginOfferAnswered: boolean,
  hooks: boolean,
  agentHooks: either(absent, dictionary(boolean)),
  restoreSessions: boolean,
  showNewChildren: boolean,
  closeFinishedAgents: boolean,
  concurrentChildren: range(1, 16, true),
  recentRepositoryDays: range(1, 365, true),
  unreadChildMinutes: range(0, 1440, true),
  autoRemoveMergedWorktrees: boolean,
  showPullRequests: either(absent, boolean),
  showNestedRepositoryNames: boolean,
  middleClickPaste: boolean,
  copyOnSelect: boolean,
  forges: dictionary(boolean),
  forgeHosts: dictionary(text),
  agents: both(
    shape({
      claude: boolean,
      codex: boolean,
      agy: boolean,
    }),
    dictionary(boolean),
  ),
  agentArguments: both(
    shape({
      claude: array(text),
      codex: array(text),
      agy: array(text),
    }),
    dictionary(array(text)),
  ),
  agentBypassAcknowledged: both(
    shape({
      claude: boolean,
      codex: boolean,
      agy: boolean,
    }),
    dictionary(boolean),
  ),
  agentBypassIdentities: either(absent, dictionary(text)),
  worktreeLocation: literal("root", "adjacent"),
  panelColor: literal("vivid", "subtle", "plain"),
  interfaceTheme: validInterfaceThemeChoice,
  interfaceScale: literal(80, 90, 100, 110, 120, 130, 140, 150, 175, 200, 250, 300),
  terminalFontSize: range(10, 32, true),
  terminalFont: text,
  terminalTheme: validTerminalThemeChoice,
  sound: validSoundSettings,
  codeFolder: either(nil, text),
} satisfies Contract<Settings>);

const validSetupState: Validator<SetupState> = shape({
  updates: either(absent, validUpdateState),
  themes: either(absent, validThemeCatalog),
  settings: validSettings,
  worktreeRoot: text,
} satisfies Contract<SetupState>);

const validConfigForge: Validator<ConfigForge> = shape({
  id: nonempty,
  name: text,
  badge: text,
  executables: array(text),
  file: either(absent, text),
  reason: either(absent, text),
} satisfies Contract<ConfigForge>);

const validConfigAgent: Validator<ConfigAgent> = shape({
  id: nonempty,
  name: text,
  mark: text,
  command: text,
  file: text,
  state: literal("rejected"),
  reason: either(absent, text),
} satisfies Contract<ConfigAgent>);

const validConfigPending: Validator<ConfigPending> = shape({
  id: nonempty,
  action: text,
  file: text,
  detail: text,
} satisfies Contract<ConfigPending>);

const validConfigRejection: Validator<ConfigRejection> = shape({
  file: text,
  reason: text,
} satisfies Contract<ConfigRejection>);

const validConfigStatus: Validator<ConfigStatus> = shape({
  forgePlugins: either(absent, array(validConfigForge)),
  agentPlugins: either(absent, array(validConfigAgent)),
  folder: text,
  available: boolean,
  pending: either(nil, validConfigPending),
  rejected: array(validConfigRejection),
  error: either(absent, text),
} satisfies Contract<ConfigStatus>);

const validRepository: Validator<Repository> = shape({
  path: text,
  name: text,
} satisfies Contract<Repository>);

const validExecutionPhase: Validator<ExecutionPhase> = literal(
  "idle",
  "working",
  "starting",
  "blocked",
  "exited",
);

const validExecutionSnapshot: Validator<ExecutionSnapshot> = shape({
  terminalId: (value): value is string => nonempty(value) && value.length <= 200,
  launch: count,
  revision: count,
  turn: count,
  phase: validExecutionPhase,
} satisfies Contract<ExecutionSnapshot>);

const validAttentionKind: Validator<AttentionKind> = literal(
  "question",
  "permission",
  "credential",
  "provider",
  "unknown",
);

const validVerdictState: Validator<VerdictState> = literal(
  "done",
  "failed",
  "working",
  "needs_input",
  "quiet_ok",
);

const validTerminalState: Validator<TerminalState> = shape({
  waitingOn: either(absent, count),
  outputRevision: either(absent, count),
  inputRevision: either(absent, count),
  execution: either(absent, validExecutionSnapshot),
  attentionKind: either(absent, validAttentionKind),
  id: nonempty,
  verdictId: either(nil, text),
  state: validVerdictState,
  reason: text,
  signal: text,
  confidence: range(0, 1),
  timestamp: finite,
} satisfies Contract<TerminalState>);

const validOrchestrationEntry: Validator<OrchestrationEntry> = shape({
  id: nonempty,
  action: literal(
    "create_worktree",
    "launch",
    "stop",
    "close",
    "remove_worktree",
    "prompt",
    "send_keys",
    "reply",
    "take_over",
  ),
  label: text,
  status: literal(
    "failed",
    "pending_confirmation",
    "running",
    "succeeded",
    "declined",
    "cancelled",
    "indeterminate",
  ),
  at: finite,
} satisfies Contract<OrchestrationEntry>);

const validOrchestrationView: Validator<OrchestrationView> = either(
  shape({
    role: literal("orchestrator"),
    active: boolean,
    children: count,
    history: array(validOrchestrationEntry),
  }),
  shape({
    role: literal("child"),
    parentId: text,
    takenOver: boolean,
  }),
);

const validReviewFinding: Validator<ReviewFinding> = shape({
  file: text,
  line: positiveCount,
  summary: text,
  scenario: text,
} satisfies Contract<ReviewFinding>);

const validReviewVerdict: Validator<ReviewVerdict> = either(
  shape({
    verdict: literal("clean"),
  }),
  shape({
    verdict: literal("findings"),
    findings: array(validReviewFinding),
  }),
);

const validHandoff: Validator<Handoff> = shape({
  seq: count,
  status: literal("done", "failed", "blocked"),
  summary: text,
  links: array(text),
  timestamp: text,
  review: either(absent, validReviewVerdict),
} satisfies Contract<Handoff>);

const validReviewReason: Validator<ReviewReason> = literal(
  "round cap",
  "author blocked",
  "author failed",
  "reviewer blocked",
  "reviewer failed",
  "missing handoff",
  "missing verdict",
  "checks not green",
  "worktree changed",
  "launch failed",
  "resume unavailable",
  "stopped",
  "restored",
);

const validSelectionToken: Validator<string> = (value): value is string =>
  typeof value === "string" &&
  value.trim() === value &&
  /^[A-Za-z0-9._:/][A-Za-z0-9._:/-]{0,63}$/u.test(value);

const validReviewState: Validator<ReviewState> = shape({
  model: either(absent, validSelectionToken),
  effort: either(absent, validSelectionToken),
  authorId: text,
  round: count,
  phase: literal("clean", "building", "reviewing", "fixing", "waiting-on-parent", "escalated"),
  reason: either(absent, validReviewReason),
  waiting: either(absent, boolean),
  rounds: count,
  agent: text,
  postFindings: boolean,
  parentWaitMinutes: either(absent, count),
} satisfies Contract<ReviewState>);

const validPlacement = either(
  absent,
  shape({ kind: literal("local") }),
  shape({
    kind: literal("remote"),
    host: (value): value is string =>
      typeof value === "string" &&
      value.length <= 253 &&
      /^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}@)?[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(value),
  }),
);

const validWorkspaceTerminal: Validator<WorkspaceTerminal> = shape({
  remote: either(absent, literal(true)),
  remoteCleanup: either(absent, literal("unreachable")),
  placement: validPlacement,
  foregroundProgram: either(absent, text),
  outputRevision: either(absent, count),
  inputRevision: either(absent, count),
  mcpConnection: either(absent, literal("connecting", "connected", "not-connected")),
  execution: either(absent, validExecutionSnapshot),
  attentionKind: either(absent, validAttentionKind),
  id: nonempty,
  kind: literal("agent", "shell"),
  agent: text,
  providerOrigin: either(absent, literal("config", "bundled")),
  repository: text,
  worktree: text,
  branch: either(nil, text),
  attention: literal("hooks", "evaluator"),
  state: either(nil, validTerminalState),
  exited: either(absent, boolean),
  conversationId: either(absent, text),
  dormant: either(absent, boolean),
  launchVersion: either(absent, count),
  bypass: either(absent, boolean),
  home: either(absent, boolean),
  config: either(absent, boolean),
  probe: either(absent, boolean),
  probeOwner: either(absent, text),
  probeNote: either(absent, boolean),
  startedAt: either(absent, finite),
  exitCode: either(absent, finite),
  selection: either(
    absent,
    shape({
      model: either(absent, validSelectionToken),
      effort: either(absent, validSelectionToken),
    }),
  ),
  launchFlags: either(absent, array(text)),
  environment: either(absent, array(text)),
  orchestration: either(absent, validOrchestrationView),
  handoff: either(absent, validHandoff),
  review: either(absent, validReviewState),
  roleNotRestored: either(absent, boolean),
} satisfies Contract<WorkspaceTerminal>);

const validWorkspaceSnapshot: Validator<WorkspaceSnapshot> = shape({
  repositories: array(validRepository),
  terminals: array(validWorkspaceTerminal),
} satisfies Contract<WorkspaceSnapshot>);

const validPreviewOpenAction: Validator<PreviewOpenAction> = shape({
  id: nonempty,
  terminalId: (value): value is string => nonempty(value) && value.length <= 200,
  path: text,
  at: finite,
} satisfies Contract<PreviewOpenAction>);

const validPreviewSummary: Validator<PreviewSummary> = shape({
  openedBy: either(
    absent,
    shape({
      terminalId: (value): value is string => nonempty(value) && value.length <= 200,
      agent: text,
    }),
  ),
  network: boolean,
  id: nonempty,
  repository: text,
  worktree: text,
  relativePath: text,
  kind: literal("markdown", "html"),
} satisfies Contract<PreviewSummary>);

const validBoardPullRequest: Validator<BoardPullRequest> = shape({
  number: positiveCount,
  requestLabel: either(absent, literal("Merge request")),
  numberPrefix: either(absent, literal("!")),
  title: either(absent, text),
  url: either(absent, text),
  sourceName: either(absent, text),
  checksMeaning: either(absent, literal("required", "head-pipeline", "commit-status")),
  requiredChecks: either(absent, literal("unknown", "pending", "success", "failure", "none")),
  state: literal("OPEN", "CLOSED", "MERGED"),
  checks: either(
    nil,
    shape({
      passed: count,
      failed: count,
      pending: count,
    }),
  ),
} satisfies Contract<BoardPullRequest>);

const validWorktree: Validator<Worktree> = shape({
  pullRequest: either(absent, validBoardPullRequest),
  path: text,
  head: either(nil, text),
  bare: boolean,
  branch: either(nil, text),
  locked: boolean,
  prunable: boolean,
  managed: boolean,
} satisfies Contract<Worktree>);

const validCleanupReason: Validator<CleanupReason> = literal(
  "running",
  "worktree changed",
  "main checkout",
  "unavailable",
  "resumable conversation",
  "uncommitted changes",
  "not merged",
  "not started",
  "removal failed",
  "fetch failed",
  "branch kept",
);

const validCleanupItem: Validator<CleanupItem> = shape({
  id: nonempty,
  path: text,
  branch: text,
  state: literal("error", "queued", "removing", "removed", "kept"),
  reason: either(absent, validCleanupReason),
  changes: either(absent, text),
  omittedChanges: either(absent, count),
} satisfies Contract<CleanupItem>);

const validCleanupProgress: Validator<CleanupProgress> = shape({
  id: either(absent, text),
  total: count,
  done: count,
  phase: literal("fetch", "remove", "finished"),
  stopped: boolean,
  items: array(validCleanupItem),
} satisfies Contract<CleanupProgress>);

const validHomeShellFacts: Validator<HomeShellFacts> = shape({
  directory: text,
  path: text,
  version: either(nil, text),
} satisfies Contract<HomeShellFacts>);

const validSidebarInventory: Validator<SidebarInventory> = shape({
  previewActions: either(absent, array(validPreviewOpenAction)),
  previews: either(absent, array(validPreviewSummary)),
  repositories: array(
    shape({
      path: text,
      name: text,
      unavailable: either(absent, boolean),
      worktrees: array(validWorktree),
      cleanup: either(absent, validCleanupProgress),
      canDeleteMerged: either(absent, boolean),
      mergedCount: either(absent, count),
      mergedError: either(absent, text),
    }),
  ),
  shell: text,
  home: either(absent, validHomeShellFacts),
} satisfies Contract<SidebarInventory>);

const validAgentSetupState: Validator<AgentSetupState> = literal(
  "unavailable",
  "not-installed",
  "installed",
  "outdated",
  "disabled",
);

const validAgentSetupStatus: Validator<AgentSetupStatus> = shape({
  state: validAgentSetupState,
  offer: either(absent, text),
  actions: array(
    shape({
      id: nonempty,
      label: text,
    }),
  ),
} satisfies Contract<AgentSetupStatus>);

const validAgyPluginStatus: Validator<AgyPluginStatus> = shape({
  state: literal("unavailable", "not-installed", "installed", "outdated", "disabled"),
  version: either(absent, count),
} satisfies Contract<AgyPluginStatus>);

const validHookHealthState: Validator<HookHealthState> = literal(
  "declined",
  "outdated",
  "not-reviewed",
  "trusted",
);

const validAgentInstallation: Validator<AgentInstallation> = shape({
  id: nonempty,
  name: either(absent, text),
  mark: either(absent, text),
  command: either(absent, text),
  path: either(nil, text),
  version: either(nil, text),
  hooks: boolean,
  attentionSignal: either(absent, boolean),
  resume: either(absent, boolean),
  resumePaste: either(
    absent,
    array(
      shape({
        command: text,
        selector: text,
      }),
    ),
  ),
  restoreControl: either(absent, boolean),
  source: either(absent, text),
  bypassArguments: either(absent, array(text)),
  setup: either(absent, validAgentSetupStatus),
  agyPlugin: either(absent, validAgyPluginStatus),
  inline: either(absent, boolean),
  cliGuidance: either(absent, boolean),
  mcp: either(absent, boolean),
  mcpReason: either(absent, text),
  healthSupported: either(absent, boolean),
  notifierReplacement: either(absent, boolean),
  healthInstructions: either(absent, text),
  hookState: either(absent, validHookHealthState),
  reason: text,
} satisfies Contract<AgentInstallation>);

const validAgentReport: Validator<AgentReport> = shape({
  warning: either(nil, text),
  agents: array(validAgentInstallation),
} satisfies Contract<AgentReport>);

const validGitPanelFacts: Validator<GitPanelFacts> = shape({
  changes: either(nil, count),
  upstream: either(
    nil,
    shape({
      ahead: count,
      behind: count,
    }),
  ),
  commit: either(
    nil,
    shape({
      hash: text,
      subject: text,
      timestamp: finite,
    }),
  ),
  remote: either(nil, text),
  defaultBranch: either(nil, text),
  lastFetch: either(nil, finite),
  fetchFailed: boolean,
  merged: literal(null, false, true),
} satisfies Contract<GitPanelFacts>);

const validActionLogEntry: Validator<ActionLogEntry> = shape({
  path: either(absent, text),
  session: either(absent, text),
  operationId: text,
  timestamp: text,
  actorId: text,
  parentId: either(nil, text),
  repository: text,
  worktree: text,
  action: text,
  targetId: either(nil, text),
  resultId: either(nil, text),
  status: text,
  reason: text,
  proposal: either(absent, text),
  inputHash: either(absent, text),
} satisfies Contract<ActionLogEntry>);

const validActionLogPage: Validator<ActionLogPage> = shape({
  entries: array(validActionLogEntry),
  total: count,
} satisfies Contract<ActionLogPage>);

const validBranchInventory: Validator<BranchInventory> = shape({
  head: either(nil, text),
  local: array(
    shape({
      name: text,
      worktree: either(nil, text),
    }),
  ),
  remote: either(nil, text),
  remoteBranches: array(text),
} satisfies Contract<BranchInventory>);

const validAgentLaunched: Validator<AgentLaunched> = shape({
  remote: either(absent, literal(true)),
  placement: validPlacement,
  launchFlags: either(absent, array(text)),
  conversationId: either(absent, text),
  bypass: either(absent, boolean),
  providerOrigin: either(absent, literal("config", "bundled")),
  id: nonempty,
  attention: literal("hooks", "evaluator"),
  environment: either(absent, array(text)),
} satisfies Contract<AgentLaunched>);

const environmentRow = shape({
  name: text,
  value: either(nil, text),
  secret: boolean,
} satisfies Contract<EnvironmentRow>);
const validEnvironmentRow: Validator<EnvironmentRow> = copying(
  (value): value is EnvironmentRow =>
    environmentRow(value) && (!value.secret || value.value === null),
  (value) => project(environmentRow, value),
);

const validEnvironmentState: Validator<EnvironmentState> = shape({
  lists: both(
    shape({
      claude: array(validEnvironmentRow),
      codex: array(validEnvironmentRow),
      agy: array(validEnvironmentRow),
      all: array(validEnvironmentRow),
    }),
    dictionary(array(validEnvironmentRow)),
  ),
  windows: boolean,
  secrets: boolean,
} satisfies Contract<EnvironmentState>);

const validEnvironmentCandidate: Validator<EnvironmentCandidate> = shape({
  name: text,
  display: text,
  status: literal("new", "same", "replaces"),
} satisfies Contract<EnvironmentCandidate>);

const validFoundRepository: Validator<FoundRepository> = shape({
  path: text,
  name: text,
  relative: text,
  branch: either(nil, text),
  lastActive: either(nil, finite),
  recent: boolean,
  added: boolean,
} satisfies Contract<FoundRepository>);

const validCodeScan: Validator<CodeScan> = shape({
  folder: text,
  repositories: array(validFoundRepository),
  folders: count,
  truncated: boolean,
} satisfies Contract<CodeScan>);

const validCodeSuggestion: Validator<CodeSuggestion> = shape({
  path: text,
  repositories: count,
  more: boolean,
} satisfies Contract<CodeSuggestion>);

const validRepositoryUpdate: Validator<RepositoryUpdate> = shape({
  repositories: array(validRepository),
  failures: array(
    shape({
      path: text,
      message: text,
    }),
  ),
} satisfies Contract<RepositoryUpdate>);

const validSoundKind: Validator<SoundKind> = literal("done", "working", "needs-you", "refusal");

const validSoundEntry: Validator<SoundEntry> = shape({
  name: text,
  error: either(absent, text),
  kind: validSoundKind,
  source: literal("builtin", "user"),
  file: text,
} satisfies Contract<SoundEntry>);

const validSoundRead: Validator<SoundRead> = copying(
  (value): value is SoundRead => {
    if (!object(value)) return false;
    // Consumers discriminate by property presence; contradictory branches are invalid.
    if ("bytes" in value) return !("error" in value) && bytes(value["bytes"]);
    return text(value["error"]);
  },
  (value) => {
    if (!object(value)) return undefined;
    return "bytes" in value ? { bytes: project(bytes, value["bytes"]) } : { error: value["error"] };
  },
);

const validCommandItem: Validator<CommandItem> = shape({
  id: nonempty,
  label: text,
  shortcut: text,
  enabled: boolean,
  checked: either(absent, boolean),
  badge: either(absent, text),
} satisfies Contract<CommandItem>);

const validAppMenuEntry: Validator<AppMenuEntry> = either(
  nil,
  shape({
    kind: literal("command"),
    id: nonempty,
    label: text,
    shortcut: text,
    enabled: boolean,
    checked: either(absent, boolean),
    badge: either(absent, text),
  }),
  shape({
    kind: literal("submenu"),
    id: nonempty,
    label: text,
    items: array(either(nil, validCommandItem)),
  }),
  shape({
    kind: literal("size"),
    label: text,
    scale: finite,
    smaller: validCommandItem,
    bigger: validCommandItem,
  }),
);

const validShortcutRow: Validator<ShortcutRow> = shape({
  label: text,
  keys: text,
} satisfies Contract<ShortcutRow>);

const validShortcutGroup: Validator<ShortcutGroup> = shape({
  title: text,
  lead: text,
  rows: array(validShortcutRow),
} satisfies Contract<ShortcutGroup>);

async function reply<T>(channel: string, check: Validator<T>, ...args: unknown[]): Promise<T> {
  const value: unknown = await ipcRenderer.invoke(channel, ...args);
  if (!check(value)) throw new Error(`Invalid ${channel} response`);
  const clean = project(check, value);
  if (!check(clean)) throw new Error(`Invalid ${channel} response`);
  return clean;
}
// Void capabilities expose no reply data, regardless of main's internal return value.
async function invokeVoid(channel: string, ...args: unknown[]): Promise<void> {
  await ipcRenderer.invoke(channel, ...args);
}

function readinessReport(value: unknown): value is ReadinessReport {
  return (
    object(value) &&
    Object.keys(value).length === 3 &&
    typeof value["git"] === "string" &&
    ["ready", "not-installed", "invalid-version", "unavailable"].includes(value["git"]) &&
    typeof value["platform"] === "string" &&
    ["macos", "windows", "linux"].includes(value["platform"]) &&
    Array.isArray(value["forges"]) &&
    value["forges"].length <= 1000 &&
    Array.from(value["forges"]).every(
      (entry: unknown) =>
        object(entry) &&
        Object.keys(entry).length === 2 &&
        typeof entry["host"] === "string" &&
        entry["host"].length <= 253 &&
        !/^\d+(?:\.\d+){3}$/u.test(entry["host"]) &&
        /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(
          entry["host"],
        ) &&
        typeof entry["status"] === "string" &&
        ["ready", "not-installed", "not-signed-in", "unavailable", "unassigned"].includes(
          entry["status"],
        ),
    )
  );
}

function executionTransition(value: unknown): value is ExecutionTransition {
  return (
    object(value) &&
    validExecutionSnapshot(value) &&
    literal("launch", "hook", "title", "screen", "exit")(value["source"]) &&
    literal("starting", "idle", "working", "blocked", "exited")(value["from"]) &&
    value["phase"] === value["to"] &&
    value["from"] !== value["to"] &&
    finite(value["at"])
  );
}

// Main sends this after availability notifications. Reply after the current
// renderer turn, behind any already-sent view IPC, even when no view is mounted.
ipcRenderer.on("terminal:flush-views", (_event, ids: unknown, token: unknown) => {
  if (
    !Array.isArray(ids) ||
    !Array.from(ids).every((id: unknown) => typeof id === "string") ||
    typeof token !== "number" ||
    !Number.isSafeInteger(token) ||
    token <= 0
  )
    return;
  queueMicrotask(() => {
    ipcRenderer.send("terminal:views-flushed", ids, token);
  });
});

function windowViews(value: unknown): value is WindowView[] {
  return (
    Array.isArray(value) &&
    value.length <= 8192 &&
    Array.from(value).every(
      (item: unknown) =>
        object(item) && nonempty(item["id"]) && item["id"].length <= 200 && count(item["window"]),
    )
  );
}
function audioState(value: unknown): value is WindowAudioState {
  return (
    object(value) &&
    typeof value["enabled"] === "boolean" &&
    (value["focusedId"] === null ||
      (nonempty(value["focusedId"]) && value["focusedId"].length <= 200))
  );
}
const windowArgument = (name: string) =>
  process.argv.find((arg) => arg.startsWith(`--foom-${name}=`))?.split("=")[1];
// Listen before the new board mounts: main may finish moving a preview first.
// This listener belongs to the preload context; unmount releases its callback.
let placePreview: ((id: string, expiresAt: number) => Promise<PreviewPlacement>) | undefined;
const pendingPlacements = new Map<string, { id: string; expiresAt: number }>();
function deliverPlacement(request: string, id: string, expiresAt: number): void {
  const now = Date.now();
  for (const [key, pending] of pendingPlacements)
    if (pending.expiresAt <= now) pendingPlacements.delete(key);
  if (expiresAt <= now) return;
  const callback = placePreview;
  if (!callback) {
    if (pendingPlacements.size < 256) pendingPlacements.set(request, { id, expiresAt });
    return;
  }
  void Promise.resolve()
    .then(() => callback(id, expiresAt))
    .then((placement) => invokeVoid("preview:placed", request, id, placement))
    .catch(() => {});
}
ipcRenderer.on("preview:place", (_event, request: unknown, id: unknown, expiresAt: unknown) => {
  if (
    typeof request !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(request) ||
    typeof id !== "string" ||
    !/^[a-f0-9]{32}$/u.test(id) ||
    !finite(expiresAt) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= 0
  )
    return;
  deliverPlacement(request, id, expiresAt);
});
const createdWorktree = both(
  validWorktree,
  shape({ outcome: literal("new", "existing", "origin", "open") }),
);
const desktop: DesktopApi = {
  previews: {
    onPlace(callback) {
      placePreview = callback;
      for (const [request, pending] of pendingPlacements) {
        pendingPlacements.delete(request);
        deliverPlacement(request, pending.id, pending.expiresAt);
      }
      return () => {
        if (placePreview === callback) placePreview = undefined;
      };
    },
    popout: (id) => invokeVoid("preview:popout", id),
    network: (id, enabled) => invokeVoid("preview:network", id, enabled),
    pick: (worktree) => reply("preview:pick", either(nil, text), worktree),
    reload: (id) => invokeVoid("preview:reload", id),
    close: (id) => invokeVoid("preview:close", id),
    bounds: (id, bounds) => invokeVoid("preview:bounds", id, bounds),
    painted: (id, version) => invokeVoid("preview:painted", id, version),
    cover: (covered) => invokeVoid("preview:cover", covered),
    onSnapshots(callback) {
      const listener = (_event: IpcRendererEvent, value: unknown) => {
        if (!Array.isArray(value) || value.length > 256) return;
        const snapshots: PreviewSnapshot[] = [];
        for (const entry of value) {
          if (
            !object(entry) ||
            typeof entry["id"] !== "string" ||
            !/^[a-f0-9]{32}$/.test(entry["id"]) ||
            !object(entry["bounds"]) ||
            typeof entry["version"] !== "number" ||
            !Number.isSafeInteger(entry["version"]) ||
            entry["version"] < 1 ||
            typeof entry["image"] !== "string" ||
            !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(entry["image"])
          )
            return;
          const bounds = entry["bounds"];
          const { x, y, width, height, visible } = bounds;
          if (
            typeof x !== "number" ||
            typeof y !== "number" ||
            typeof width !== "number" ||
            typeof height !== "number" ||
            ![x, y, width, height].every(Number.isFinite) ||
            typeof visible !== "boolean"
          )
            return;
          snapshots.push({
            id: entry["id"],
            bounds: { x, y, width, height, visible },
            image: entry["image"],
            version: entry["version"],
          });
        }
        callback(snapshots);
      };
      ipcRenderer.on("preview:snapshots", listener);
      return () => {
        ipcRenderer.removeListener("preview:snapshots", listener);
      };
    },
  },
  windows: {
    audio: {
      state: async () => {
        const value: unknown = await ipcRenderer.invoke("windows:audio-state");
        return audioState(value)
          ? { enabled: value.enabled, focusedId: value.focusedId }
          : { enabled: false, focusedId: null };
      },
      focus: (id) => invokeVoid("windows:audio-focus", id),
      refuse: () => invokeVoid("windows:refuse"),
      onChanged: (callback) => {
        const listener = (_event: IpcRendererEvent, value: unknown) => {
          if (audioState(value)) callback(value);
        };
        ipcRenderer.on("windows:audio", listener);
        return () => {
          ipcRenderer.removeListener("windows:audio", listener);
        };
      },
      onRefuse: (callback) => {
        const listener = () => {
          callback();
        };
        ipcRenderer.on("windows:refuse", listener);
        return () => {
          ipcRenderer.removeListener("windows:refuse", listener);
        };
      },
    },
    id: windowArgument("window-id") ?? "main",
    number: Number(windowArgument("window-number") ?? 0),
    initialSession: windowArgument("initial-session"),
    sync: (ids) => reply("windows:sync", array(text), ids),
    select: (id) => reply("windows:select", boolean, id),
    popout: (id) => invokeVoid("windows:popout", id),
    snapshot: async () => {
      const value: unknown = await ipcRenderer.invoke("windows:views");
      return windowViews(value) ? value.map(({ id, window }) => ({ id, window })) : [];
    },
    onChanged: (callback) => {
      const listener = (_event: IpcRendererEvent, value: unknown) => {
        if (windowViews(value)) callback(value);
      };
      ipcRenderer.on("windows:changed", listener);
      return () => {
        ipcRenderer.removeListener("windows:changed", listener);
      };
    },
    onRemoved: (callback) => {
      const listener = (_event: IpcRendererEvent, id: unknown) => {
        if (typeof id === "string" && id.length > 0 && id.length <= 200) callback(id);
      };
      ipcRenderer.on("windows:removed", listener);
      return () => {
        ipcRenderer.removeListener("windows:removed", listener);
      };
    },
  },
  sounds: {
    onChange(callback) {
      const listener = () => {
        callback();
      };
      ipcRenderer.on("sound:changed", listener);
      return () => {
        ipcRenderer.removeListener("sound:changed", listener);
      };
    },
    list: () => reply("sound:list", array(validSoundEntry)),
    read: (request) => reply("sound:read", validSoundRead, request),
    openFolder: () => invokeVoid("sound:open-folder"),
    notices: () => reply("sound:notices", text),
  },
  confirmations: {
    onScrim(callback) {
      const listener = (_event: IpcRendererEvent, value: unknown) => {
        if (typeof value === "boolean") callback(value);
      };
      ipcRenderer.on("confirmation:scrim", listener);
      return () => {
        ipcRenderer.removeListener("confirmation:scrim", listener);
      };
    },
    onDialog(callback) {
      const listener = () => {
        callback();
      };
      ipcRenderer.on("confirmation:dialog", listener);
      return () => {
        ipcRenderer.removeListener("confirmation:dialog", listener);
      };
    },
    subscribe(callback) {
      const listener = (_event: IpcRendererEvent, value: unknown, accepted: unknown) => {
        if (value === null && (accepted === undefined || typeof accepted === "boolean"))
          callback(null, accepted === true);
        else if (
          object(value) &&
          nonempty(value["nonce"]) &&
          nonempty(value["target"]) &&
          nonempty(value["label"])
        )
          callback({ nonce: value["nonce"], target: value["target"], label: value["label"] });
      };
      ipcRenderer.on("confirmation:armed", listener);
      return () => {
        ipcRenderer.removeListener("confirmation:armed", listener);
      };
    },
    confirm: (arm) => invokeVoid("confirmation:confirm", arm.nonce, arm.target),
    cancel: () => invokeVoid("confirmation:cancel"),
  },
  isDevelopment: process.argv.includes("--foom-development"),
  appMenu: {
    legal: async (id: unknown) => {
      if (id !== "licenses" && id !== "notices") throw new Error("Invalid legal document");
      const text: unknown = await ipcRenderer.invoke("app-menu:legal", id);
      if (typeof text !== "string" || !text || text.length > 1_048_576)
        throw new Error("Invalid bundled legal text");
      return text;
    },
    onLegal(callback) {
      const listener = (_event: IpcRendererEvent, id: unknown) => {
        if (id === "licenses" || id === "notices") callback(id);
      };
      ipcRenderer.on("app-menu:legal", listener);
      return () => {
        ipcRenderer.removeListener("app-menu:legal", listener);
      };
    },
    version: async () => {
      const value: unknown = await ipcRenderer.invoke("app-menu:version");
      if (
        typeof value !== "object" ||
        value === null ||
        !("app" in value) ||
        typeof value.app !== "string" ||
        !/^[0-9][0-9A-Za-z.+-]{0,127}$/u.test(value.app) ||
        !("electron" in value) ||
        typeof value.electron !== "string" ||
        !/^[0-9][0-9A-Za-z.+-]{0,127}$/u.test(value.electron)
      )
        throw new Error("Invalid application version");
      return { app: value.app, electron: value.electron };
    },
    platform: process.platform,
    setView: (state) => invokeVoid("app-menu:view", state),
    commands: () => reply("app-menu:list", array(validAppMenuEntry)),
    shortcuts: () => reply("app-menu:shortcuts", array(validShortcutGroup)),
    execute: (id) => invokeVoid("app-menu:execute", id),
    onOpen(callback) {
      const listener = () => {
        callback();
      };
      ipcRenderer.on("app-menu:open", listener);
      return () => {
        ipcRenderer.removeListener("app-menu:open", listener);
      };
    },
    onShortcuts(callback) {
      const listener = () => {
        callback();
      };
      ipcRenderer.on("app-menu:shortcuts", listener);
      return () => {
        ipcRenderer.removeListener("app-menu:shortcuts", listener);
      };
    },
    onSession(callback) {
      const listener = (_event: IpcRendererEvent, id: unknown, background: unknown) => {
        if (
          typeof id === "string" &&
          id.length > 0 &&
          id.length <= 256 &&
          (background === undefined || typeof background === "boolean")
        ) {
          if (background === true) callback(id, true);
          else callback(id);
        }
      };
      ipcRenderer.on("app-menu:session", listener);
      return () => {
        ipcRenderer.removeListener("app-menu:session", listener);
      };
    },
  },
  onBoardCommand(callback) {
    const listener = (_event: IpcRendererEvent, command: unknown) => {
      if (isBoardCommand(command)) callback(command);
    };
    ipcRenderer.on("board:command", listener);
    return () => {
      ipcRenderer.removeListener("board:command", listener);
    };
  },
  async create(cols, rows) {
    const reply: unknown = await ipcRenderer.invoke("terminal:create", cols, rows);
    if (
      typeof reply !== "object" ||
      reply === null ||
      !("id" in reply) ||
      !nonempty(reply.id) ||
      !("title" in reply) ||
      typeof reply.title !== "string"
    )
      throw new Error("Invalid terminal response");
    return { id: reply.id, title: reply.title };
  },
  async attach(id) {
    await ipcRenderer.invoke("terminal:attach", id);
  },
  async detach(id) {
    await ipcRenderer.invoke("terminal:detach", id);
  },
  async kill(id) {
    await ipcRenderer.invoke("terminal:kill", id);
  },
  copyTerminalSelection: (id, text) => invokeVoid("terminal:copy-selection", id, text),
  pasteTerminal: async (id) => {
    const value: unknown = await ipcRenderer.invoke("terminal:paste", id);
    if (!object(value)) throw new Error("Invalid paste reply");
    if (value["kind"] === "text" && typeof value["text"] === "string")
      return { kind: "text", text: value["text"] };
    if (
      value["kind"] === "empty" ||
      value["kind"] === "unsupported" ||
      value["kind"] === "failed" ||
      value["kind"] === "cancelled"
    )
      return { kind: value["kind"] };
    throw new Error("Invalid paste reply");
  },
  input(id, data, origin) {
    for (let offset = 0; offset < data.length; ) {
      let end = Math.min(offset + 65536, data.length);
      // IPC limits use UTF-16 code units. Keep a surrogate pair in the same write.
      const before = data.charCodeAt(end - 1);
      const after = data.charCodeAt(end);
      if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
        end -= 1;
      }
      if (origin === undefined) ipcRenderer.send("terminal:input", id, data.slice(offset, end));
      else ipcRenderer.send("terminal:input", id, data.slice(offset, end), origin);
      offset = end;
    }
  },
  resize: (id, cols, rows) => {
    ipcRenderer.send("terminal:resize", id, cols, rows);
  },
  acknowledge: (id, token, count) => {
    ipcRenderer.send("terminal:ack", id, token, count);
  },
  async tail(id, lines) {
    const reply: unknown = await ipcRenderer.invoke("terminal:tail", id, lines);
    if (!array(text)(reply) || reply.length > 10000) throw new Error("Invalid terminal tail");
    return Array.from(reply);
  },
  onActivity(callback) {
    const listener = (_event: IpcRendererEvent, batch: unknown) => {
      if (!Array.isArray(batch)) return;
      const entries: TerminalActivity[] = [];
      const values: unknown[] = batch;
      for (const entry of values) {
        if (
          typeof entry !== "object" ||
          entry === null ||
          !("id" in entry) ||
          typeof entry.id !== "string" ||
          !entry.id ||
          !("rate" in entry) ||
          typeof entry.rate !== "number" ||
          !Number.isFinite(entry.rate) ||
          entry.rate < 0
        )
          return;
        entries.push({ id: entry.id, rate: entry.rate });
      }
      callback(entries);
    };
    ipcRenderer.on("terminal:activity", listener);
    return () => ipcRenderer.removeListener("terminal:activity", listener);
  },
  actionLog: (query) => reply("workspace:action-log", validActionLogPage, query),
  clearActionLog: () => invokeVoid("workspace:clear-action-log"),
  onWorkspaceChange(callback) {
    const listener = () => {
      callback();
    };
    ipcRenderer.on("workspace:changed", listener);
    return () => {
      ipcRenderer.removeListener("workspace:changed", listener);
    };
  },
  startWorktree: (request) => reply("workspace:start", either(nil, text), request),
  removeWorktree: (id) => reply("workspace:remove", boolean, id),
  panelFacts: (repository, worktree) =>
    reply("workspace:panel-facts", validGitPanelFacts, repository, worktree),
  onFocusWorktree(callback) {
    const listener = (_event: Electron.IpcRendererEvent, path: unknown) => {
      if (nonempty(path) && path.length <= 4096) callback(path);
    };
    ipcRenderer.on("workspace:focus-worktree", listener);
    return () => {
      ipcRenderer.removeListener("workspace:focus-worktree", listener);
    };
  },
  sidebarInventory: () => reply("workspace:sidebar", validSidebarInventory),
  sidebarCommand: async (command) => {
    if (command.kind === "home-shell") {
      return reply(
        "workspace:sidebar-command",
        shape({ terminalId: (value): value is string => nonempty(value) && value.length <= 200 }),
        command,
      );
    }
    await invokeVoid("workspace:sidebar-command", command);
  },
  workspace: () => reply("workspace:snapshot", validWorkspaceSnapshot),
  addRepository: () => reply("workspace:add-repository", either(nil, validRepository)),
  worktrees: (repository) => reply("workspace:worktrees", array(validWorktree), repository),
  branches: (repository) => reply("workspace:branches", validBranchInventory, repository),
  createWorktree: (repository, branch, location) =>
    reply("workspace:create-worktree", createdWorktree, repository, branch, location),
  changeAgentSetup: (id, action) => reply("agents:setup", validAgentReport, id, action),
  changeAgyPlugin: (action) => reply("agents:agy-plugin", validAgentReport, action),
  scanAgents: (refresh) => reply("agents:scan", validAgentReport, refresh),
  launchAgent: (request) => reply("agents:launch", either(nil, validAgentLaunched), request),
  configStatus: () => reply("config:status", validConfigStatus),
  decideConfig: (decision, id) => reply("config:decide", validConfigStatus, decision, id),
  openConfigFolder: () => invokeVoid("config:open-folder"),
  onConfigChange(callback) {
    const listener = (_event: IpcRendererEvent, status: unknown) => {
      if (validConfigStatus(status)) callback(status);
    };
    ipcRenderer.on("config:changed", listener);
    return () => {
      ipcRenderer.removeListener("config:changed", listener);
    };
  },
  hosts: (action) => reply("setup:hosts", validHostsState, action),
  listTerminalFonts: (refresh = false) => reply("setup:terminal-fonts", array(text), refresh),
  listThemes: () => reply("theme:list", validThemeCatalog),
  openThemesFolder: (kind) => invokeVoid("theme:open-folder", kind),
  checkReadiness: async () => {
    const value: unknown = await ipcRenderer.invoke("setup:readiness");
    if (!readinessReport(value)) throw new Error("Invalid readiness response");
    return {
      git: value.git,
      platform: value.platform,
      forges: value.forges.map(({ host, status }) => ({ host, status })),
    };
  },
  restartToUpdate: () => invokeVoid("setup:restart-update"),
  setupState: async () => {
    const value: unknown = await ipcRenderer.invoke("setup:state");
    if (!validSetupState(value)) throw new Error("Invalid setup response");
    const clean = project(validSetupState, value);
    if (!validSetupState(clean)) throw new Error("Invalid setup response");
    return clean;
  },
  saveSetup: async (patch) => {
    const value: unknown = await ipcRenderer.invoke("setup:save", patch);
    if (!validSetupState(value)) throw new Error("Invalid setup response");
    const clean = project(validSetupState, value);
    if (!validSetupState(clean)) throw new Error("Invalid setup response");
    return clean;
  },
  environmentState: () => reply("environment:state", validEnvironmentState),
  saveEnvironment: (change) => reply("environment:save", validEnvironmentState, change),
  removeEnvironment: (scope, name) =>
    reply("environment:remove", validEnvironmentState, scope, name),
  readShellEnvironment: () => reply("environment:read-shell", array(validEnvironmentCandidate)),
  importEnvironment: (names) => reply("environment:import", validEnvironmentState, [...names]),
  codeSuggestions: () => reply("setup:code-suggestions", array(validCodeSuggestion)),
  scanCode(id, folder, onProgress) {
    const listener = (_event: IpcRendererEvent, scan: unknown, progress: unknown) => {
      if (
        scan === id &&
        object(progress) &&
        count(progress["folders"]) &&
        count(progress["repositories"])
      )
        onProgress({ folders: progress["folders"], repositories: progress["repositories"] });
    };
    ipcRenderer.on("setup:scan-progress", listener);
    return reply("setup:scan-code", either(nil, validCodeScan), id, folder).finally(() => {
      ipcRenderer.removeListener("setup:scan-progress", listener);
    });
  },
  applyRepositories: (selected) =>
    reply("setup:apply-repositories", validRepositoryUpdate, selected),
  onSetupChange(callback) {
    const listener = (_event: IpcRendererEvent, state: unknown) => {
      if (validSetupState(state)) callback(state);
    };
    ipcRenderer.on("setup:changed", listener);
    return () => {
      ipcRenderer.removeListener("setup:changed", listener);
    };
  },
  async feedback(id, verdictId, action) {
    await ipcRenderer.invoke("terminal:feedback", id, verdictId, action);
  },
  onExecution(callback) {
    const listener = (_event: IpcRendererEvent, event: unknown) => {
      if (executionTransition(event)) callback(event);
    };
    ipcRenderer.on("agent:execution", listener);
    return () => {
      ipcRenderer.removeListener("agent:execution", listener);
    };
  },
  onState(callback) {
    const listener = (_event: IpcRendererEvent, state: unknown) => {
      if (validTerminalState(state)) callback(state);
    };
    ipcRenderer.on("terminal:state", listener);
    return () => {
      ipcRenderer.removeListener("terminal:state", listener);
    };
  },
  onData(callback) {
    const listener = (_event: IpcRendererEvent, id: unknown, token: unknown, data: unknown) => {
      if (nonempty(id) && nonempty(token) && typeof data === "string") callback(id, token, data);
    };
    ipcRenderer.on("terminal:data", listener);
    return () => {
      ipcRenderer.removeListener("terminal:data", listener);
    };
  },
  onTerminalAvailability(callback) {
    const listener = (
      _event: IpcRendererEvent,
      ids: unknown,
      available: unknown,
      reset?: unknown,
    ) => {
      if (
        !Array.isArray(ids) ||
        typeof available !== "boolean" ||
        (reset !== undefined && typeof reset !== "boolean")
      )
        return;
      const values: unknown[] = ids;
      if (
        !Array.from(values).every(
          (id) => typeof id === "string" && id.length > 0 && id.length <= 200,
        )
      )
        return;
      for (const id of values)
        if (typeof id === "string") {
          if (reset === true) callback(id, available, true);
          else callback(id, available);
        }
    };
    ipcRenderer.on("terminal:availability", listener);
    return () => {
      ipcRenderer.removeListener("terminal:availability", listener);
    };
  },
  onExit(callback) {
    const listener = (_event: IpcRendererEvent, id: unknown, code: unknown) => {
      if (nonempty(id) && typeof code === "number" && Number.isSafeInteger(code))
        callback(id, code);
    };
    ipcRenderer.on("terminal:exit", listener);
    return () => {
      ipcRenderer.removeListener("terminal:exit", listener);
    };
  },
};
contextBridge.exposeInMainWorld("desktop", desktop);
