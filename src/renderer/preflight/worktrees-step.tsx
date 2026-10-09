import type { SetupState } from "../../shared/setup";
import type { Repository } from "../../shared/worktrees";
import type { StepHeading, StepActions } from "./preflight-step.d";
import { examplePath } from "./preflight";

export function WorktreesStep({
  headingRef,
  state,
  repositories,
  save,
}: StepHeading &
  StepActions & {
    state: SetupState;
    repositories: readonly Repository[];
  }) {
  return (
    <>
      <p className="preflight-eyebrow">T-1 · Worktrees</p>
      <h2 ref={headingRef} tabIndex={-1}>
        Where should new worktrees go?
      </h2>
      <p className="preflight-intro">
        Every agent works in its own Git worktree, on its own branch, so agents never touch each
        other's files. Choose where Foom creates them.
      </p>
      <fieldset className="preflight-options preflight-split">
        <legend className="visually-hidden">Where new worktrees go</legend>
        <label className="preflight-option">
          <input
            type="radio"
            name="worktrees"
            checked={state.settings.worktreeLocation === "root"}
            onChange={() => {
              save({ worktreeLocation: "root" });
            }}
          />
          <span>
            <b>Keep worktrees in Foom's folder</b>
            <small>
              In <code>{state.worktreeRoot}</code>. Your code folder stays tidy, and Foom can clean
              up merged worktrees in one place.
            </small>
          </span>
        </label>
        <label className="preflight-option">
          <input
            type="radio"
            name="worktrees"
            checked={state.settings.worktreeLocation === "adjacent"}
            onChange={() => {
              save({ worktreeLocation: "adjacent" });
            }}
          />
          <span>
            <b>Put them next to each repository</b>
            <small>
              Beside the repository, as <code>app-feat/search</code>. Easier to find in your editor
              and shell history.
            </small>
          </span>
        </label>
      </fieldset>
      <p className="preflight-note">
        A branch named <code>feat/search</code> would land at{" "}
        <code>{examplePath(state, repositories)}</code>
      </p>
    </>
  );
}
