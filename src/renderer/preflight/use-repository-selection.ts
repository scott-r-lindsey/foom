import { useEffect, useState } from "react";
import type { Repository } from "../../shared/worktrees";
import { useBackgroundErrors } from "../board/error-presentation";
import type { SetupSource } from "./setup-source.d";
import type { CodeSelection, Scanning } from "./repository-picker";
import { defaultSelection } from "./repository-picker";
import { message } from "./message";

export function useRepositorySelection(
  source: Pick<SetupSource, "repositories" | "scan" | "apply">,
  settingsMode: boolean,
  setError: (error: string | undefined) => void,
) {
  const [repositories, setRepositories] = useState<readonly Repository[]>([]);
  const [code, setCode] = useState<CodeSelection>();
  const [codeScanning, setCodeScanning] = useState<Scanning>();
  const [applying, setApplying] = useState(false);
  const { report: reportFailure, clear } = useBackgroundErrors();
  useEffect(() => {
    let live = true;
    source.repositories().then(
      (next) => {
        if (live) {
          setRepositories(next);
          clear("setup-repositories");
        }
      },
      () => {
        if (live) reportFailure("setup-repositories", "Unable to load repositories.");
      },
    );
    return () => {
      live = false;
    };
  }, [source, reportFailure, clear]);
  /** Scans a folder (null picks one) and preselects what it finds. */
  const scanCode = (folder: string | null) => {
    setCodeScanning({ folder, folders: 0, repositories: 0 });
    source
      .scan(crypto.randomUUID(), folder, (progress) => {
        setCodeScanning({ folder, ...progress });
      })
      .then(
        (result) => {
          if (result)
            setCode({
              scan: result,
              selected: settingsMode
                ? new Set(result.repositories.filter((repo) => repo.added).map((repo) => repo.path))
                : defaultSelection(result),
            });
        },
        (caught: unknown) => {
          setError(message(caught));
        },
      )
      .finally(() => {
        setCodeScanning(undefined);
      });
  };
  const applySelection = async (selection: CodeSelection) => {
    setApplying(true);
    setError(undefined);
    const restoreSelection = (added: readonly Repository[]) => {
      if (settingsMode)
        setCode({
          ...selection,
          selected: new Set(
            selection.scan.repositories
              .filter((repo) => added.some((entry) => entry.path === repo.path))
              .map((repo) => repo.path),
          ),
        });
    };
    try {
      const update = await source.apply([...selection.selected]);
      setRepositories(update.repositories);
      if (update.failures.length) {
        setError(
          update.failures.some(
            (failure) =>
              failure.message === "Git is unavailable. Install Git and recheck on Go / no-go.",
          )
            ? "Git is unavailable. Install Git and recheck on Go / no-go."
            : "Unable to update repositories.",
        );
        restoreSelection(update.repositories);
        return update.failures.every(
          (failure) =>
            failure.message === "Git is unavailable. Install Git and recheck on Go / no-go.",
        );
      }
      return true;
    } catch (caught) {
      setError(message(caught));
      restoreSelection(repositories);
      return false;
    } finally {
      setApplying(false);
    }
  };
  const selectRepositories = (selection: CodeSelection) => {
    setCode(selection);
    if (settingsMode) void applySelection(selection);
  };

  return {
    repositories,
    code,
    codeScanning,
    applying,
    scanCode,
    applySelection,
    selectRepositories,
  };
}
