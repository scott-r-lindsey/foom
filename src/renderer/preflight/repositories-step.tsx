import type { Repository } from "../../shared/worktrees";
import type { StepHeading, StepActions } from "./preflight-step.d";
import type { SetupSource } from "./setup-source.d";
import { RepositoryPicker } from "./repository-picker";
import type { CodeSelection, Scanning } from "./repository-picker";

export function RepositoriesStep({
  headingRef,
  source,
  code,
  repositories,
  codeScanning,
  scanCode,
  setCode,
  nav,
  immediate = false,
}: StepHeading &
  Pick<StepActions, "nav"> & {
    immediate?: boolean;
    source: SetupSource;
    code: CodeSelection | undefined;
    repositories: readonly Repository[];
    codeScanning: Scanning | undefined;
    scanCode: (folder: string | null) => void;
    setCode: (selection: CodeSelection) => void;
  }) {
  const selected = code
    ? code.scan.repositories
        .filter((repo) => code.selected.has(repo.path))
        .map(({ path, name }) => ({ path, name }))
    : repositories;
  return (
    <>
      <p className="preflight-eyebrow">T-3 · Repositories</p>
      <h2 ref={headingRef} tabIndex={-1}>
        Where do you keep your code?
      </h2>
      <p className="preflight-intro">
        Foom looks for Git repositories there.{" "}
        {immediate
          ? "Added repositories start checked. Changes to the selection apply immediately."
          : "Ones you've worked in over the last 30 days start checked."}
      </p>
      <RepositoryPicker
        source={source}
        selection={code}
        added={repositories}
        progress={codeScanning}
        onScan={scanCode}
        onSelection={setCode}
      />
      {nav(
        1,
        selected.length
          ? `${String(selected.length)} ${selected.length === 1 ? "repository" : "repositories"} selected`
          : "None selected yet · needed to launch",
        3,
      )}
    </>
  );
}
