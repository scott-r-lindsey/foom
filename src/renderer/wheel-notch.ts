import { useRef } from "react";

/** A mouse notch, or a short trackpad swipe. */
const WHEEL_STEP = 50;

export function useWheelNotch() {
  const accumulatedRef = useRef(0);
  return (event: Pick<WheelEvent, "deltaY" | "deltaMode">): -1 | 0 | 1 => {
    // Line and page modes come from mouse wheels: each event is a notch.
    accumulatedRef.current =
      event.deltaMode === 0 ? accumulatedRef.current + event.deltaY : event.deltaY * WHEEL_STEP;
    if (Math.abs(accumulatedRef.current) < WHEEL_STEP) return 0;
    const direction = accumulatedRef.current < 0 ? 1 : -1;
    accumulatedRef.current = 0;
    return direction;
  };
}
