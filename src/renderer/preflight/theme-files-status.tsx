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
  const diagnostics = catalog?.errors.filter((entry) => entry.kind === kind) ?? [];
  const warnings = diagnostics.filter((entry) => entry.severity === "warning");
  const themes = kind === "theme" ? catalog?.interface : undefined;
  return (
    <div className="theme-files-status">
      {themes?.map(({ id, theme }) => {
        const file = id.slice("user:".length);
        const entries = warnings.filter((entry) => entry.file === file);
        return (
          entries.length > 0 && (
            <details className="theme-warnings" key={id}>
              <summary>
                {theme.name} · {id === catalog?.activeInterfaceTheme && "Applied · "}
                {entries.length} {entries.length === 1 ? "warning" : "warnings"}
              </summary>
              <ul>
                {entries.map(({ path, reason }, index) => (
                  <li key={`${path}:${reason}:${String(index)}`}>
                    <code>{file}</code> <code>{path}</code> ·{" "}
                    <span className="theme-warning-reason">{reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          )
        );
      })}
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
      {diagnostics
        .filter((entry) => entry.severity !== "warning")
        .map((entry, index) => (
          <p className="preflight-error" role="status" key={`${entry.file}-${String(index)}`}>
            Rejected {entry.file} · {entry.path}: {entry.reason}
          </p>
        ))}
    </div>
  );
}
