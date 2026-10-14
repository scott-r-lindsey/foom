import { useEffect, useRef, useState } from "react";
import type { ActionLogApi, ActionLogPage } from "../../shared/action-log";

export function ActionLog({
  api,
  subscribe,
  close,
}: {
  api: ActionLogApi;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
}) {
  const [search, setSearch] = useState("");
  const [action, setAction] = useState("");
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<ActionLogPage>({ entries: [], total: 0 });
  const [error, setError] = useState("");
  const [loadedKey, setLoadedKey] = useState("");
  const queryKey = JSON.stringify([search, action, status, offset, revision]);
  const loading = loadedKey !== queryKey;
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(
    () =>
      subscribe(() => {
        setRevision((value) => value + 1);
      }),
    [subscribe],
  );
  useEffect(() => {
    let active = true;
    void api
      .read({ search, action, status, offset })
      .then((next) => {
        if (active) {
          setPage(next);
          setLoadedKey(queryKey);
          setError("");
        }
      })
      .catch(() => {
        if (active) {
          setError("Unable to read the action log.");
          setLoadedKey(queryKey);
        }
      });
    return () => {
      active = false;
    };
  }, [api, search, action, status, offset, revision, queryKey]);
  const clear = async () => {
    setClearing(true);
    try {
      await api.clear();
      setConfirmClear(false);
      setOffset(0);
      setRevision((value) => value + 1);
    } catch {
      setError("Unable to clear the action log.");
    } finally {
      setClearing(false);
    }
  };
  return (
    <section
      className="action-log"
      aria-label="Action log"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close();
        }
      }}
    >
      <header>
        <h1>Action log</h1>
        <button type="button" onClick={close}>
          Close action log
        </button>
      </header>
      <p>
        Local, redacted action history. Kept for 30 days in up to five 10 MiB files. Clearing
        history keeps live operation deduplication.
      </p>
      <div className="action-log-filters">
        <label>
          Search{" "}
          <input
            ref={inputRef}
            type="search"
            maxLength={256}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setOffset(0);
            }}
          />
        </label>
        <div>
          <label htmlFor="action-log-action">Action</label>
          <select
            id="action-log-action"
            value={action}
            onChange={(event) => {
              setAction(event.target.value);
              setOffset(0);
            }}
          >
            <option value="">All actions</option>
            {[
              "open_preview",
              "close_preview",
              "create_worktree",
              "launch",
              "stop",
              "close",
              "remove_worktree",
              "reply",
              "take_over",
              "make_orchestrator",
              "revoke_orchestrator",
              "transfer_orchestrator",
            ].map((value) => (
              <option key={value} value={value}>
                {value.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="action-log-outcome">Outcome</label>
          <select
            id="action-log-outcome"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setOffset(0);
            }}
          >
            <option value="">All outcomes</option>
            {[
              "pending_confirmation",
              "running",
              "succeeded",
              "failed",
              "declined",
              "cancelled",
              "indeterminate",
              "refused",
            ].map((value) => (
              <option key={value} value={value}>
                {value.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={() => {
            setRevision((value) => value + 1);
          }}
        >
          Refresh
        </button>
        <button
          type="button"
          disabled={clearing}
          onClick={() => {
            if (confirmClear) void clear();
            else setConfirmClear(true);
          }}
        >
          {confirmClear ? "Confirm clear history" : "Clear history…"}
        </button>
        {confirmClear && (
          <button
            type="button"
            disabled={clearing}
            onClick={() => {
              setConfirmClear(false);
            }}
          >
            Keep history
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      <p role="status">
        {loading ? "Loading action log…" : `${String(page.total)} matching events`}
      </p>
      <div className="action-log-table" tabIndex={0} role="region" aria-label="Action history">
        <table>
          <thead>
            <tr>
              {[
                "Time",
                "Actor / parent",
                "Repository / worktree",
                "Action",
                "Target / result",
                "Outcome",
                "Redacted reply proposal",
              ].map((label) => (
                <th key={label} scope="col">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {page.entries.map((entry, index) => (
              <tr key={`${entry.operationId}-${entry.timestamp}-${String(index)}`}>
                <td>
                  <time dateTime={entry.timestamp}>{entry.timestamp}</time>
                  <br />
                  {entry.operationId}
                </td>
                <td>
                  {entry.actorId}
                  {entry.parentId && (
                    <>
                      <br />
                      {entry.parentId}
                    </>
                  )}
                </td>
                <td>
                  {entry.repository}
                  <br />
                  {entry.worktree}
                </td>
                <td>
                  {entry.action === "open_preview"
                    ? `${entry.reason === "completed" ? "Opened preview" : "Open preview"} ${entry.path ?? ""}`
                    : entry.action.replaceAll("_", " ")}
                </td>
                <td>
                  {entry.targetId ?? "—"}
                  {entry.resultId && (
                    <>
                      <br />
                      {entry.resultId}
                    </>
                  )}
                </td>
                <td>
                  {entry.status.replaceAll("_", " ")} · {entry.reason}
                </td>
                <td>{entry.proposal ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && !page.entries.length && <p>No matching actions.</p>}
      <nav aria-label="Action log pages">
        <button
          type="button"
          disabled={loading || offset === 0}
          onClick={() => {
            setOffset((value) => Math.max(0, value - 100));
          }}
        >
          Newer
        </button>
        <button
          type="button"
          disabled={loading || offset + 100 >= page.total}
          onClick={() => {
            setOffset((value) => value + 100);
          }}
        >
          Older
        </button>
      </nav>
    </section>
  );
}
