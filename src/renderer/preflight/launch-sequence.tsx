import { Wordmark } from "../ui/wordmark";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { FlightCanvas, prefersReducedMotion } from "../ui/flight-canvas";
export { prefersReducedMotion } from "../ui/flight-canvas";

/**
 * T-minus countdown, then liftoff. Reduced motion shows a still frame instead.
 * Escape, Enter, Space or a click skips it.
 */
export function LaunchSequence({ onDone }: { onDone: () => void }) {
  const [reduced] = useState(prefersReducedMotion);
  const [phase, setPhase] = useState<"3" | "2" | "1" | "liftoff">(reduced ? "liftoff" : "3");
  const overlayRef = useRef<HTMLDivElement>(null);
  const finishedRef = useRef(false);
  const doneRef = useRef(onDone);
  useLayoutEffect(() => {
    doneRef.current = onDone;
  });
  // Stable for the component's lifetime, so the effect below runs once.
  const finish = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    doneRef.current();
  }, []);
  useEffect(() => {
    overlayRef.current?.focus();
    if (reduced) {
      const end = window.setTimeout(finish, 1200);
      return () => {
        window.clearTimeout(end);
      };
    }
    const two = window.setTimeout(() => {
      setPhase("2");
    }, 700);
    const one = window.setTimeout(() => {
      setPhase("1");
    }, 1400);
    const liftoff = window.setTimeout(() => {
      setPhase("liftoff");
    }, 2100);
    const end = window.setTimeout(finish, 4300);
    return () => {
      window.clearTimeout(two);
      window.clearTimeout(one);
      window.clearTimeout(liftoff);
      window.clearTimeout(end);
    };
  }, [finish, reduced]);
  return (
    <div
      ref={overlayRef}
      className="launch"
      data-phase={phase}
      data-reduced={reduced}
      role="dialog"
      aria-modal="true"
      aria-label="Launch"
      tabIndex={-1}
      onClick={finish}
      onKeyDown={(event) => {
        if (event.key === "Escape" || event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          finish();
        }
      }}
    >
      <FlightCanvas launch reduced={reduced} />
      <p className="launch-count" role="status">
        {phase === "liftoff" ? (
          <>
            <Wordmark />
            <small>Takeoff was faster than expected.</small>
          </>
        ) : (
          <>
            {phase}
            <small>T-minus</small>
          </>
        )}
      </p>
      <p className="launch-skip">Press Esc to skip</p>
    </div>
  );
}
