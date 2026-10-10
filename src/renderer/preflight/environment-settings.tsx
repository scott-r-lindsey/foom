import { useEffect, useRef, useState } from "react";
import type { FocusEvent, Ref } from "react";
import type {
  EnvironmentApi,
  EnvironmentCandidate,
  EnvironmentRow,
  EnvironmentScope,
  EnvironmentState,
} from "../../shared/environment";
import {
  ENVIRONMENT_SCOPES,
  LOOPBACK,
  environmentProblem,
  foldName,
  hasUrlCredentials,
  isPathName,
  isProxyName,
  nameProblem,
} from "../../shared/environment-rules";
import { AgentBadge } from "../board/agent-badge";
import { message } from "./message";

const LABELS: Record<EnvironmentScope, { label: string; mark?: string }> = {
  all: { label: "All sessions" },
  claude: { label: "Claude Code", mark: "CC" },
  codex: { label: "Codex", mark: "CX" },
  agy: { label: "Antigravity", mark: "AG" },
};

/** A row being edited. `saved` is its name in main, or null before its first save. */
interface Draft {
  key: number;
  saved: string | null;
  name: string;
  /** Null while a saved secret stays masked. */
  value: string | null;
  secret: boolean;
  dirty: boolean;
  error: string;
}
type Drafts = Record<EnvironmentScope, Draft[]>;

let nextKey = 0;
function draft(row: EnvironmentRow): Draft {
  return { key: nextKey++, saved: row.name, ...row, dirty: false, error: "" };
}
function drafts(state: EnvironmentState): Drafts {
  const result = {} as Drafts;
  for (const scope of ENVIRONMENT_SCOPES) result[scope] = state.lists[scope].map(draft);
  return result;
}

function LockIcon() {
  return (
    <svg viewBox="0 0 14 14" aria-hidden="true">
      <rect x="3" y="6.5" width="8" height="5.5" rx="1" />
      <path d="M4.75 6.5V4.75a2.25 2.25 0 0 1 4.5 0V6.5" />
    </svg>
  );
}
function CrossIcon() {
  return (
    <svg viewBox="0 0 14 14" aria-hidden="true">
      <path d="M4 4l6 6M10 4l-6 6" />
    </svg>
  );
}

/**
 * Settings → Environment: one list for all sessions and one per agent, edited in place.
 * A valid row saves when focus leaves it. Main validates again and never returns a
 * saved secret; this view only shows the shared rules' reasons early.
 */
