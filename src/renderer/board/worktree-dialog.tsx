import { useEffect, useRef, useState } from "react";
import type { LaunchOptions, WorktreeSource } from "./board-source.d";
import type { AgentId } from "../../shared/agents";

const names: Record<AgentId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  agy: "Antigravity",
};

export function WorktreeDialog({
  source,
  close,
  initialRepository,
}: {
  source: WorktreeSource;
  close: () => void;
  initialRepository?: string | undefined;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [options, setOptions] = useState<LaunchOptions>();
  const [repository, setRepository] = useState("");
  const [branch, setBranch] = useState("");
  const [run, setRun] = useState<AgentId | "shell">("shell");
  const [acknowledge, setAcknowledge] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const previous = document.activeElement;
    dialogRef.current?.showModal();
    let current = true;
    void source.load().then(
      (next) => {
        if (current) {
          setOptions(next);
          setRepository(initialRepository ?? next.repositories[0]?.path ?? "");
        }
      },
      () => {
        if (current) setError("Unable to load repositories and agents. Close and try again.");
      },
    );
    return () => {
      current = false;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [source, initialRepository]);
  const fail = (error: unknown) => {
    setError(
      error instanceof Error
        ? error.message.replace(/^Error invoking remote method '[^']+': Error: /u, "")
        : "Unable to update worktree.",
    );
  };
  const needsDisclosure =
    options?.hooks &&
    run === "codex" &&
    !options.acknowledged &&
    options.agents.some((agent) => agent.id === "codex" && agent.hooks);
  return (
    <dialog
      ref={dialogRef}
      className="worktree-dialog"
      aria-labelledby="worktree-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          void source
            .start({ repository, branch, run, acknowledgeCodexNotifierReplacement: acknowledge })
            .then(close, fail)
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        <h2 id="worktree-title">New worktree</h2>
        <p>Create a branch, or use an existing branch that is not checked out elsewhere.</p>
        {!options && !error && <p role="status">Looking for repositories and agents…</p>}
        <fieldset disabled={busy || !options}>
          <label htmlFor="worktree-repository">Repository</label>
          <select
            id="worktree-repository"
            tabIndex={0}
            value={repository}
            onChange={(event) => {
              setRepository(event.target.value);
            }}
            required
          >
            <option value="" disabled>
              Select a repository
            </option>
            {options?.repositories.map((repo) => (
              <option key={repo.path} value={repo.path}>
                {repo.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              setBusy(true);
              setError("");
              void source
                .addRepository()
                .then((repo) => {
                  if (repo) {
                    setOptions(
                      (previous) =>
                        previous && {
                          ...previous,
                          repositories: [
                            ...previous.repositories.filter((item) => item.path !== repo.path),
                            repo,
                          ],
                        },
                    );
                    setRepository(repo.path);
                  }
                }, fail)
                .finally(() => {
                  setBusy(false);
                });
            }}
          >
            Add repository…
          </button>
          <label htmlFor="worktree-branch">Branch</label>
          <input
            id="worktree-branch"
            value={branch}
            maxLength={255}
            placeholder="feat/my-task"
            required
            onChange={(event) => {
              setBranch(event.target.value);
            }}
          />
          <label htmlFor="worktree-run">Run</label>
          <select
            id="worktree-run"
            tabIndex={0}
            value={run}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "shell" || value === "claude" || value === "codex" || value === "agy")
                setRun(value);
            }}
          >
            <option value="shell">Shell · no hooks</option>
            {options?.agents.map((agent) => (
              <option
                key={agent.id}
                value={agent.id}
                disabled={!agent.path || !options.enabled[agent.id]}
              >
                {names[agent.id]} · {agent.version ?? "not detected"} ·{" "}
                {options.hooks && agent.hooks ? "hooks attached" : "no hooks"}
                {!options.enabled[agent.id] ? " · disabled in preflight" : ""}
              </option>
            ))}
          </select>
          {needsDisclosure && (
            <label className="worktree-disclosure">
              <input
                type="checkbox"
                checked={acknowledge}
                onChange={(event) => {
                  setAcknowledge(event.target.checked);
                }}
              />
              I understand that Foom replaces my Codex notifier for this launch. My global
              configuration stays unchanged.
            </label>
          )}
        </fieldset>
        {error && <p role="alert">{error}</p>}
        <footer>
          <button type="button" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={
              busy || !options || !repository || !branch || Boolean(needsDisclosure && !acknowledge)
            }
          >
            {busy ? "Working…" : "Create and start"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
