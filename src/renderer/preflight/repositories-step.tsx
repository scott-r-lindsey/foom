import type { Repository } from "../../shared/worktrees";
import type { StepHeading } from "./preflight-step.d";
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
  immediate = false,
}: StepHeading & {
  immediate?: boolean;
  source: SetupSource;
  code: CodeSelection | undefined;
  repositories: readonly Repository[];
  codeScanning: Scanning | undefined;
  scanCode: (folder: string | null) => void;
  setCode: (selection: CodeSelection) => void;
}) {
  return (
    <>
      <p className="preflight-eyebrow">T-2 · Repositories</p>
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
    </>
  );
}
