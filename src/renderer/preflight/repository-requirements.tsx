import { useState } from "react";
import type {
  RepositoryRequirementsAction,
  RepositoryRequirementsApi,
  RepositoryRequirements,
} from "../../shared/repository-requirements";
import type { Repository } from "../../shared/worktrees";

type RequirementsApi = RepositoryRequirementsApi["repositoryRequirements"];

function RequirementsCard({
  repository,
  request,
}: {
  repository: Repository;
  request: RequirementsApi;
}) {
  const [note, setNote] = useState<RepositoryRequirements | null>();
  const [draft, setDraft] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const act = async (command: RepositoryRequirementsAction) => {
    setBusy(true);
    setError("");
    try {
      const next = await request(command);
      setNote(next);
      setDraft(undefined);
    } catch {
      setError(
        command.action === "read"
          ? "Unable to read host requirements"
          : "Unable to save host requirements. Reopen the repository to refresh.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <details
      className="host-card repository-requirements-card"
      onToggle={(event) => {
        if (event.currentTarget.open && !busy)
          void act({ action: "read", repository: repository.path });
      }}
    >
      <summary>
        <strong>{repository.name}</strong>
        <code>{repository.path}</code>
      </summary>
      <div className="repository-requirements">
        <h3 className="host-check-group">Host requirements</h3>
        {error && (
          <p className="hosts-failure" role="alert">
            {error}
          </p>
        )}
        {busy && note === undefined && <p role="status">Loading host requirements…</p>}
        {!busy && note === null && <p>No recorded requirements</p>}
        {note && (
          <>
            <div className="repository-requirements-actions">
              <small>
                Recorded by {note.agent} on {note.host} ·{" "}
                {new Date(note.recordedAt).toLocaleDateString()}
                {note.editedAt === undefined
                  ? ""
                  : ` · edited by you ${new Date(note.editedAt).toLocaleDateString()}`}
              </small>
              {draft === undefined ? (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setDraft(note.markdown);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      void act({
                        action: "clear",
                        repository: repository.path,
                        revision: note.revision,
                      });
                    }}
                  >
                    Clear
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setDraft(undefined);
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={
                      busy || !draft.trim() || new TextEncoder().encode(draft).length > 16384
                    }
                    onClick={() => {
                      void act({
                        action: "edit",
                        repository: repository.path,
                        revision: note.revision,
                        markdown: draft,
                      });
                    }}
                  >
                    Save
                  </button>
                </>
              )}
            </div>
            {draft === undefined ? (
              <pre>{note.markdown}</pre>
            ) : (
              <textarea
                aria-label="Host requirements Markdown"
                maxLength={16384}
                rows={8}
                value={draft}
                disabled={busy}
                onChange={(event) => {
                  setDraft(event.currentTarget.value);
                }}
              />
            )}
          </>
        )}
      </div>
    </details>
  );
}

export function RepositoryRequirementsCards({
  repositories,
  request,
}: {
  repositories: readonly Repository[];
  request: RequirementsApi;
}) {
  return repositories.map((repository) => (
    <RequirementsCard key={repository.path} repository={repository} request={request} />
  ));
}
