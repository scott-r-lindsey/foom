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
  presented: boolean,
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
  worktreePath: either(absent, nonempty),
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
  const clean = validDialogRequest(request) ? project(validDialogRequest, request) : null;
  current = validDialogRequest(clean) ? clean : null;
  for (const listener of listeners) listener(current);
});
let copySerial = 0;
const copyRequests = new Map<number, (success: boolean) => void>();
ipcRenderer.on(
  "confirmation:copy-result",
  (_event: IpcRendererEvent, call: unknown, success: unknown) => {
    if (typeof call !== "number" || typeof success !== "boolean") return;
    copyRequests.get(call)?.(success);
  },
);
const api: ConfirmationWindowApi = {
  render(callback) {
    listeners.add(callback);
    callback(current);
    return () => {
      listeners.delete(callback);
    };
  },
  copyPath(id, pathId) {
    if (
      !nonempty(id) ||
      !nonempty(pathId) ||
      pathId.length > 256 ||
      id !== current?.id ||
      copyRequests.size >= 32
    )
      return Promise.reject(new Error("Unable to copy"));
    const call = ++copySerial;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        copyRequests.delete(call);
        reject(new Error("Unable to copy"));
      }, 3000);
      copyRequests.set(call, (success) => {
        clearTimeout(timer);
        copyRequests.delete(call);
        if (success) resolve();
        else reject(new Error("Unable to copy"));
      });
      ipcRenderer.send("confirmation:copy-path", id, pathId, call);
    });
  },
  size(value) {
    if (
      !object(value) ||
      !finite(value.width) ||
      !finite(value.height) ||
      value.width <= 0 ||
      value.height <= 0
    )
      return;
    ipcRenderer.send("confirmation:size", { width: value.width, height: value.height });
  },
  answer(id, accepted) {
    if (!nonempty(id)) return;
    if (boolean(accepted)) ipcRenderer.send("confirmation:answer", id, accepted);
    else if (
      array(nonempty)(accepted) &&
      accepted.length > 0 &&
      new Set(accepted).size === accepted.length
    )
      ipcRenderer.send("confirmation:answer", id, Array.from(accepted));
  },
};
contextBridge.exposeInMainWorld("confirmation", api);
