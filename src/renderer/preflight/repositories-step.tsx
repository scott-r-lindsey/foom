import { RepositoryHosts } from "./hosts-settings";
import { RecentDaysInput } from "./recent-days-input";
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
  recentDays,
  onRecentDays,
}: StepHeading & {
  immediate?: boolean;
  recentDays: number;
  onRecentDays: (days: number) => void;
  source: SetupSource;
  code: CodeSelection | undefined;
  repositories: readonly Repository[];
  codeScanning: Scanning | undefined;
  scanCode: (folder: string | null) => void;
  setCode: (selection: CodeSelection) => void;
}) {
  const picker = (
    <RepositoryPicker
      recentDays={recentDays}
      onRecentDays={onRecentDays}
      source={source}
      selection={code}
      added={repositories}
      progress={codeScanning}
      onScan={scanCode}
      onSelection={setCode}
    />
  );
  if (immediate) {
    return (
      <>
        {source.hosts ? (
          <RepositoryHosts source={source} repositories={repositories} headingRef={headingRef} />
        ) : (
          <h2 ref={headingRef} tabIndex={-1}>
            Repositories
          </h2>
        )}
        <details
          className="settings-repository-picker"
          open={!repositories.length || code !== undefined || codeScanning !== undefined}
        >
          <summary>Choose repositories</summary>
          {picker}
        </details>
      </>
    );
  }
  return (
    <>
      <p className="preflight-eyebrow">T-1 · Repositories</p>
      <h2 ref={headingRef} tabIndex={-1}>
        Where do you keep your code?
      </h2>
      <p className="preflight-intro">
        Foom looks for Git repositories there. Ones you've worked in over the last{" "}
        <RecentDaysInput value={recentDays} onChange={onRecentDays} /> days start checked.
      </p>
      {picker}
    </>
  );
}
