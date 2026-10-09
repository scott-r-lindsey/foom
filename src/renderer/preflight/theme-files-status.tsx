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
        <p className="preflight-error" role="alert">
          Unable to open themes folder.
        </p>
      )}
      {catalog?.errors
        .filter((entry) => entry.kind === kind)
        .map((entry, index) => (
          <p className="preflight-error" role="status" key={`${entry.file}-${String(index)}`}>
            Rejected {entry.file} · {entry.path}: {entry.reason}
          </p>
        ))}
    </div>
  );
}
