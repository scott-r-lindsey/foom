import type { SetupState } from "../../shared/setup";
import type { Repository } from "../../shared/worktrees";
import type { StepActions } from "./preflight-step.d";
import { examplePath } from "./preflight";

export function WorktreeLocationControls({
  state,
  repositories,
  save,
}: StepActions & {
  state: SetupState;
  repositories: readonly Repository[];
}) {
  return (
    <>
      <h3>New worktrees</h3>
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
          </span>
        </label>
      </fieldset>
      <p className="preflight-note">
        <code>feat/search</code> → <code>{examplePath(state, repositories)}</code>
      </p>
    </>
  );
}
