import { ActionError } from "../board/error-presentation";
import { useState } from "react";
import type { ThemeCatalog, ThemeKind } from "../../shared/theme-file";

const rejectionDetailLimit = 100;

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
  const rejections = diagnostics.filter((entry) => entry.severity !== "warning");
  const rejectedFiles = new Set(rejections.map(({ fileId }, index) => fileId ?? index)).size;
  const omittedRejections = rejections.length - rejectionDetailLimit;
  const themes = kind === "theme" ? catalog?.interface : undefined;
  return (
    <div className="theme-files-status">
      {themes?.map(({ id, theme, warningCount }) => {
        const file = id.slice("user:".length);
        const entries = warnings.filter((entry) => entry.file === file);
        const count = warningCount ?? entries.length;
        const omitted = count - entries.length;
        return (
          entries.length > 0 && (
            <details className="theme-warnings" key={id}>
              <summary>
                {theme.name} · {id === catalog?.activeInterfaceTheme && "Applied · "}
                {count} {count === 1 ? "warning" : "warnings"}
              </summary>
              <ul>
                {entries.map(({ path, reason }, index) => (
                  <li key={`${path}:${reason}:${String(index)}`}>
                    <code>{file}</code> <code>{path}</code> ·{" "}
                    <span className="theme-warning-reason">{reason}</span>
                  </li>
                ))}
                {omitted > 0 && <li>and {omitted} more</li>}
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
      {rejectedFiles > 0 && (
        <details className="theme-rejections">
          <summary>
            {rejectedFiles} {rejectedFiles === 1 ? "file" : "files"} rejected
          </summary>
          <ul>
            {rejections
              .slice(0, rejectionDetailLimit)
              .map(({ file, fileId, path, reason }, index) => (
                <li key={`${fileId ?? ""}-${String(index)}`}>
                  <code>{file}</code> <code>{path}</code> ·{" "}
                  <span className="theme-warning-reason">{reason}</span>
                </li>
              ))}
            {omittedRejections > 0 && <li>and {omittedRejections} more</li>}
          </ul>
        </details>
      )}
    </div>
  );
}
