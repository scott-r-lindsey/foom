import { useEffect, useState } from "react";
import type { CodeScan, FoundRepository, ScanProgress } from "../shared/setup";
import type { Repository } from "../shared/worktrees";
import type { SetupSource } from "./setup-source.d";

export type Scanning = ScanProgress & { folder: string | null };

/** The latest scan and which of its repositories the user wants added. */
export interface CodeSelection {
  scan: CodeScan;
  selected: ReadonlySet<string>;
}

const DAY = 86_400_000;

export function ago(time: number | null, now: number): string {
  if (time === null) return "no git activity";
  const days = Math.floor((now - time) / DAY);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${String(days)} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? "a month ago" : `${String(months)} months ago`;
  return "over a year ago";
}

/** Recent repositories and ones already added start checked. */
export function defaultSelection(scan: CodeScan): ReadonlySet<string> {
  return new Set(
    scan.repositories.filter((repo) => repo.recent || repo.added).map((repo) => repo.path),
  );
}

/** Whether the selection differs from what is added now. */
export function pending(selection: CodeSelection, added: readonly Repository[]): boolean {
  const current = new Set(added.map((repository) => repository.path));
  return selection.scan.repositories.some(
    (repo) => selection.selected.has(repo.path) !== current.has(repo.path),
  );
}

function Row({
  repository,
  checked,
  now,
  onToggle,
}: {
  repository: FoundRepository;
  checked: boolean;
  now: number;
  onToggle: () => void;
}) {
  const id = `repo-${repository.path}`;
  return (
    <li className="repo-row">
      <input type="checkbox" id={id} checked={checked} onChange={onToggle} />
      <label htmlFor={id}>
        <span className="repo-name">{repository.name}</span>
        {repository.relative !== repository.name && (
          <span className="repo-path">{repository.relative}</span>
        )}
      </label>
      <span className="repo-branch">{repository.branch ?? "detached"}</span>
      <span className="repo-age">{ago(repository.lastActive, now)}</span>
    </li>
  );
}

/**
 * "Where do you keep your code?": pick a folder, scan it with live progress, then
 * choose repositories. Recent ones (git activity in the last 30 days) start checked.
 */
export function RepositoryPicker({
  source,
  selection,
  added,
  progress,
  onScan,
  onSelection,
}: {
  source: SetupSource;
  selection: CodeSelection | undefined;
  added: readonly Repository[];
  /** A scan in progress, owned by preflight so it survives leaving the step. */
  progress: Scanning | undefined;
  /** Scan a folder; null opens the folder picker. */
  onScan: (folder: string | null) => void;
  onSelection: (selection: CodeSelection) => void;
}) {
  const [suggestions, setSuggestions] = useState<readonly string[]>([]);
  const [filter, setFilter] = useState("");
  const [now] = useState(Date.now);
  const scan = onScan;

  useEffect(() => {
    let live = true;
    source.suggestions().then(
      (found) => {
        if (live) setSuggestions(found);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [source]);

  if (progress)
    return (
      <p className="repo-scanning" role="status">
        Scanning {progress.folder ?? "the folder you chose"}… {progress.folders} folders,{" "}
        {progress.repositories} {progress.repositories === 1 ? "repository" : "repositories"}
      </p>
    );

  if (!selection)
    return (
      <div className="repo-choose">
        {suggestions.length > 0 && (
          <>
            <p className="preflight-note">Found on this computer:</p>
            <ul className="repo-suggestions">
              {suggestions.map((folder) => (
                <li key={folder}>
                  <button
                    type="button"
                    onClick={() => {
                      scan(folder);
                    }}
                  >
                    <code>{folder}</code>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <button
          type="button"
          className="primary"
          onClick={() => {
            scan(null);
          }}
        >
          Choose folder…
        </button>
        {added.length > 0 && (
          <p className="preflight-note">
            Already added: {added.map((repository) => repository.name).join(", ")}
          </p>
        )}
      </div>
    );

  const { scan: found, selected } = selection;
  const scanned = new Set(found.repositories.map((repository) => repository.path));
  const elsewhere = added.filter((repository) => !scanned.has(repository.path));
  const query = filter.trim().toLowerCase();
  const shown = found.repositories.filter(
    (repo) => !query || repo.relative.toLowerCase().includes(query),
  );
  const toggle = (path: string) => {
    const next = new Set(selected);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    onSelection({ scan: found, selected: next });
  };
  const setAll = (value: boolean) => {
    const next = new Set(selected);
    for (const repo of shown) {
      if (value) next.add(repo.path);
      else next.delete(repo.path);
    }
    onSelection({ scan: found, selected: next });
  };
  const groups: [string, FoundRepository[]][] = [
    ["Recent · last 30 days", shown.filter((repo) => repo.recent)],
    ["Older", shown.filter((repo) => !repo.recent)],
  ];

  return (
    <div className="repo-picker">
      <p className="repo-folder">
        In <code>{found.folder}</code>{" "}
        <button
          type="button"
          className="link"
          onClick={() => {
            scan(null);
          }}
        >
          Change folder
        </button>{" "}
        <button
          type="button"
          className="link"
          onClick={() => {
            scan(found.folder);
          }}
        >
          Scan again
        </button>
      </p>
      {found.truncated && (
        <p className="preflight-warning">
          Stopped after {found.folders} folders. Choose a narrower folder to see everything.
        </p>
      )}
      {found.repositories.length === 0 ? (
        <p className="preflight-empty">No Git repositories in this folder.</p>
      ) : (
        <>
          <div className="repo-tools">
            <label>
              <span className="visually-hidden">Filter repositories</span>
              <input
                type="search"
                placeholder="Filter"
                value={filter}
                onChange={(event) => {
                  setFilter(event.target.value);
                }}
              />
            </label>
            <button
              type="button"
              className="link"
              onClick={() => {
                setAll(true);
              }}
            >
              Select all
            </button>
            <button
              type="button"
              className="link"
              onClick={() => {
                setAll(false);
              }}
            >
              Select none
            </button>
            <span className="repo-count">
              {selected.size} of {found.repositories.length} selected
            </span>
          </div>
          {groups.map(([title, repos]) =>
            repos.length ? (
              <section key={title} className="repo-group" aria-label={title}>
                <h3>
                  {title} <span>{repos.length}</span>
                </h3>
                <ul>
                  {repos.map((repo) => (
                    <Row
                      key={repo.path}
                      repository={repo}
                      checked={selected.has(repo.path)}
                      now={now}
                      onToggle={() => {
                        toggle(repo.path);
                      }}
                    />
                  ))}
                </ul>
              </section>
            ) : null,
          )}
          {shown.length === 0 && <p className="preflight-empty">Nothing matches “{filter}”.</p>}
        </>
      )}
      {elsewhere.length > 0 && (
        <p className="preflight-note">
          Also added, outside this folder: {elsewhere.map((repo) => repo.name).join(", ")}
        </p>
      )}
      {pending(selection, added) && (
        <p className="preflight-note">Your selection is saved when you leave this step.</p>
      )}
    </div>
  );
}
