import { useEffect, useState } from "react";
import type { ReactNode } from "react";
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

function Copy({ value }: { value: string }) {
  const [message, setMessage] = useState("");
  return (
    <>
      <button
        type="button"
        className="panel-copy"
        onClick={() => {
          void navigator.clipboard.writeText(value).then(
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
            {subject.home ? <Copy value={subject.home.directory} /> : unknown}
          </Fact>
          <Fact label="Shell">{subject.home?.path ?? unknown}</Fact>
          <Fact label="Version">{subject.home?.version ?? unknown}</Fact>
          <Fact label="Running">{subject.rows.filter((row) => !row.exited).length}</Fact>
        </>
      )}
      {subject.kind === "repository" && (
        <>
          <Fact label="Path">
            <Copy value={subject.repository.path} />
          </Fact>
          <Fact label="Remote">{facts?.remote ?? unknown}</Fact>
          <Fact label="Default branch">{facts?.defaultBranch ?? unknown}</Fact>
          <Fact label="Last fetch">
            <span className={facts?.fetchFailed ? "panel-failure" : undefined}>
              {facts?.lastFetch ? new Date(facts.lastFetch).toLocaleString() : unknown}
              {facts?.fetchFailed && " · Failed"}
            </span>
          </Fact>
          <Fact label="Worktrees">
            {subject.repository.worktrees.length} ·{" "}
            {subject.repository.worktrees.filter((tree) => tree.managed).length} Foom made ·{" "}
            {subject.repository.mergedCount ?? unknown} eligible for merged cleanup
          </Fact>
          <Fact label="Sessions">
            {["working", "checking", "needs_input", "done", "failed", "quiet_ok"].map((state) => {
              const matching = subject.rows.filter((row) => row.state === state);
              return matching[0] ? (
                <span key={state} className="panel-chip" data-state={state}>
                  {matching.length} {light(matching[0]).label}
                </span>
              ) : null;
            })}
            {subject.rows.length === 0 && "None"}
          </Fact>
        </>
      )}
      {subject.kind === "worktree" && (
        <>
          <Fact label="Branch">
            {subject.tree.branch ?? `Detached at ${subject.tree.head?.slice(0, 7) ?? unknown}`}
          </Fact>
          <Fact label="Path">
            <Copy value={subject.tree.path} />
          </Fact>
          <Fact label="Changes">
            {facts?.changes === 0 ? (
              <span className="panel-chip" data-state="done">
                Clean
              </span>
            ) : (
              (facts?.changes ?? unknown)
            )}
          </Fact>
          <Fact label="Upstream">
            {facts?.upstream
              ? `${String(facts.upstream.ahead)} ahead · ${String(facts.upstream.behind)} behind`
              : unknown}
          </Fact>
          <Fact label="Last commit">
            {facts?.commit ? (
              <>
                <span className="panel-hash">{facts.commit.hash.slice(0, 7)}</span>{" "}
                {facts.commit.subject}
                <br />
                {new Date(facts.commit.timestamp).toLocaleString()}
              </>
            ) : (
              unknown
            )}
          </Fact>
          {subject.tree.path !== subject.repository.path && (
            <>
              <Fact label="Merged">
                {facts?.merged === null || facts?.merged === undefined
                  ? unknown
                  : facts.merged
                    ? "Merged into default branch"
                    : "Not merged into default branch"}
              </Fact>
              <Fact label="Created by">{subject.tree.managed ? "Foom" : "Elsewhere"}</Fact>
            </>
          )}
        </>
      )}
      {subject.kind === "session" && (
        <>
          <Fact label="Location">
            {subject.row.home ? "Home (~)" : `${subject.row.repository} · ${subject.row.branch}`}
            <br />
            {subject.row.worktree}
          </Fact>
          <Fact label="Agent">
            {sessionIdentity(subject.row, source.shellName?.())}
            <br />
            {options?.agents.find((agent) => agent.id === subject.row.agent)?.version ??
              (subject.row.kind === "shell" ? source.homeShell?.()?.version : undefined) ??
              unknown}
          </Fact>
          <Fact label="State">
            <span className="panel-chip" data-state={subject.row.state}>
              {light(subject.row).label}
            </span>
            <br />
            {subject.row.reason}
          </Fact>
          <Fact label="Waiting">
            {subject.row.state === "needs_input" ? waitTime(subject.row, now) : "—"}
          </Fact>
          <Fact label="Launch flags">
            {subject.row.bypass && <strong className="panel-bypass">BYPASS</strong>}{" "}
            {subject.row.launchFlags?.join(" ") || "None recorded"}
          </Fact>
          <Fact label={subject.row.exited ? "Exit code" : "Started"}>
            {subject.row.exited
              ? (subject.row.exitCode ?? unknown)
              : subject.row.startedAt
                ? new Date(subject.row.startedAt).toLocaleString()
                : unknown}
          </Fact>
          <Fact label="Tile">{subject.tile ?? "Hidden"}</Fact>
          <Fact label="Conversation">
            {subject.row.conversationId ? (
              <Copy value={subject.row.conversationId} />
            ) : (
              "None recorded"
            )}
          </Fact>
        </>
      )}
    </dl>
  );
}

export function PanelTitle({ name, save }: { name: string; save: (value: string) => void }) {
  const [draft, setDraft] = useState<string>();
  return draft === undefined ? (
    <button
      type="button"
      className="panel-rename-title"
      aria-label={`Rename ${name}`}
      onClick={() => {
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
      ref={(element) => {
        element?.focus();
      }}
      onChange={(event) => {
        setDraft(event.target.value);
      }}
      onBlur={() => {
        save(draft);
        setDraft(undefined);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          setDraft(undefined);
        }
        if (event.key === "Enter") {
          event.preventDefault();
          save(draft);
          setDraft(undefined);
        }
      }}
    />
  );
}
