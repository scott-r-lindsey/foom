import { ActionError } from "../board/error-presentation";
import { useState } from "react";
import type { ThemeCatalog, ThemeKind } from "../../shared/theme-file";
export function ThemeFilesStatus({
  catalog,
  kind,
  openFolder,
}: {
  catalog?: ThemeCatalog | undefined;
  kind: ThemeKind;
  openFolder?: (() => Promise<void>) | undefined;
}) {
  const [error, setError] = useState(false);
  return (
    <div className="theme-files-status">
      {openFolder && (
        <button
          type="button"
          onClick={() => {
            setError(false);
            void openFolder().catch(() => {
              setError(true);
            });
          }}
        >
          Open themes folder
        </button>
      )}
      {error && (
        <ActionError
          message="Unable to open themes folder."
          close={() => {
            setError(false);
          }}
        />
      )}
      {catalog?.errors
        .filter((entry) => entry.kind === kind)
        .map((entry, index) => (
          <p
            className={entry.severity === "warning" ? "preflight-note" : "preflight-error"}
            role="status"
            key={`${entry.file}-${String(index)}`}
          >
            {entry.severity === "warning" ? "Warning" : "Rejected"} {entry.file} · {entry.path}:{" "}
            {entry.reason}
          </p>
        ))}
    </div>
  );
}
