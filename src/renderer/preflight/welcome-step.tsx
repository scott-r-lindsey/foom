import { Wordmark } from "../ui/wordmark";
import type { StepHeading } from "./preflight-step.d";

export function WelcomeStep({ headingRef, go }: StepHeading & { go: (step: number) => void }) {
  return (
    <div className="preflight-welcome">
      <h1 ref={headingRef} tabIndex={-1}>
        <Wordmark />
      </h1>
      <p className="preflight-lede">Run ten agents. Hear only from the ones that need you.</p>
      <p>
        Every agent gets its own worktree and its own terminal. Terminals stay hidden behind a
        light. When one goes quiet, Foom works out whether it's done, stuck, or asking you
        something.
      </p>
      <div className="preflight-cta">
        {/* The accretion ring: light orbiting the button, like the logo's black hole. */}
        <span className="ignite">
          <button
            type="button"
            className="primary"
            onClick={() => {
              go(1);
            }}
          >
            Start preflight
          </button>
        </span>
        <span>Five checks, about a minute</span>
      </div>
      <dl className="preflight-facts">
        <div>
          <dt>Worktrees, not branches</dt>
          <dd>Agents never step on each other's files.</dd>
        </div>
        <div>
          <dt>Lights, not tabs</dt>
          <dd>Brightness follows output. Amber means you're needed.</dd>
        </div>
        <div>
          <dt>Hooks first</dt>
          <dd>Agents that can report their own state do. The evaluator covers the rest.</dd>
        </div>
      </dl>
    </div>
  );
}
