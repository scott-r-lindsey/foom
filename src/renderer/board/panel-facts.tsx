import { CopyValue as Copy } from "../ui/copy-value";
import { useEffect, useState, useRef, useCallback } from "react";
import type { ReactNode } from "react";
import type { OrchestrationEntry, OrchestrationView, SidebarCommand } from "../../shared/workspace";
import type { GitPanelFacts, HomeShellFacts } from "../../shared/panel";
import type { ConfigStatus } from "../../shared/foom-config";
import type { BoardSource, LaunchOptions } from "./board-source.d";
import type { BoardRow } from "./board.d";
import type { SidebarRepository, SidebarWorktree } from "./sidebar.d";
import { ConfigDecision } from "../preflight/config-controls";
import { light, waitTime } from "./board";
import { sessionIdentity } from "./sidebar-model";
export type PanelSubject =
  | { kind: "home"; home: HomeShellFacts | undefined; rows: readonly BoardRow[] }
  | { kind: "config"; status: ConfigStatus | undefined; rows: readonly BoardRow[] }
  | { kind: "repository"; repository: SidebarRepository; rows: readonly BoardRow[] }
  | { kind: "worktree"; repository: SidebarRepository; tree: SidebarWorktree }
  | { kind: "session"; row: BoardRow; tile: number | undefined };

/** Chips carry state as tinted text and outline: highlight for information, green for
 * settled, amber only for needs-you and magenta only for failures. Text always names it. */