export function EnvironmentSettings({
  source,
  headingRef,
}: {
  source: EnvironmentApi;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const [state, setState] = useState<EnvironmentState>();
  const [lists, setLists] = useState<Drafts>();
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [candidates, setCandidates] = useState<readonly EnvironmentCandidate[] | "reading">();
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const statusTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    let active = true;
    void source.environmentState().then(
      (next) => {
        if (!active) return;
        setState(next);
        setLists(drafts(next));
      },
      (caught: unknown) => {
        if (active) setError(message(caught));
      },
    );
    return () => {
      active = false;
      clearTimeout(statusTimerRef.current);
    };
  }, [source]);

  if (!state || !lists)
    return (
      <>
        <h2 ref={headingRef} tabIndex={-1}>
          Environment
        </h2>
        {error && (
          <p className="preflight-error" role="alert">
            {error}
          </p>
        )}
      </>
    );

  const windows = state.windows;
  const fold = (name: string) => foldName(name, windows);
  const saved = () => {
    setStatus("Saved for new sessions");
    clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => {
      setStatus("");
    }, 2200);
  };
  const update = (scope: EnvironmentScope, key: number, change: Partial<Draft>) => {
    setLists((current) =>
      current
        ? {
            ...current,
            [scope]: current[scope].map((row) => (row.key === key ? { ...row, ...change } : row)),
          }
        : current,
    );
  };
  const drop = (scope: EnvironmentScope, key: number) => {
    setLists((current) =>
      current ? { ...current, [scope]: current[scope].filter((row) => row.key !== key) } : current,
    );
  };
  /** Takes main's rows for a scope, keeping unsaved edits to other rows. */
  const accept = (next: EnvironmentState, scope: EnvironmentScope, key?: number) => {
    setState(next);
    setLists((current) => {
      if (!current) return drafts(next);
      const kept = current[scope];
      const rows = next.lists[scope].map((row) => {
        const existing = kept.find(
          (entry) =>
            entry.key !== key &&
            entry.dirty &&
            entry.saved !== null &&
            fold(entry.saved) === fold(row.name),
        );
        const mine = kept.find((entry) => entry.key === key);
        if (existing) return existing;
        if (mine && fold(row.name) === fold(mine.name)) return { ...draft(row), key: mine.key };
        return draft(row);
      });
      const unsaved = kept.filter((entry) => entry.saved === null && entry.key !== key);
      return { ...current, [scope]: [...rows, ...unsaved] };
    });
  };

  const problem = (scope: EnvironmentScope, row: Draft, index: number): string => {
    if (row.error) return row.error;
    const name = row.name.trim();
    if (!name && !row.value) return "";
    if (!name) return "Enter a name";
    const reason =
      row.value === null ? nameProblem(name) : environmentProblem(name, row.value, windows);
    if (reason) return reason;
    if (lists[scope].some((other, j) => j < index && fold(other.name.trim()) === fold(name)))
      return `${name} is already in this list`;
    if ((row.secret || (row.value !== null && hasUrlCredentials(row.value))) && !state.secrets)
      return "Secrets need the system keychain, which is unavailable";
    return "";
  };

  const commit = async (scope: EnvironmentScope, row: Draft) => {
    const name = row.name.trim();
    if (!name && !row.value) {
      if (row.saved === null) {
        drop(scope, row.key);
        return;
      }
      try {
        accept(await source.removeEnvironment(scope, row.saved), scope);
        saved();
      } catch (caught) {
        update(scope, row.key, { error: message(caught) });
      }
      return;
    }
    const index = lists[scope].findIndex((entry) => entry.key === row.key);
    if (!row.dirty || problem(scope, row, index)) return;
    try {
      const next = await source.saveEnvironment({
        scope,
        previous: row.saved,
        name,
        value: row.value,
        secret: row.secret,
      });
      accept(next, scope, row.key);
      saved();
    } catch (caught) {
      update(scope, row.key, { error: message(caught) });
    }
  };

  const leave = (scope: EnvironmentScope, key: number) => (event: FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    const row = lists[scope].find((entry) => entry.key === key);
    if (row) void commit(scope, row);
  };

  const proxied = ENVIRONMENT_SCOPES.some((scope) =>
    lists[scope].some((row) => isProxyName(row.name.trim()) && row.value !== ""),
  );

  const rowView = (scope: EnvironmentScope, row: Draft, index: number) => {
    const reason = problem(scope, row, index);
    const name = row.name.trim();
    const label = name || "New variable";
    const forced =
      (row.value !== null && hasUrlCredentials(row.value)) ||
      (row.value === null && row.secret && isProxyName(name));
    const overrides =
      scope !== "all" &&
      name !== "" &&
      lists.all.some((other) => fold(other.name.trim()) === fold(name));
    const suffix = isPathName(name)
      ? windows
        ? ";%PATH%"
        : ":$PATH"
      : name.toUpperCase() === "NO_PROXY" && proxied
        ? `,${LOOPBACK.join(",")}`
        : "";
    const edit = (change: Partial<Draft>) => {
      const value = change.value ?? row.value;
      update(scope, row.key, {
        ...change,
        dirty: true,
        error: "",
        ...(value !== null && hasUrlCredentials(value) ? { secret: true } : {}),
      });
    };
    return (
      <div
        key={row.key}
        className={`environment-row${reason ? " invalid" : ""}`}
        data-environment-key={row.key}
        role="group"
        aria-label={label}
        onBlur={leave(scope, row.key)}
      >
        <div className="environment-name">
          <input
            value={row.name}
            placeholder="NAME"
            aria-label="Variable name"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              edit({ name: event.target.value.replace(/\s/g, "") });
            }}
          />
          {overrides && <span className="environment-tag">overrides all</span>}
        </div>
        {row.value === null ? (
          <div className="environment-masked">
            <span aria-label="Saved secret">••••••••</span>
            <button
              type="button"
              onClick={() => {
                edit({ value: "" });
              }}
            >
              Replace
            </button>
          </div>
        ) : (
          <div className="environment-value">
            <input
              type={row.secret ? "password" : "text"}
              value={row.value}
              placeholder="value"
              aria-label={`${label} value`}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => {
                edit({ value: event.target.value });
              }}
            />
            {suffix && <span className="environment-suffix">{suffix}</span>}
          </div>
        )}
        <button
          type="button"
          className="environment-icon"
          aria-label="Secret"
          title="Secret"
          aria-pressed={row.secret}
          disabled={forced || (!row.secret && !state.secrets)}
          onClick={() => {
            const secret = !row.secret;
            // A masked secret is never read back; making it plain needs a new value.
            edit(row.value === null ? { secret, value: "" } : { secret });
            if (row.saved !== null && row.value !== null && !reason)
              void commit(scope, { ...row, secret, dirty: true });
          }}
        >
          <LockIcon />
        </button>
        <button
          type="button"
          className="environment-icon"
          aria-label={`Remove ${label}`}
          title="Remove"
          onClick={() => {
            if (row.saved === null) drop(scope, row.key);
            else void commit(scope, { ...row, name: "", value: "" });
          }}
        >
          <CrossIcon />
        </button>
        {reason && (
          <div className="environment-error" role="alert">
            {reason}
          </div>
        )}
      </div>
    );
  };

  const readShell = async () => {
    setCandidates("reading");
    setError("");
    try {
      const found = await source.readShellEnvironment();
      setCandidates(found);
      setPicked(
        new Set(found.filter((entry) => entry.status === "new").map((entry) => entry.name)),
      );
    } catch (caught) {
      setCandidates(undefined);
      setError(message(caught));
    }
  };

  return (
    <>
      <div className="environment-head">
        <h2 ref={headingRef} tabIndex={-1}>
          Environment
        </h2>
        <span className="environment-status" role="status">
          {status}
        </span>
        <span className="environment-grow" />
        <button type="button" disabled={candidates !== undefined} onClick={() => void readShell()}>
          Import from login shell
        </button>
      </div>
      {candidates === "reading" && <p className="environment-reading">Reading login shell…</p>}
      {candidates !== undefined && candidates !== "reading" && (
        <div className="environment-import" role="group" aria-label="Import from login shell">
          {candidates.map((entry) => (
            <label key={entry.name} className="environment-pick">
              <input
                type="checkbox"
                checked={picked.has(entry.name)}
                onChange={(event) => {
                  const next = new Set(picked);
                  if (event.target.checked) next.add(entry.name);
                  else next.delete(entry.name);
                  setPicked(next);
                }}
              />
              <span>{entry.name}</span>
              <span className="environment-candidate">{entry.display}</span>
              <span className="environment-tag">
                {entry.status === "same"
                  ? "already set"
                  : entry.status === "replaces"
                    ? "replaces yours"
                    : ""}
              </span>
            </label>
          ))}
          {candidates.length === 0 && <p className="environment-reading">Nothing to import</p>}
          <div className="environment-actions">
            <button
              type="button"
              className="primary"
              disabled={picked.size === 0}
              onClick={() => {
                void source.importEnvironment([...picked]).then(
                  (next) => {
                    accept(next, "all");
                    setCandidates(undefined);
                    saved();
                  },
                  (caught: unknown) => {
                    setError(message(caught));
                  },
                );
              }}
            >
              Add selected
            </button>
            <button
              type="button"
              onClick={() => {
                setCandidates(undefined);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="preflight-error" role="alert">
          {error}
        </p>
      )}
      {ENVIRONMENT_SCOPES.map((scope) => (
        <section key={scope} className="environment-scope" aria-label={LABELS[scope].label}>
          <h3>
            {LABELS[scope].mark && <AgentBadge mark={LABELS[scope].mark} />}
            {LABELS[scope].label}
          </h3>
          <div className="environment-rows">
            {lists[scope].map((row, index) => rowView(scope, row, index))}
            {scope === "all" &&
              proxied &&
              !lists.all.some((row) => row.name.trim().toUpperCase() === "NO_PROXY") && (
                <div className="environment-row locked" aria-label="Added by Foom">
                  <span>NO_PROXY</span>
                  <span>{LOOPBACK.join(",")}</span>
                </div>
              )}
            <div className="environment-row blank">
              <div className="environment-name">
                <input
                  value=""
                  placeholder="NAME"
                  aria-label={`New ${LABELS[scope].label} variable name`}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => {
                    const key = nextKey++;
                    setLists((current) =>
                      current
                        ? {
                            ...current,
                            [scope]: [
                              ...current[scope],
                              {
                                key,
                                saved: null,
                                name: event.target.value.replace(/\s/g, ""),
                                value: "",
                                secret: false,
                                dirty: true,
                                error: "",
                              },
                            ],
                          }
                        : current,
                    );
                    requestAnimationFrame(() => {
                      const input = document.querySelector<HTMLInputElement>(
                        `[data-environment-key="${String(key)}"] input`,
                      );
                      input?.focus();
                      input?.setSelectionRange(input.value.length, input.value.length);
                    });
                  }}
                />
              </div>
            </div>
          </div>
        </section>
      ))}
    </>
  );
}
