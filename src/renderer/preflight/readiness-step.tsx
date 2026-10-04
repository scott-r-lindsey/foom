import type { SetupState } from "../../shared/setup";
import type { AgentReport } from "../../shared/workspace";
import type { Repository } from "../../shared/worktrees";
import type { StepHeading } from "./preflight-step.d";
import { pollRows } from "./preflight";

export function ReadinessStep({
  headingRef,
  state,
  report,
  repositories,
  go,
}: StepHeading & {
  state: SetupState;
  report: AgentReport | undefined;
  repositories: readonly Repository[];
  go: (step: number) => void;
}) {
  const rows = pollRows(state, report, repositories);
  const allGo = rows.every((row) => row.go);

  return (
    <>
      <p className="preflight-eyebrow">T-0 · Go / no-go</p>
      <h2 ref={headingRef} tabIndex={-1}>
        {allGo ? "All stations go." : "Hold. Something needs fixing."}
      </h2>
      <p className="preflight-intro">
        {allGo
          ? "Everything checks out. Launch to open your board."
          : "Fix the no-go items below. Each one links back to its step."}
      </p>
      <ul className="preflight-poll">
        {rows.map((row) => (
          <li key={row.system} data-go={row.go}>
            <span className="preflight-system">{row.system}</span>
            <span className="preflight-detail">
              {row.detail}
              {!row.go && (
                <>
                  {" · "}
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      go(row.step);
                    }}
                  >
                    Fix
                  </button>
                </>
              )}
            </span>
            <span className="preflight-pill">{row.go ? "GO" : "NO-GO"}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