type Tone = "neutral" | "info" | "changes" | "working" | "done" | "needs" | "failed";
const stateTone: Record<BoardRow["state"], Tone> = {
  working: "working",
  needs_input: "needs",
  done: "done",
  failed: "failed",
  quiet_ok: "neutral",
  waiting: "neutral",
};
function Chip({ tone, dot, children }: { tone: Tone; dot?: boolean; children: ReactNode }) {
  return (
    <span className="panel-chip" data-tone={tone}>
      {dot && <span className="panel-chip-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}
function Sub({ children }: { children: ReactNode }) {
  return <span className="panel-sub">{children}</span>;
}
function ago(now: number, timestamp: number) {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${String(hours)} h ago` : `${String(Math.floor(hours / 24))} days ago`;
}
const actionNames: Record<OrchestrationEntry["action"], string> = {
  board_post: "Post to board",
  board_resolve: "Resolve thread",
  create_worktree: "New worktree",
  launch: "Launch",
  stop: "Stop",
  close: "Close",
  remove_worktree: "Remove worktree",
  take_over: "You took over",
  reply: "Reviewed reply",
  prompt: "Prompt",
  send_keys: "Send keys",
};
const statusNames: Record<OrchestrationEntry["status"], string> = {
  pending_confirmation: "awaiting your confirmation",
  running: "running",
  succeeded: "done",
  failed: "failed",
  declined: "declined",
  cancelled: "cancelled",
  indeterminate: "outcome unknown",
};

/** Basic orchestration visibility: role, children and the latest actions, as text. */
function OrchestrationFacts({
  view,
  source,
  id,
}: {
  view: OrchestrationView;
  source: BoardSource;
  id: string;
}) {
  if (view.role === "child") {
    const parent = source.getSnapshot().find((row) => row.id === view.parentId);
    return (
      <Fact label="Orchestrator">
        {parent ? `${parent.repository} › ${parent.branch}` : "Closed"}{" "}
        <Copy
          value={view.parentId}
          label="Copy parent ID"
          copy={() =>
            source.sidebarCommand?.({ kind: "copy-parent-id", id }) ??
            Promise.reject(new Error("Copy unavailable"))
          }
        />
        <Sub>
          {view.takenOver ? "· You took over" : "· Can send input, stop and read this session"}
        </Sub>
      </Fact>
    );
  }
  return (
    <>
      <Fact label="Orchestrator">
        {view.active ? "Active" : "Exited"}{" "}
        <Sub>
          · {view.children} {view.children === 1 ? "child" : "children"} running
        </Sub>
      </Fact>
      {source
        .getSnapshot()
        .filter((row) => row.orchestration?.role === "child" && row.orchestration.parentId === id)
        .map((child) => (
          <Fact key={child.id} label="Child">
            <Copy
              value={child.id}
              label="Copy child ID"
              copy={() =>
                source.sidebarCommand?.({ kind: "copy-child-id", id, child: child.id }) ??
                Promise.reject(new Error("Copy unavailable"))
              }
            />
          </Fact>
        ))}
      <Fact label="Actions">
        {view.history.length === 0 ? (
          <Sub>None yet</Sub>
        ) : (
          <ul className="panel-actions">
            {view.history
              .slice(-6)
              .reverse()
              .map((entry) => (
                <li key={entry.id} data-status={entry.status}>
                  {actionNames[entry.action]} {entry.label} <Sub>· {statusNames[entry.status]}</Sub>
                </li>
              ))}
          </ul>
        )}
      </Fact>
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}
export function PanelFacts({
  subject,
  source,
  options,
}: {
  subject: PanelSubject;
  source: BoardSource;
  options: LaunchOptions | undefined;
}) {
  const [now] = useState(Date.now);
  const [handoffError, setHandoffError] = useState("");
  const copy = async (command: SidebarCommand) => {
    await (source.sidebarCommand?.(command) ?? Promise.reject(new Error("Copy unavailable")));
  };
  const repository =
    subject.kind === "repository" || subject.kind === "worktree"
      ? subject.repository.path
      : undefined;
  const worktree = subject.kind === "worktree" ? subject.tree.path : repository;
  const copyCheckout = (
    kind:
      | "copy-default-branch"
      | "copy-worktree-branch"
      | "copy-worktree-head"
      | "copy-pull-request-number"
      | "copy-pull-request-url"
      | "copy-remote-url",
  ) =>
    repository && worktree
      ? copy({ kind, repository, worktree })
      : Promise.reject(new Error("Unknown checkout"));
  const [loaded, setLoaded] = useState<{
    repository: string;
    worktree: string;
    facts: GitPanelFacts;
  }>();
  useEffect(() => {
    if (!repository || !worktree || !source.panelFacts) return;
    let active = true;
    void source.panelFacts(repository, worktree).then(
      (facts) => {
        if (active) setLoaded({ repository, worktree, facts });
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [repository, worktree, source]);
  const facts =
    loaded?.repository === repository && loaded?.worktree === worktree ? loaded?.facts : undefined;
  const unknown = "Unknown";
  return (
    <dl className="panel-facts">
      {subject.kind === "home" && (
        <>
          <Fact label="Home">
            {subject.home ? (
              <Copy value={subject.home.directory} copy={() => copy({ kind: "copy-home-path" })} />
            ) : (
              unknown
            )}
          </Fact>
          <Fact label="Shell">
            {subject.home?.path ?? unknown} <Sub>{subject.home?.version ?? "Version unknown"}</Sub>
          </Fact>
          <Fact label="Sessions">
            <Chip tone="working">{subject.rows.filter((row) => !row.exited).length} running</Chip>
          </Fact>
        </>
      )}
      {subject.kind === "config" && (
        <>
          <Fact label="Folder">
            {subject.status ? (
              <Copy value={subject.status.folder} copy={() => copy({ kind: "copy-config-path" })} />
            ) : (
              unknown
            )}
          </Fact>
          {subject.status?.pending && (
            <Fact label="Approval">
              <Chip tone="needs" dot>
                Needs you
              </Chip>{" "}
              {!source.config?.decide && <Sub>{subject.status.pending.detail}</Sub>}
              {source.config?.decide && (
                <ConfigDecision pending={subject.status.pending} decide={source.config.decide} />
              )}
            </Fact>
          )}
          {Boolean(subject.status?.rejected.length) && (
            <Fact label="Rejected">
              <Chip tone="failed">{subject.status?.rejected.length} rejected</Chip>
            </Fact>
          )}
          {subject.status?.error && <Fact label="Problem">{subject.status.error}</Fact>}
          <Fact label="Sessions">
            <Chip tone="working">{subject.rows.filter((row) => !row.exited).length} running</Chip>
          </Fact>
        </>
      )}
      {subject.kind === "repository" && (
        <>
          <Fact label="Path">
            <Copy
              value={subject.repository.path}
              copy={() =>
                copy({
                  kind: "copy-worktree-path",
                  repository: subject.repository.path,
                  worktree: subject.repository.path,
                })
              }
            />
          </Fact>
          <Fact label="Remote">
            {facts?.remote ? (
              <Copy
                value={facts.remote}
                label="Copy remote URL"
                copy={() => copyCheckout("copy-remote-url")}
              />
            ) : (
              unknown
            )}
          </Fact>
          <Fact label="Default branch">
            {facts?.defaultBranch ? (
              <Copy
                value={facts.defaultBranch}
                label="Copy default branch"
                copy={() => copyCheckout("copy-default-branch")}
              />
            ) : (
              unknown
            )}{" "}
            {facts?.fetchFailed ? (
              <Chip tone="failed">Fetch failed</Chip>
            ) : (
              <Sub>
                · {facts?.lastFetch ? `fetched ${ago(now, facts.lastFetch)}` : "never fetched"}
              </Sub>
            )}
          </Fact>
          <Fact label="Worktrees">
            {
              subject.repository.worktrees.filter((tree) => tree.path !== subject.repository.path)
                .length
            }{" "}
            <Chip tone="neutral">
              {subject.repository.worktrees.filter((tree) => tree.managed).length} by Foom
            </Chip>
            {subject.repository.mergedCount === undefined ? (
              <Sub>merged count unknown</Sub>
            ) : (
              <Chip tone={subject.repository.mergedCount ? "done" : "neutral"}>
                {subject.repository.mergedCount} eligible to delete
              </Chip>
            )}
          </Fact>
          <Fact label="Sessions">
            {(["needs_input", "working", "waiting", "done", "failed", "quiet_ok"] as const).map(
              (state) => {
                const matching = subject.rows.filter((row) => row.state === state);
                return matching[0] ? (
                  <Chip key={state} tone={stateTone[state]} dot>
                    {matching.length}{" "}
                    {state === "waiting" ? "waiting" : light(matching[0]).label.toLowerCase()}
                  </Chip>
                ) : null;
              },
            )}
            {subject.rows.length === 0 && <Sub>None</Sub>}
          </Fact>
        </>
      )}
      {subject.kind === "worktree" && (
        <>
          {subject.tree.prunable && <Fact label="State">Broken checkout</Fact>}
          {subject.tree.pullRequest && (
            <>
              <Fact label={subject.tree.pullRequest.requestLabel ?? "Pull request"}>
                <Copy
                  value={`${subject.tree.pullRequest.numberPrefix ?? "#"}${String(subject.tree.pullRequest.number)}`}
                  label="Copy PR number"
                  copy={() => copyCheckout("copy-pull-request-number")}
                />
                {subject.tree.pullRequest.title && ` · ${subject.tree.pullRequest.title}`}
              </Fact>
              {subject.tree.pullRequest.url && (
                <Fact label="URL">
                  <Copy
                    value={subject.tree.pullRequest.url}
                    label="Copy PR URL"
                    copy={() => copyCheckout("copy-pull-request-url")}
                  />
                </Fact>
              )}
              <Fact label={`${subject.tree.pullRequest.requestLabel ?? "PR"} state`}>
                {subject.tree.pullRequest.state.toLowerCase()}
              </Fact>
              {subject.tree.pullRequest.checksMeaning && (
                <Fact
                  label={
                    {
                      required: "Required checks",
                      "head-pipeline": "Head pipeline",
                      "commit-status": "Commit status",
                    }[subject.tree.pullRequest.checksMeaning]
                  }
                >
                  {subject.tree.pullRequest.requiredChecks ?? "unknown"}
                </Fact>
              )}
              <Fact label="Checks">
                {subject.tree.pullRequest.checks
                  ? `${String(subject.tree.pullRequest.checks.passed)} passed · ${String(subject.tree.pullRequest.checks.failed)} failed · ${String(subject.tree.pullRequest.checks.pending)} running`
                  : "Unknown"}
              </Fact>
            </>
          )}
          {subject.tree.branch ? (
            <Fact label="Branch">
              <Copy
                value={subject.tree.branch}
                label="Copy branch"
                copy={() => copyCheckout("copy-worktree-branch")}
              />{" "}
              {subject.tree.branch === facts?.defaultBranch && <Chip tone="neutral">default</Chip>}
            </Fact>
          ) : (
            <Fact label="HEAD">
              <Chip tone="neutral">Detached</Chip> at{" "}
              {subject.tree.head ? (
                <Copy
                  value={subject.tree.head.slice(0, 7)}
                  label="Copy full HEAD SHA"
                  copy={() => copyCheckout("copy-worktree-head")}
                />
              ) : (
                unknown
              )}
            </Fact>
          )}
          <Fact label="Path">
            <Copy
              value={subject.tree.path}
              copy={() =>
                copy({
                  kind: "copy-worktree-path",
                  repository: subject.repository.path,
                  worktree: subject.tree.path,
                })
              }
            />
          </Fact>
          <Fact label="Changes">
            {facts?.changes === 0 ? (
              <Sub>Clean</Sub>
            ) : typeof facts?.changes === "number" ? (
              <Chip tone="changes">{facts.changes} changed</Chip>
            ) : (
              <Sub>{unknown}</Sub>
            )}
          </Fact>
          <Fact label="Upstream">
            {!facts?.upstream ? (
              <Sub>{unknown}</Sub>
            ) : facts.upstream.ahead || facts.upstream.behind ? (
              <Chip tone="info">
                {facts.upstream.ahead} ahead · {facts.upstream.behind} behind
              </Chip>
            ) : (
              <Sub>In sync</Sub>
            )}
          </Fact>
          {subject.tree.path !== subject.repository.path && (
            <>
              <Fact label="Merged">
                {facts?.merged === null || facts?.merged === undefined ? (
                  <Sub>{unknown}</Sub>
                ) : facts.merged ? (
                  <Chip tone="done">Merged into default branch</Chip>
                ) : (
                  <Chip tone="neutral">Not merged into default branch</Chip>
                )}
              </Fact>
              <Fact label="Created by Foom">
                <Chip tone={subject.tree.managed ? "info" : "neutral"}>
                  {subject.tree.managed ? "Yes" : "No"}
                </Chip>
              </Fact>
            </>
          )}
          <Fact label="Last commit">
            {facts?.commit ? (
              <>
                <span className="panel-hash">{facts.commit.hash.slice(0, 7)}</span>{" "}
                {facts.commit.subject} <Sub>· {ago(now, facts.commit.timestamp)}</Sub>
              </>
            ) : (
              unknown
            )}
          </Fact>
        </>
      )}
      {subject.kind === "session" && (
        <>
          <Fact label="Location">
            {subject.row.config
              ? "Foom config"
              : subject.row.home
                ? "Home (~)"
                : `${subject.row.repository} › ${subject.row.branch}`}
            <br />
            <Sub>{subject.row.worktree}</Sub>
          </Fact>
          <Fact label="Agent">
            {sessionIdentity(subject.row, source.shellName?.())}{" "}
            <Sub>
              {options?.agents.find((agent) => agent.id === subject.row.agent)?.version ??
                (subject.row.kind === "shell" ? source.homeShell?.()?.version : undefined) ??
                "Version unknown"}
            </Sub>
          </Fact>
          <Fact label="State">
            <Chip tone={stateTone[subject.row.state]} dot>
              {light(subject.row).label}
            </Chip>{" "}
            <Sub>{subject.row.reason}</Sub>
          </Fact>
          <Fact label="Waiting">
            {subject.row.state === "needs_input" ? (
              <Chip tone="needs">{waitTime(subject.row, now)}</Chip>
            ) : (
              <Sub>—</Sub>
            )}
          </Fact>
          {subject.row.mcpConnection && (
            <Fact label="MCP">
              <Chip
                tone={
                  subject.row.mcpConnection === "not-connected" &&
                  subject.row.orchestration?.role === "orchestrator"
                    ? "failed"
                    : "neutral"
                }
              >
                {
                  {
                    connecting: "Connecting…",
                    connected: "Connected",
                    "not-connected": "Not connected",
                  }[subject.row.mcpConnection]
                }
              </Chip>
            </Fact>
          )}
          {subject.row.roleNotRestored && <Fact label="Orchestrator">Role was not restored</Fact>}
          {subject.row.handoff && (
            <Fact label="Handoff">
              <Chip tone={subject.row.handoff.status === "failed" ? "failed" : "neutral"}>
                {subject.row.handoff.status === "done"
                  ? "✓"
                  : subject.row.handoff.status === "failed"
                    ? "■"
                    : "⊘"}{" "}
                {subject.row.handoff.status} · #{subject.row.handoff.seq}
              </Chip>
              <p className="handoff-summary">
                <Copy
                  value={subject.row.handoff.summary}
                  label="Copy handoff summary"
                  copy={() =>
                    copy({
                      kind: "copy-handoff-summary",
                      id: subject.row.id,
                      seq: subject.row.handoff?.seq ?? 0,
                    })
                  }
                />
              </p>
              <ul className="handoff-links">
                {subject.row.handoff.links.map((url, index) => (
                  <li key={`${String(index)}-${url}`}>
                    <a
                      href={url}
                      onClick={(event) => {
                        event.preventDefault();
                        setHandoffError("");
                        void copy({
                          kind: "open-handoff-link",
                          id: subject.row.id,
                          seq: subject.row.handoff?.seq ?? 0,
                          index,
                        }).catch(() => {
                          setHandoffError("Unable to open this handoff link.");
                        });
                      }}
                    >
                      {url}
                    </a>
                  </li>
                ))}
              </ul>
              <Sub>Child-authored · {subject.row.handoff.timestamp}</Sub>
              {handoffError && <span role="status">{handoffError}</span>}
            </Fact>
          )}
          {subject.row.orchestration && (
            <OrchestrationFacts
              view={subject.row.orchestration}
              source={source}
              id={subject.row.id}
            />
          )}
          {source.previews?.getHistory?.().some((entry) => entry.terminalId === subject.row.id) && (
            <Fact label="Recent">
              <ul className="panel-actions">
                {source.previews
                  .getHistory()
                  .filter((entry) => entry.terminalId === subject.row.id)
                  .slice(-6)
                  .reverse()
                  .map((entry) => (
                    <li key={entry.id}>Opened preview {entry.path}</li>
                  ))}
              </ul>
            </Fact>
          )}
          <Fact label="Launch flags">
            {subject.row.bypass && <strong className="panel-bypass">BYPASS</strong>}{" "}
            {subject.row.launchFlags?.join(" ") || <Sub>None recorded</Sub>}
          </Fact>
          {subject.row.environment?.length ? (
            <Fact label="Environment">
              <span className="panel-environment">{subject.row.environment.join(" ")}</span>
            </Fact>
          ) : null}
          <Fact label={subject.row.exited ? "Exit code" : "Started"}>
            {subject.row.exited ? (
              subject.row.exitCode === undefined ? (
                <Sub>{unknown}</Sub>
              ) : (
                <Chip tone={subject.row.state === "failed" ? "failed" : "done"}>
                  {subject.row.exitCode}
                </Chip>
              )
            ) : subject.row.startedAt ? (
              new Date(subject.row.startedAt).toLocaleString()
            ) : (
              unknown
            )}
          </Fact>
          <Fact label="Tile">
            {subject.tile === undefined ? (
              <Sub>Hidden</Sub>
            ) : (
              <Chip tone="info">{subject.tile}</Chip>
            )}
          </Fact>
          <Fact label="Session ID">
            <Copy
              value={subject.row.id}
              label="Copy Foom session ID"
              copy={() => copy({ kind: "copy-foom-session-id", id: subject.row.id })}
            />
          </Fact>
          <Fact label="Conversation">
            {subject.row.conversationId ? (
              <Copy
                value={subject.row.conversationId}
                label="Copy session ID"
                copy={() => copy({ kind: "copy-session-id", id: subject.row.id })}
              />
            ) : (
              <Sub>None recorded</Sub>
            )}
          </Fact>
        </>
      )}
    </dl>
  );
}

export function PanelTitle({ name, save }: { name: string; save: (value: string) => void }) {
  const [draft, setDraft] = useState<string>();
  const editingRef = useRef(false);
  const finishedRef = useRef(false);
  const titleRef = useCallback((element: HTMLButtonElement | null) => {
    if (element && editingRef.current) {
      editingRef.current = false;
      element.focus();
    }
  }, []);
  const inputRef = useCallback((element: HTMLInputElement | null) => {
    element?.focus();
    element?.select();
  }, []);
  const finish = (commit: boolean) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    if (commit && draft !== undefined) save(draft);
    setDraft(undefined);
  };
  return draft === undefined ? (
    <button
      ref={titleRef}
      type="button"
      className="panel-rename-title"
      aria-label={`Rename ${name}`}
      onClick={() => {
        editingRef.current = true;
        finishedRef.current = false;
        setDraft(name);
      }}
    >
      {name}
    </button>
  ) : (
    <input
      aria-label="Session name"
      className="session-rename"
      maxLength={120}
      value={draft}
      ref={inputRef}
      onChange={(event) => {
        setDraft(event.target.value);
      }}
      onBlur={() => {
        finish(true);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" || event.key === "Enter") {
          event.preventDefault();
          finish(event.key === "Enter");
        }
      }}
    />
  );
}
