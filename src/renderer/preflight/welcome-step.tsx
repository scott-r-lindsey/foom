import { Wordmark } from "../ui/wordmark";
import { NoiseToCalm } from "./welcome-noise";
import type { StepHeading } from "./preflight-step.d";

export function WelcomeStep({ headingRef, go }: StepHeading & { go: (step: number) => void }) {
  return (
    <div className="preflight-welcome">
      <h1 ref={headingRef} tabIndex={-1}>
        <Wordmark />
      </h1>
      <p className="preflight-lede">Run ten agents. Hear only from the ones that need you.</p>
      <NoiseToCalm />
      <div className="preflight-cta">
        {/* The accretion ring: light orbiting the button, like the logo's black hole. */}
        <span className="ignite">
          <svg className="ignite-ring ignite-ring-glow" aria-hidden="true" focusable="false">
            <rect className="ring-tail" pathLength="100" />
            <rect className="ring-middle" pathLength="100" />
            <rect className="ring-tip" pathLength="100" />
          </svg>
          <button
            type="button"
            className="primary"
            onClick={() => {
              go(1);
            }}
          >
            Start preflight
          </button>
          <svg className="ignite-ring" aria-hidden="true" focusable="false">
            <rect className="ring-tail" pathLength="100" />
            <rect className="ring-middle" pathLength="100" />
            <rect className="ring-tip" pathLength="100" />
          </svg>
        </span>
      </div>
    </div>
  );
}
