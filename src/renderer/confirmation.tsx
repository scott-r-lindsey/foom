import { ApprovalGeometry } from "./approval-geometry";
import { applyInterfaceTypography, interfaceGradientCss } from "./ui/interface-theme";
import { interfaceColorNames, interfaceHighlightNames } from "../shared/interface-themes";
import { CopyValue } from "./ui/copy-value";
import {
  createContext,
  use,
  useEffect,
  useRef,
  useState,
  useCallback,
  useLayoutEffect,
} from "react";
import { createRoot } from "react-dom/client";
import type { DialogRequest, ApprovalRow } from "../shared/confirmation";
const stateLabels: Readonly<Record<string, string>> = {
  working: "Working",
  needs_input: "Needs you",
  done: "Done",
  failed: "Failed",
  quiet_ok: "Quiet",
  dormant: "Dormant",
};
const glyphPaths = {
  trash: "M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5",
  branch: "M4 2v12M4 9c0-2 3-2.5 4.5-3.5M10.5 9.5l4 4M14.5 9.5l-4 4",
  power: "M8 1.8v6M4.4 4a5.2 5.2 0 1 0 7.2 0",
  orbit: "M8 5.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4M2 10c-3-4 9-9 12-4s-9 9-12 4",
  link: "M6.5 9.5l3-3M7 4.5l1.2-1.2a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2M9 11.5l-1.2 1.2a2.6 2.6 0 0 1-3.7-3.7l1.2-1.2",
  shield: "M8 1.8l5 2v4c0 3.2-2.2 5.3-5 6.4-2.8-1.1-5-3.2-5-6.4v-4zM6 6l4 4M10 6l-4 4",
  bell: "M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3zM6.5 14h3",
  check: "M3 8.5l3 3 7-7",
  dash: "M4 8h8",
  dot: "M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5",
  ring: "M8 2.5a5.5 5.5 0 1 1-5.5 5.5",
  square: "M4 4h8v8H4z",
  warning: "M8 2l6 12H2zM8 6v4M8 12h.01",
  swap: "M3 5h9.5M10 2.5L12.5 5 10 7.5M13 11H3.5M6 8.5L3.5 11 6 13.5",
};
function Glyph({ name }: { name: keyof typeof glyphPaths }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={name === "ring" ? "spin" : undefined}>
      <path d={glyphPaths[name]} />
    </svg>
  );
}
function Section({
  label,
  count,
  children,
}: {
  label: string;
  count?: number | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="section">
      <h2 className="label">
        {label}
        {count !== undefined && <span className="n">{count}</span>}
      </h2>
      {children}
    </div>
  );
}
const CopyPathContext = createContext<((id: string) => Promise<void>) | undefined>(undefined);
function CopyPath({ value, pathId }: { value: string; pathId: string }) {
  const copy = use(CopyPathContext);
  return (
    <CopyValue
      value={value}
      label="Copy path"
      copy={() => copy?.(pathId) ?? Promise.reject(new Error("Copy unavailable"))}
    />
  );
}
function Changes({
  value,
  omitted = 0,
  prefix = "change",
}: {
  value: string;
  omitted?: number | undefined;
  prefix?: string;
}) {
  const records = value.split("\0").filter(Boolean);
  const items = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    const renamed = /[RC]/u.test(status);
    const label =
      status === "??"
        ? "untracked"
        : status === "!!"
          ? "ignored"
          : status.includes("R")
            ? "renamed"
            : status.includes("C")
              ? "copied"
              : status.includes("D")
                ? "deleted"
                : status.includes("A")
                  ? "added"
                  : status.includes("U")
                    ? "unmerged"
                    : "modified";
    items.push({
      index,
      path: record.slice(3),
      label,
      old: renamed ? records[++index] : undefined,
    });
  }
  return (
    <Section label="Discarded" count={items.length + omitted}>
      <ul className="well" aria-label="Uncommitted changes">
        {items.map((item) => (
          <li className="row change" key={item.path}>
            <span className="chip">{item.label}</span>
            <span className="name">
              <CopyPath value={item.path} pathId={`${prefix}:${String(item.index)}`} />
              {item.old !== undefined && (
                <span className="sub">
                  ← <CopyPath value={item.old} pathId={`${prefix}:${String(item.index + 1)}`} />
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {omitted > 0 && <p className="sub">{omitted} more paths</p>}
    </Section>
  );
}
function Worktrees({
  items,
  running = false,
  label,
}: {
  items: readonly {
    id?: string;
    branch: string;
    reason?: string;
    state?: string;
    changes?: string;
    omittedChanges?: number;
  }[];
  running?: boolean;
  label: string;
}) {
  return (
    <ul className="well" aria-label={label}>
      {items.map((item) => (
        <li className="row" key={item.id ?? item.branch} data-cleanup={item.state}>
          <span className="ic">
            <Glyph
              name={
                item.state === "removed"
                  ? "check"
                  : item.state === "removing"
                    ? "ring"
                    : item.state === "error"
                      ? "square"
                      : item.reason
                        ? "dash"
                        : "dot"
              }
            />
          </span>
          <div className="name">
            {item.branch}
            {item.changes && (
              <Changes
                value={item.changes}
                omitted={item.omittedChanges}
                prefix={`cleanup-change:${item.id ?? ""}`}
              />
            )}
          </div>
          <span className="why">
            {item.state === "error"
              ? "removal failed"
              : running && item.state === "removed"
                ? `removed${item.reason ? ` · ${item.reason}` : ""}`
                : (item.reason ?? (running ? item.state : ""))}
          </span>
        </li>
      ))}
    </ul>
  );
}
export function ConfirmationPage() {
  const [request, setRequest] = useState<DialogRequest | null>(null);
  const [updatedAt, setUpdatedAt] = useState(Date.now);
  useEffect(() => {
    // The hidden page has no text before its first request. Start loading the
    // default faces before the presentation guard starts. The card still waits
    // for the fonts used by the request before reporting its size.
    void Promise.allSettled([
      document.fonts.load('400 13px "Geist"'),
      document.fonts.load('400 12px "Geist Mono"'),
    ]);
    return window.confirmation.render((value) => {
      setUpdatedAt(Date.now());
      setRequest(value);
    });
  }, []);
  return request?.approvals ? (
    <ApprovalQueue request={request} updatedAt={updatedAt} />
  ) : (
    <ConfirmationCard key={request?.id} request={request} updatedAt={updatedAt} />
  );
}
export function ConfirmationCard({
  request,
  embedded = false,
  updatedAt = 0,
  canDecide,
}: {
  request: DialogRequest | null;
  embedded?: boolean;
  updatedAt?: number;
  canDecide?: () => boolean;
}) {
  const cardRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const acceptRef = useRef<HTMLButtonElement>(null);
  const [closeWhenCompleted, setCloseWhenCompleted] = useState(true);
  const closedIdRef = useRef<string | undefined>(undefined);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [nowTick, setNowTick] = useState(Date.now);
  const now = Math.max(nowTick, updatedAt);
  useEffect(() => {
    if (!request) return;
    const colors = { ...request.theme.colors, ...request.theme.areas?.dialogs };
    for (const key of [...interfaceColorNames, ...interfaceHighlightNames]) {
      const color = colors[key];
      if (color) document.documentElement.style.setProperty(`--${key}`, color);
    }
    applyInterfaceTypography(request.theme, document.documentElement);
    const header = cardRef.current?.querySelector<HTMLElement>(".dlg-head");
    if (header) {
      const area = request.theme.areas?.["dialog-headers"];
      const palette = area ? { ...request.theme.colors, ...area } : undefined;
      for (const key of [...interfaceColorNames, ...interfaceHighlightNames]) {
        const color =
          palette?.[key] ??
          (key === "highlight"
            ? palette?.accent
            : key === "highlight-deep"
              ? palette?.["accent-deep"]
              : undefined);
        if (color) header.style.setProperty(`--${key}`, color);
        else header.style.removeProperty(`--${key}`);
      }
      header.style.backgroundImage = interfaceGradientCss(area?.gradient) ?? "";
      header.style.backgroundColor = area ? "var(--bg)" : "";
    }
    document.documentElement.style.setProperty("--highlight", colors.highlight ?? colors.accent);
    document.documentElement.style.setProperty(
      "--highlight-deep",
      colors["highlight-deep"] ?? colors["accent-deep"],
    );
    const style = document.documentElement.style;
    for (const key of ["radius", "panel-radius", "border", "shadow"] as const) {
      const value =
        request.theme.shape?.[key] ??
        (key === "panel-radius" ? request.theme.shape?.radius : undefined);
      if (value === undefined) style.removeProperty(`--shape-${key}`);
      else style.setProperty(`--shape-${key}`, `${String(value)}${key === "shadow" ? "" : "px"}`);
    }
    for (const key of ["selected", "hover", "focus", "scrollbar"] as const) {
      const value = request.theme.states?.[key];
      if (value === undefined) style.removeProperty(`--state-${key}`);
      else style.setProperty(`--state-${key}`, value);
    }
    document.documentElement.style.colorScheme = request.theme.base;
  }, [request]);
  const deadline = request?.pairing?.expiresAt;
  const fetchedAt = request?.cleanup?.fetchedAt;
  useEffect(() => {
    if (deadline === undefined && fetchedAt === undefined) return;
    const timer = window.setInterval(() => {
      setNowTick(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [deadline, fetchedAt]);
  const wide = Boolean(
    request?.cleanup ||
      request?.worktrees ||
      request?.removals ||
      request?.changes ||
      request?.sessions ||
      request?.sections,
  );
  const bounded = request?.sections?.some((section) => section.summary !== undefined) ?? false;
  const requestId = request?.id;
  useEffect(() => {
    if (!requestId || embedded) return;
    // Native activation can select its own first tab stop after showing the
    // measured window. Keep the safe default until the user's first interaction.
    let initial = true;
    const focusCancel = () => {
      if (initial && document.activeElement !== cancelRef.current) cancelRef.current?.focus();
    };
    const interacted = () => {
      initial = false;
    };
    window.addEventListener("focus", focusCancel);
    document.addEventListener("focusin", focusCancel);
    document.addEventListener("keydown", interacted, true);
    document.addEventListener("pointerdown", interacted, true);
    focusCancel();
    return () => {
      window.removeEventListener("focus", focusCancel);
      document.removeEventListener("focusin", focusCancel);
      document.removeEventListener("keydown", interacted, true);
      document.removeEventListener("pointerdown", interacted, true);
    };
  }, [requestId, embedded]);
  useEffect(() => {
    const card = cardRef.current;
    const body = bodyRef.current;
    if (!requestId || !card || !body || embedded) return;
    const measure = () => {
      // Keep the natural body height even when its viewport is clamped and scrolling.
      // Fractional heights: rounded ones change with the clamped viewport under zoom,
      // and each new size would resize the window again.
      const content = body.parentElement;
      if (!content) return;
      const height = (element: Element) => element.getBoundingClientRect().height;
      window.confirmation.size({
        width: wide ? 540 : 500,
        height: Math.min(height(card) - height(content) + height(body), bounded ? 800 : Infinity),
      });
    };
    const observer = new ResizeObserver(measure);
    let cancelled = false;
    // A font swap changes wrapping and height even if the viewport is unchanged.
    // Force layout to start the bundled font loads before awaiting the font set.
    card.getBoundingClientRect();
    void document.fonts.ready.then(() => {
      if (cancelled) return;
      observer.observe(card);
      observer.observe(body);
      measure();
    });
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [requestId, wide, bounded, embedded]);
  useEffect(() => {
    const cleanup = request?.cleanup;
    if (
      request &&
      closeWhenCompleted &&
      cleanup?.stage === "run" &&
      cleanup.progress.phase === "finished" &&
      !cleanup.error &&
      cleanup.progress.total > 0 &&
      cleanup.progress.items.filter((item) => item.state === "removed").length ===
        cleanup.progress.total &&
      closedIdRef.current !== request.id
    ) {
      closedIdRef.current = request.id;
      window.confirmation.answer(request.id, false);
    }
  }, [request, closeWhenCompleted]);
  if (!request) return null;
  const plugin = request.pluginSetup;
  const cleanup = request.cleanup;
  const forceCleanup =
    cleanup?.stage === "ready" &&
    cleanup.progress.items.some((item) => item.state === "queued" && item.changes);
  const running = cleanup?.stage === "run";
  const finished = running && cleanup.progress.phase === "finished";
  const disabled =
    !request.presented ||
    cleanup?.stage === "checking" ||
    (cleanup?.stage === "ready" && cleanup.progress.total === 0) ||
    (running && cleanup.progress.stopped);
  const answer = (accepted: boolean) => {
    if (plugin?.phase === "running") return;
    window.confirmation.answer(
      request.id,
      accepted && request.removals ? request.removals.map((item) => item.id) : accepted,
    );
  };
  const content = (
    <main
      onKeyDown={(event) => {
        if (embedded) return;
        if (event.key === "Escape" && event.isTrusted) {
          event.preventDefault();
          answer(false);
        }
        if (event.key === "Tab") {
          event.preventDefault();
          const content = bodyRef.current?.parentElement;
          const targets = Array.from(
            cardRef.current?.querySelectorAll<HTMLElement>("*") ?? [],
          ).filter(
            (element) =>
              element.matches(
                "button:not(:disabled), input:not(:disabled), summary, code[tabindex]",
              ) &&
              (element.tagName === "SUMMARY" || !element.closest("details:not([open])")),
          );
          const focusable =
            content && content.scrollHeight > content.clientHeight
              ? [...targets, content]
              : targets;
          const index = focusable.findIndex((element) => element === document.activeElement);
          focusable[
            (index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length
          ]?.focus();
        }
      }}
    >
      <section
        ref={cardRef}
        key={request.id}
        className={`confirmation-window${wide ? " wide" : ""}${bounded ? " bounded" : ""}`}
        role={embedded ? "group" : "alertdialog"}
        aria-modal={embedded ? undefined : true}
        aria-labelledby={`confirmation-title-${request.id}`}
      >
        <header className="dlg-head">
          <span className="glyph">
            <Glyph
              name={
                request.glyph ??
                (cleanup || request.worktrees
                  ? "trash"
                  : request.changes
                    ? "branch"
                    : request.sessions
                      ? "power"
                      : "shield")
              }
            />
          </span>
          <h1 id={`confirmation-title-${request.id}`}>
            {running ? "Deleting merged worktrees" : request.title}
          </h1>
          <p className="subject">
            <b>{request.subject}</b>
            {cleanup?.stage === "checking"
              ? " · fetching remote…"
              : cleanup?.stage === "ready" && fetchedAt !== undefined
                ? ` · fetched ${String(Math.max(0, Math.floor((now - fetchedAt) / 1000)))} s ago`
                : ""}
            {request.subject && deadline !== undefined ? " · " : ""}
            {deadline !== undefined
              ? `Expires in ${String(Math.max(0, Math.ceil((deadline - now) / 1000)))} s`
              : ""}
          </p>
        </header>
        <div className="confirmation-content" tabIndex={0} role="region" aria-label="Details">
          <div ref={bodyRef}>
            {plugin && (
              <div className="plugin-progress" aria-live="polite">
                {plugin.phase !== "success" && (
                  <ol aria-label="Plugin setup steps">
                    {plugin.steps.map((step) => (
                      <li key={step.id} data-state={step.state}>
                        <span aria-label={step.state}>
                          {step.state === "done"
                            ? "✓"
                            : step.state === "running"
                              ? "●"
                              : step.state === "failed"
                                ? "×"
                                : "○"}
                        </span>
                        {step.label}
                      </li>
                    ))}
                  </ol>
                )}
                {plugin.receipt && (
                  <p className={`plugin-receipt ${plugin.phase}`}>
                    <span aria-hidden="true">{plugin.phase === "success" ? "✓ " : "× "}</span>
                    {plugin.receipt}
                  </p>
                )}
                {plugin.phase !== "running" && (
                  <>
                    <p className="plugin-location">{plugin.location}</p>
                    {plugin.commands.map((command, index) => (
                      <p
                        className="plugin-command"
                        title={command.title}
                        aria-label={
                          command.title
                            ? `${command.title} · ${command.exit === null ? "no exit status" : `exit ${String(command.exit)}`} · ${(command.durationMs / 1000).toFixed(1)} s`
                            : undefined
                        }
                        key={`${String(index)}:${command.command}`}
                      >
                        {command.command} ·{" "}
                        {command.exit === null ? "no exit status" : `exit ${String(command.exit)}`}{" "}
                        · {(command.durationMs / 1000).toFixed(1)} s
                      </p>
                    ))}
                  </>
                )}
              </div>
            )}
            {cleanup && (
              <div className="cleanup" aria-live="polite">
                {cleanup.error && <p>{cleanup.error}</p>}
                {running && (
                  <div className="progress">
                    <div className="meta">
                      <span>
                        {finished
                          ? "Finished"
                          : cleanup.progress.stopped
                            ? "Finishing in-flight removals…"
                            : cleanup.progress.phase === "fetch"
                              ? "Fetching remote…"
                              : "Removing worktrees…"}
                      </span>
                      <span>
                        {cleanup.progress.done} / {cleanup.progress.total}
                      </span>
                    </div>
                    <progress
                      aria-label="Cleanup progress"
                      value={cleanup.progress.done}
                      max={Math.max(1, cleanup.progress.total)}
                    />
                  </div>
                )}
                {cleanup.stage === "checking" ? (
                  <Section label="Checking" count={cleanup.checkingCount}>
                    <ul className="well" aria-busy="true" aria-label="Checking worktrees">
                      {[0, 1, 2].map((index) => (
                        <li className="row" key={index}>
                          <span className="ic">{index === 0 && <Glyph name="ring" />}</span>
                          <span className="skeleton" />
                        </li>
                      ))}
                    </ul>
                  </Section>
                ) : (
                  <>
                    <Section
                      label="Delete"
                      count={cleanup.progress.items.filter((item) => item.state !== "kept").length}
                    >
                      <Worktrees
                        label="Cleanup checklist"
                        running={running}
                        items={cleanup.progress.items.filter((item) => item.state !== "kept")}
                      />
                    </Section>
                    <Section
                      label={running ? "Kept" : "Keep"}
                      count={cleanup.progress.items.filter((item) => item.state === "kept").length}
                    >
                      <Worktrees
                        label="Kept worktrees"
                        items={cleanup.progress.items.filter((item) => item.state === "kept")}
                      />
                    </Section>
                  </>
                )}
              </div>
            )}
            {request.note && (
              <div className="note">
                <Glyph name="swap" />
                <span>{request.note}</span>
              </div>
            )}
            {request.pairing && (
              <div className="code">
                <strong>{request.pairing.code}</strong>
                <span>Check that this matches your CLI</span>
              </div>
            )}
            {request.facts && (
              <dl className="facts">
                {request.facts.map((fact) => (
                  <div key={fact.label}>
                    <dt>{fact.label}</dt>
                    <dd className={fact.mono ? "mono" : undefined}>
                      {request.worktreePath === fact.value ? (
                        <CopyPath value={fact.value} pathId="worktree" />
                      ) : (
                        fact.value
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {request.arguments && (
              <div className="args">
                {request.arguments.map((argument) => (
                  <code key={argument}>{argument}</code>
                ))}
              </div>
            )}
            {bounded && request.detail !== undefined && <p className="prose">{request.detail}</p>}
            {request.sections?.map((section) => {
              const contents = section.arguments ? (
                <div className="argument-lines">
                  {section.items.map((item, index) => (
                    <code
                      key={`${String(index)}:${item}`}
                      tabIndex={section.summary ? 0 : undefined}
                    >
                      {item}
                    </code>
                  ))}
                </div>
              ) : (
                <ul className="points">
                  {section.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              );
              return section.summary ? (
                <details className="disclosure" key={section.label}>
                  <summary
                    aria-label={[
                      section.label,
                      ...section.summary.map((line) => line.title ?? line.text),
                    ].join(" ")}
                  >
                    <span className="label">{section.label}</span>
                    {section.summary.map((line) => (
                      <span className="disclosure-summary" key={line.text} title={line.title}>
                        {line.text}
                      </span>
                    ))}
                  </summary>
                  {contents}
                </details>
              ) : (
                <Section key={section.label} label={section.label}>
                  {contents}
                </Section>
              );
            })}
            {!bounded && request.detail !== undefined && <p className="prose">{request.detail}</p>}
            {request.quiet && <p className="prose quiet">{request.quiet}</p>}
            {request.reply && (
              <>
                <p>Current child context (untrusted)</p>
                <pre aria-label="Current child context">{request.reply.context}</pre>
                <p>Exact proposed reply</p>
                <pre aria-label="Exact proposed reply">{request.reply.text}</pre>
              </>
            )}
            {request.removals && (
              <Section label="Worktrees" count={request.removals.length}>
                <ul className="well" aria-label="Worktrees to remove">
                  {request.removals.map((item) => (
                    <li key={item.id} data-dirty={Boolean(item.changes)}>
                      <div className="row">
                        <input
                          id={`${request.id}-${item.id}`}
                          type="checkbox"
                          aria-label={item.branch}
                          disabled={!request.presented}
                          checked={selected.includes(item.id)}
                          onChange={(event) => {
                            setSelected(
                              event.target.checked
                                ? [...selected, item.id]
                                : selected.filter((id) => id !== item.id),
                            );
                          }}
                        />
                        <span className="name">
                          <label htmlFor={`${request.id}-${item.id}`}>{item.branch}</label>
                          <span className="sub">
                            <CopyPath value={item.path} pathId={`removal:${item.id}`} />
                          </span>
                          {item.pullRequest && (
                            <span className="sub">
                              PR #{item.pullRequest.number} · {item.pullRequest.state}
                            </span>
                          )}
                        </span>
                        <span className="why">
                          {item.changes && <Glyph name="warning" />}
                          {item.changes ? "Dirty" : "Clean"}
                        </span>
                      </div>
                      {item.changes && (
                        <Changes value={item.changes} prefix={`removal-change:${item.id}`} />
                      )}
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            {request.changes !== undefined && <Changes value={request.changes} />}
            {request.worktrees && !cleanup && (
              <>
                <Section
                  label="Delete"
                  count={request.worktrees.filter((item) => !item.reason).length}
                >
                  <Worktrees
                    label="Worktrees to delete"
                    items={request.worktrees.filter((item) => !item.reason)}
                  />
                </Section>
                <Section
                  label="Keep"
                  count={request.worktrees.filter((item) => item.reason).length}
                >
                  <Worktrees
                    label="Skipped worktrees"
                    items={request.worktrees.filter((item) => item.reason)}
                  />
                </Section>
              </>
            )}
            {request.sessions && (
              <ul className="well">
                {request.sessions.map((item) => (
                  <li className="row sans" key={item.id}>
                    <span
                      className="confirmation-light"
                      data-state={item.state}
                      role="img"
                      aria-label={stateLabels[item.state] ?? "Quiet"}
                    />
                    <span className="name">
                      {item.name}
                      <span className="sub">{item.location}</span>
                    </span>
                    <span className="why" data-state={item.state}>
                      {stateLabels[item.state] ?? "Quiet"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <footer>
          {cleanup && !finished && (
            <label className="close-when-completed">
              <input
                type="checkbox"
                checked={closeWhenCompleted}
                onChange={(event) => {
                  setCloseWhenCompleted(event.target.checked);
                }}
              />
              Close when completed
            </label>
          )}
          <button
            type="button"
            ref={cancelRef}
            disabled={(embedded && !request.presented) || plugin?.phase === "running"}
            data-approval-decision={embedded ? request.id : undefined}
            onClick={(event) => {
              if (event.isTrusted && (canDecide?.() ?? true)) answer(false);
            }}
          >
            {plugin
              ? plugin.phase === "running"
                ? "Close"
                : "Done"
              : embedded || request.removals
                ? "Decline"
                : finished
                  ? "Done"
                  : running
                    ? "Hide"
                    : (request.cancel ?? "Cancel")}
          </button>
          {request.removals && (
            <button
              type="button"
              data-approval-decision={embedded ? request.id : undefined}
              disabled={
                !request.presented || !request.removals.some((item) => selected.includes(item.id))
              }
              onClick={(event) => {
                if (!event.isTrusted || !(canDecide?.() ?? true)) return;
                window.confirmation.answer(
                  request.id,
                  request.removals
                    ?.filter((item) => selected.includes(item.id))
                    .map((item) => item.id) ?? [],
                );
              }}
            >
              {request.removals.some((item) => item.changes && selected.includes(item.id))
                ? "Discard changes and remove selected"
                : "Approve selected"}
            </button>
          )}
          {!finished && !plugin && (
            <button
              type="button"
              disabled={disabled || (deadline !== undefined && now >= deadline)}
              ref={acceptRef}
              className="confirmation-accept"
              aria-label={embedded ? `Approve · ${request.accept}` : undefined}
              data-approval-decision={embedded ? request.id : undefined}
              onClick={(event) => {
                if (event.isTrusted && (canDecide?.() ?? true)) answer(true);
              }}
            >
              {running
                ? "Stop"
                : cleanup
                  ? cleanup.stage === "checking"
                    ? "Delete"
                    : `${forceCleanup ? "Force delete" : "Delete"} ${String(cleanup.progress.total)}`
                  : request.removals?.some((item) => item.changes)
                    ? "Discard changes and remove all"
                    : embedded
                      ? "Approve"
                      : request.accept}
            </button>
          )}
        </footer>
      </section>
    </main>
  );
  return (
    <CopyPathContext value={(pathId) => window.confirmation.copyPath(request.id, pathId)}>
      {content}
    </CopyPathContext>
  );
}
const noApprovals: readonly ApprovalRow[] = [];
export function ApprovalQueue({
  request,
  updatedAt,
}: {
  request: DialogRequest;
  updatedAt: number;
}) {
  const rootRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState<readonly string[]>([]);
  const rows = request.approvals ?? noApprovals;
  const hideRef = useRef<HTMLButtonElement>(null);
  const [geometry] = useState(() => new ApprovalGeometry());
  const [blocked, setBlocked] = useState<readonly string[]>([]);
  const gestureRef = useRef<readonly string[]>([]);
  type Slot = { id: string; row: ApprovalRow | undefined; height: number; expiresAt: number };
  const [presentation, setPresentation] = useState<{
    source: readonly ApprovalRow[];
    slots: Slot[];
  }>(() => ({
    source: rows,
    slots: rows.map((row) => ({ id: row.request.id, row, height: 0, expiresAt: Infinity })),
  }));
  let slots = presentation.slots;
  // Reconcile before commit, retaining the old DOM footprint as an inert slot.
  if (presentation.source !== rows) {
    const current = new Map(rows.map((row) => [row.request.id, row]));
    slots = presentation.slots.map((slot) => {
      const row = current.get(slot.id);
      current.delete(slot.id);
      if (row) return { ...slot, row };
      if (!slot.row) return slot;
      return {
        ...slot,
        row: undefined,
        height: document.getElementById(`approval-${slot.id}`)?.getBoundingClientRect().height ?? 0,
        expiresAt: updatedAt + 900,
      };
    });
    slots.push(
      ...[...current.values()].map((row) => ({
        id: row.request.id,
        row,
        height: 0,
        expiresAt: Infinity,
      })),
    );
    setPresentation({ source: rows, slots });
  }
  useLayoutEffect(() => {
    if (document.activeElement === document.body && slots.some((slot) => !slot.row))
      hideRef.current?.focus();
  }, [slots]);
  useEffect(() => {
    const expiresAt = Math.min(...slots.map((slot) => slot.expiresAt));
    if (!Number.isFinite(expiresAt)) return;
    const timer = window.setTimeout(
      () => {
        setPresentation((previous) => ({
          ...previous,
          slots: previous.slots.filter((slot) => slot.expiresAt > Date.now()),
        }));
      },
      Math.max(0, expiresAt - Date.now()),
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [slots]);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let timer: number | undefined;
    const update = () => {
      window.clearTimeout(timer);
      const state = geometry.read(root, request.geometryRevision);
      setBlocked((previous) =>
        previous.length === state.blocked.length &&
        previous.every((id, index) => id === state.blocked[index])
          ? previous
          : state.blocked,
      );
      if (Number.isFinite(state.delay)) timer = window.setTimeout(update, state.delay);
    };
    timer = window.setTimeout(update, 0);
    const observer = new ResizeObserver(update);
    observer.observe(root);
    for (const control of root.querySelectorAll("button[data-approval-decision]"))
      observer.observe(control);
    root.addEventListener("scroll", update, true);
    root.addEventListener("toggle", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
      root.removeEventListener("scroll", update, true);
      root.removeEventListener("toggle", update, true);
      window.removeEventListener("resize", update);
    };
  });
  const ready = useCallback(
    (id: string) => {
      const root = rootRef.current;
      return root !== null && geometry.ready(root, id, request.geometryRevision);
    },
    [geometry, request.geometryRevision],
  );
  useEffect(() => {
    const focusSafe = () => {
      hideRef.current?.focus();
    };
    const restoreSafeDefault = () => {
      if (document.hasFocus() && document.activeElement === document.body) focusSafe();
    };
    const clearGesture = () => {
      gestureRef.current = [];
    };
    window.addEventListener("focus", focusSafe);
    document.addEventListener("focusin", restoreSafeDefault);
    restoreSafeDefault();
    window.addEventListener("blur", clearGesture);
    return () => {
      window.removeEventListener("focus", focusSafe);
      document.removeEventListener("focusin", restoreSafeDefault);
      window.removeEventListener("blur", clearGesture);
    };
  }, []);
  const onScreen = useCallback(() => {
    const viewport = scrollRef.current?.getBoundingClientRect();
    if (!viewport) return [];
    return rows
      .filter((row) => {
        const item = document.getElementById(`approval-${row.request.id}`)?.getBoundingClientRect();
        return (
          row.kind === "Worktree removal" &&
          row.request.presented &&
          ready(row.request.id) &&
          item &&
          item.top >= viewport.top &&
          item.bottom <= viewport.bottom
        );
      })
      .map((row) => row.request.id);
  }, [rows, ready]);
  useEffect(() => {
    const element = rootRef.current;
    const content = scrollRef.current;
    if (!element || !content) return;
    const update = () => {
      setVisible(onScreen());
      window.confirmation.size({
        width: 750,
        height: Math.min(
          720,
          element.getBoundingClientRect().height -
            content.getBoundingClientRect().height +
            Array.from(content.children).reduce(
              (sum, child) => sum + child.getBoundingClientRect().height,
              0,
            ),
        ),
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    observer.observe(content);
    content.addEventListener("scroll", update);
    content.addEventListener("toggle", update, true);
    let alive = true;
    void document.fonts.ready.then(() => {
      if (alive) update();
    });
    return () => {
      alive = false;
      observer.disconnect();
      content.removeEventListener("scroll", update);
      content.removeEventListener("toggle", update, true);
    };
  }, [onScreen, blocked, slots]);
  return (
    <main
      className="approval-queue"
      role="dialog"
      aria-modal="false"
      aria-labelledby="approval-title"
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          window.confirmation.hideApprovals();
        }
      }}
    >
      <header className="approval-head">
        <div>
          <h1 id="approval-title">
            {rows.length} {rows.length === 1 ? "approval" : "approvals"} waiting
          </h1>
          <p>Requests from agents and background work</p>
        </div>
        <button
          type="button"
          ref={hideRef}
          onClick={() => {
            window.confirmation.hideApprovals();
          }}
        >
          Hide
        </button>
      </header>
      <div className="approval-bulk">
        <div>
          <strong>Worktree removals</strong>
          <p>Only fully visible, ready rows. Other kinds need individual approval.</p>
        </div>
        <button
          type="button"
          data-approval-decision="bulk"
          // Preserve a held keyboard gesture while a native resize re-arms the guard.
          // Both renderer and main still refuse decisions during this disabled interval.
          aria-disabled={!visible.length || blocked.includes("bulk")}
          onPointerDown={(event) => {
            gestureRef.current =
              event.isTrusted && event.button === 0 && ready("bulk") ? onScreen() : [];
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            if (event.repeat) {
              event.preventDefault();
              return;
            }
            gestureRef.current = event.isTrusted && ready("bulk") ? onScreen() : [];
          }}
          onPointerCancel={() => {
            gestureRef.current = [];
          }}
          onBlur={() => {
            gestureRef.current = [];
          }}
          onClick={(event) => {
            const captured = gestureRef.current;
            gestureRef.current = [];
            if (!event.isTrusted || !ready("bulk")) return;
            const valid = onScreen();
            const ids = captured.filter((id) => valid.includes(id));
            if (ids.length) window.confirmation.answer(request.id, ids);
          }}
        >
          Approve all visible removals ({visible.length})
        </button>
      </div>
      <div
        className="approval-scroll"
        ref={scrollRef}
        tabIndex={0}
        role="region"
        aria-label="Pending approvals"
      >
        {slots.map(({ id, row, height }) =>
          row ? (
            <article className="approval-row" id={`approval-${id}`} key={id}>
              <div className="approval-origin">
                <span>{row.origin}</span>
                <span className="chip">{row.kind}</span>
              </div>
              <ConfirmationCard
                request={{
                  ...row.request,
                  presented: row.request.presented && !blocked.includes(id),
                  theme: request.theme,
                }}
                embedded
                canDecide={() => ready(id)}
              />
              <p className="approval-status">
                {!row.request.presented || blocked.includes(id)
                  ? "Buttons ready shortly"
                  : row.repeats > 1
                    ? `Repeated ${String(row.repeats)} times · one decision`
                    : "Awaiting your decision"}
              </p>
            </article>
          ) : (
            <div className="approval-placeholder" key={id} style={{ height }} role="status">
              Request ended
            </div>
          ),
        )}
      </div>
      <footer>New requests join the end. Hide keeps every request pending.</footer>
    </main>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<ConfirmationPage />);
