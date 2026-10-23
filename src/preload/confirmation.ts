import type {
  ConfirmationWindowApi,
  DialogRequest,
  DialogSummaryLine,
  RemovalItem,
} from "../shared/confirmation";
import type { InterfaceTheme } from "../shared/interface-theme";
import type { CleanupDialog, CleanupReason } from "../shared/cleanup";
import type { IpcRendererEvent } from "electron";
import { contextBridge, ipcRenderer } from "electron";
let current: DialogRequest | null = null;
const listeners = new Set<(request: DialogRequest | null) => void>();
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
// Keep these checks inline: the sandboxed loader can require only Electron.
type Validator<T> = (value: unknown) => value is T;
const text: Validator<string> = (value): value is string => typeof value === "string";
const finite: Validator<number> = (value): value is number =>
  typeof value === "number" && Number.isFinite(value);
const boolean: Validator<boolean> = (value): value is boolean => typeof value === "boolean";
const absent: Validator<undefined> = (value): value is undefined => value === undefined;
function literal<const T extends readonly (string | number | boolean | null | undefined)[]>(
  ...values: T
): Validator<T[number]> {
  return (value): value is T[number] => values.some((entry) => entry === value);
}
function either<T extends readonly Validator<unknown>[]>(
  ...checks: T
): Validator<T[number] extends Validator<infer U> ? U : never> {
  return (value): value is T[number] extends Validator<infer U> ? U : never =>
    checks.some((check) => check(value));
}
function array<T>(check: Validator<T>): Validator<T[]> {
  return (value): value is T[] =>
    Array.isArray(value) && Array.from(value).every((entry: unknown) => check(entry));
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
  return (value): value is Fields<T> =>
    object(value) && Object.entries(fields).every(([key, check]) => check(value[key]));
}
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
  return (value): value is Partial<Fields<T>> =>
    object(value) &&
    Object.entries(fields).every(([key, check]) => value[key] === undefined || check(value[key]));
}
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

const validRemovalItem: Validator<RemovalItem> = shape({
  id: nonempty,
  branch: text,
  path: text,
  changes: text,
  pullRequest: either(
    absent,
    shape({
      number: positiveCount,
      state: literal("OPEN", "CLOSED", "MERGED"),
    }),
  ),
} satisfies Contract<RemovalItem>);

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

const boundedChanges: Validator<string> = (value): value is string =>
  text(value) && value.length <= 25_050;
const validCleanupDialog: Validator<CleanupDialog> = shape({
  checkingCount: either(absent, count),
  fetchedAt: either(absent, range(0, Number.MAX_SAFE_INTEGER)),
  error: either(absent, literal("fetch failed")),
  stage: literal("checking", "ready", "run"),
  progress: shape({
    done: count,
    stopped: boolean,
    id: either(absent, text),
    total: count,
    phase: literal("fetch", "remove", "finished"),
    items: array(
      shape({
        changes: either(absent, boundedChanges),
        id: nonempty,
        branch: text,
        state: literal("error", "queued", "removing", "removed", "kept"),
        reason: either(absent, validCleanupReason),
        omittedChanges: either(absent, count),
      }),
    ),
  }),
} satisfies Contract<CleanupDialog>);

const summaryText: Validator<string> = (value): value is string =>
  text(value) &&
  value.length <= 8192 &&
  !/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069\u200e\u200f]/u.test(value);
const validDialogSummaryLine: Validator<DialogSummaryLine> = shape({
  text: summaryText,
  title: either(absent, summaryText),
} satisfies Contract<DialogSummaryLine>);

const validDialogRequest: Validator<DialogRequest> = shape({
  id: nonempty,
  theme: validInterfaceTheme,
  reply: either(
    absent,
    shape({
      context: text,
      text: text,
    }),
  ),
  removals: either(absent, array(validRemovalItem)),
  cleanup: either(absent, validCleanupDialog),
  title: nonempty,
  accept: nonempty,
  cancel: either(absent, literal("Not now")),
  detail: either(absent, text),
  quiet: either(absent, text),
  subject: either(absent, text),
  glyph: either(absent, literal("branch", "trash", "power", "orbit", "link", "shield", "bell")),
  note: either(absent, text),
  sections: either(
    absent,
    array(
      shape({
        label: text,
        items: array(text),
        arguments: either(absent, boolean),
        summary: either(absent, array(validDialogSummaryLine)),
      }),
    ),
  ),
  facts: either(
    absent,
    array(
      shape({
        label: text,
        value: text,
        mono: either(absent, boolean),
      }),
    ),
  ),
  arguments: either(absent, array(text)),
  pairing: either(
    absent,
    shape({
      code: text,
      expiresAt: finite,
    }),
  ),
  worktrees: either(
    absent,
    array(
      shape({
        branch: text,
        reason: either(absent, text),
      }),
    ),
  ),
  changes: either(absent, boundedChanges),
  sessions: either(
    absent,
    array(
      shape({
        id: nonempty,
        name: text,
        location: text,
        state: text,
      }),
    ),
  ),
} satisfies Contract<DialogRequest>);
ipcRenderer.on("confirmation:render", (_event: IpcRendererEvent, request: unknown) => {
  current = validDialogRequest(request) ? request : null;
  for (const listener of listeners) listener(current);
});
const api: ConfirmationWindowApi = {
  render(callback) {
    listeners.add(callback);
    callback(current);
    return () => {
      listeners.delete(callback);
    };
  },
  size(value) {
    ipcRenderer.send("confirmation:size", value);
  },
  answer(id, accepted) {
    ipcRenderer.send("confirmation:answer", id, accepted);
  },
};
contextBridge.exposeInMainWorld("confirmation", api);
