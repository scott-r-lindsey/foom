import { useEffect, useState, useRef, useCallback } from "react";
import type { ReactNode } from "react";
import type { SidebarCommand } from "../../shared/workspace";
import type { GitPanelFacts, HomeShellFacts } from "../../shared/panel";
import type { BoardSource, LaunchOptions } from "./board-source.d";
import type { BoardRow } from "./board.d";
import type { SidebarRepository, SidebarWorktree } from "./sidebar.d";
import { light, waitTime } from "./board";
import { sessionIdentity } from "./sidebar-model";
export type PanelSubject =
  | { kind: "home"; home: HomeShellFacts | undefined; rows: readonly BoardRow[] }
  | { kind: "repository"; repository: SidebarRepository; rows: readonly BoardRow[] }
  | { kind: "worktree"; repository: SidebarRepository; tree: SidebarWorktree }
  | { kind: "session"; row: BoardRow; tile: number | undefined };

function Copy({ value, copy }: { value: string; copy: () => Promise<void> }) {
  const [message, setMessage] = useState("");
  return (
    <>
      <button
        type="button"
        className="panel-copy"
        onClick={() => {
          void copy().then(
            () => {
              setMessage("Copied");
            },
            () => {
              setMessage("Unable to copy");
            },
          );
        }}
      >
        {value}
      </button>
      <span role="status">{message}</span>
    </>
  );
}
/** Chips carry state as tinted text and outline: highlight for information, green for
 * settled, amber only for needs-you and magenta only for failures. Text always names it. */
type Tone = "neutral" | "info" | "working" | "done" | "needs" | "failed";
const stateTone: Record<BoardRow["state"], Tone> = {
  working: "working",
  needs_input: "needs",
  done: "done",
  failed: "failed",
  quiet_ok: "neutral",
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
  const copy = (command: SidebarCommand) =>
    source.sidebarCommand?.(command) ?? Promise.reject(new Error("Copy unavailable"));
  const repository =
    subject.kind === "repository" || subject.kind === "worktree"
      ? subject.repository.path
      : undefined;
  const worktree = subject.kind === "worktree" ? subject.tree.path : repository;
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
          <Fact label="Remote">{facts?.remote ?? unknown}</Fact>
          <Fact label="Default branch">
            {facts?.defaultBranch ?? unknown}{" "}
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
            {(["needs_input", "working", "done", "failed", "quiet_ok"] as const).map((state) => {
              const matching = subject.rows.filter((row) => row.state === state);
              return matching[0] ? (
                <Chip key={state} tone={stateTone[state]} dot>
                  {matching.length} {light(matching[0]).label.toLowerCase()}
                </Chip>
              ) : null;
            })}
            {subject.rows.length === 0 && <Sub>None</Sub>}
          </Fact>
        </>
      )}
      {subject.kind === "worktree" && (
        <>
          {subject.tree.branch ? (
            <Fact label="Branch">
              {subject.tree.branch}{" "}
              {subject.tree.branch === facts?.defaultBranch && <Chip tone="neutral">default</Chip>}
            </Fact>
          ) : (
            <Fact label="HEAD">
              <Chip tone="neutral">Detached</Chip> at{" "}
              <span className="panel-hash">{subject.tree.head?.slice(0, 7) ?? unknown}</span>
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
              <Chip tone="done">Clean</Chip>
            ) : typeof facts?.changes === "number" ? (
              <Chip tone="info">{facts.changes} changed</Chip>
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
              <Fact label="Created by">
                <Chip tone={subject.tree.managed ? "info" : "neutral"}>
                  {subject.tree.managed ? "Foom" : "Elsewhere"}
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
            {subject.row.home ? "Home (~)" : `${subject.row.repository} › ${subject.row.branch}`}
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
          <Fact label="Launch flags">
            {subject.row.bypass && <strong className="panel-bypass">BYPASS</strong>}{" "}
            {subject.row.launchFlags?.join(" ") || <Sub>None recorded</Sub>}
          </Fact>
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
          <Fact label="Conversation">
            {subject.row.conversationId ? (
              <Copy
                value={subject.row.conversationId}
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
