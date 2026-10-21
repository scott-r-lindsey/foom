import { Wordmark } from "../ui/wordmark";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { FlightCanvas, prefersReducedMotion } from "../ui/flight-canvas";
export { prefersReducedMotion } from "../ui/flight-canvas";

const STEADY_MS = 3900;
const HOLD_MS = 10_000;
const FADE_MS = 200;

/**
 * T-minus countdown, then liftoff. Reduced motion shows a still frame instead.
 * Escape, Enter, Space or a click skips it.
 */
export function LaunchSequence({
  onDone,
  startAt = "countdown",
}: {
  onDone: () => void;
  /** Initial frame for another caller to reuse the same sequence. */
  startAt?: "countdown" | "steady";
}) {
  const [start] = useState(startAt);
  const [reduced] = useState(prefersReducedMotion);
  const [phase, setPhase] = useState<"3" | "2" | "1" | "liftoff">(
    reduced || start === "steady" ? "liftoff" : "3",
  );
  const [finished, setFinished] = useState(false);
  const [fading, setFading] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const finishedRef = useRef(false);
  const doneRef = useRef(onDone);
  useLayoutEffect(() => {
    doneRef.current = onDone;
  });
  // Stable while callers update their completion callback.
  const finish = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    setFinished(true);
    doneRef.current();
  }, []);
  useEffect(() => {
    if (finished) return;
    overlayRef.current?.focus();
    const countdown = !reduced && start === "countdown";
    const two = countdown
      ? window.setTimeout(() => {
          setPhase("2");
        }, 700)
      : undefined;
    const one = countdown
      ? window.setTimeout(() => {
          setPhase("1");
        }, 1400)
      : undefined;
    const liftoff = countdown
      ? window.setTimeout(() => {
          setPhase("liftoff");
        }, 2100)
      : undefined;
    const holdEnd = (countdown ? STEADY_MS : 0) + HOLD_MS;
    const fade = reduced
      ? undefined
      : window.setTimeout(() => {
          setFading(true);
        }, holdEnd);
    const end = window.setTimeout(finish, holdEnd + (reduced ? 0 : FADE_MS));
    return () => {
      window.clearTimeout(two);
      window.clearTimeout(one);
      window.clearTimeout(liftoff);
      window.clearTimeout(fade);
      window.clearTimeout(end);
    };
  }, [finish, finished, reduced, start]);
  if (finished) return null;
  return (
    <div
      ref={overlayRef}
      className="launch"
      data-phase={phase}
      data-start={start}
      data-fading={fading}
      data-reduced={reduced}
      role="dialog"
      aria-modal="true"
      aria-label="Launch"
      tabIndex={-1}
      onClick={finish}
      onKeyDown={(event) => {
        if (reduced || event.key === "Escape" || event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          finish();
        }
      }}
    >
      <FlightCanvas
        launch
        reduced={reduced}
        initialElapsedMs={start === "steady" ? STEADY_MS : 0}
      />
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
      <p className="launch-skip">Click or press Esc to continue</p>
    </div>
  );
}
