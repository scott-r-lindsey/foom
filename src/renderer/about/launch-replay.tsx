import { useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import { LaunchSequence } from "../preflight/launch-sequence";

/** A top-layer surface keeps the iris above About's native modal backdrop. */
export function LaunchReplay({
  hole,
  reduced,
  covered,
  done,
}: {
  hole: { x: number; y: number; radius: number };
  reduced: boolean;
  covered: () => void;
  done: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const finishedRef = useRef(false);
  const finish = () => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    // Release native modality before About unmounts and restores its opener.
    ref.current?.close();
    done();
  };
  useLayoutEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
    };
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(covered, reduced ? 200 : 500);
    return () => {
      window.clearTimeout(timer);
    };
  }, [covered, reduced]);
  // The farthest corner, with room for a resize during the short transition.
  const radius = Math.hypot(window.innerWidth, window.innerHeight);
  return (
    <dialog
      ref={ref}
      className="launch-replay"
      aria-label="Launch replay"
      tabIndex={-1}
      onKeyDownCapture={(event) => {
        // A bare modifier must not trigger reduced motion's any-key skip.
        if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) {
          event.stopPropagation();
          return;
        }
        if (event.key === "Tab") {
          event.preventDefault();
          event.stopPropagation();
          ref.current?.focus();
        } else if (
          reduced ||
          event.key === "Escape" ||
          event.key === "Enter" ||
          event.key === " "
        ) {
          event.preventDefault();
          event.stopPropagation();
          finish();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        finish();
      }}
      onClick={finish}
    >
      <div
        className="launch-replay-scene"
        data-reduced={reduced}
        style={
          {
            "--iris-x": `${String(hole.x)}px`,
            "--iris-y": `${String(hole.y)}px`,
            "--iris-start": `${String(hole.radius)}px`,
            "--iris-end": `${String(radius)}px`,
          } as CSSProperties
        }
      >
        <LaunchSequence onDone={finish} />
      </div>
    </dialog>
  );
}
