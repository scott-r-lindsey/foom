import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

/** Stars streak past faster and faster once `lifting()` turns true. */
function starfield(canvas: HTMLCanvasElement, lifting: () => boolean): () => void {
  const context = canvas.getContext("2d");
  if (!context) return () => {};
  const ratio = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * ratio;
  canvas.height = canvas.clientHeight * ratio;
  const color = getComputedStyle(canvas).color;
  const stars = Array.from({ length: 140 }, () => ({
    x: Math.random() * canvas.width,
    y: Math.random() * canvas.height,
    size: (Math.random() * 1.4 + 0.3) * ratio,
    depth: Math.random() * 0.8 + 0.2,
  }));
  let speed = 0;
  let frame = 0;
  const tick = () => {
    speed = Math.min(speed + (lifting() ? 0.5 : 0), 26 * ratio);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = color;
    for (const star of stars) {
      star.y += speed * star.depth;
      if (star.y > canvas.height) {
        star.y -= canvas.height;
        star.x = Math.random() * canvas.width;
      }
      context.globalAlpha = 0.35 + star.depth * 0.6;
      context.fillRect(star.x, star.y, star.size, star.size + speed * star.depth * 0.6);
    }
    frame = requestAnimationFrame(tick);
  };
  tick();
  return () => {
    cancelAnimationFrame(frame);
  };
}

/**
 * T-minus countdown, then liftoff. Reduced motion shows a still frame instead.
 * Escape, Enter, Space or a click skips it.
 */
export function LaunchSequence({ onDone }: { onDone: () => void }) {
  const [reduced] = useState(prefersReducedMotion);
  const [phase, setPhase] = useState<"3" | "2" | "1" | "liftoff">(reduced ? "liftoff" : "3");
  const overlayRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const liftingRef = useRef(false);
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
      liftingRef.current = true;
      setPhase("liftoff");
    }, 2100);
    const end = window.setTimeout(finish, 4300);
    const stop = canvasRef.current
      ? starfield(canvasRef.current, () => liftingRef.current)
      : undefined;
    return () => {
      window.clearTimeout(two);
      window.clearTimeout(one);
      window.clearTimeout(liftoff);
      window.clearTimeout(end);
      stop?.();
    };
  }, [finish, reduced]);
  return (
    <div
      ref={overlayRef}
      className="launch"
      data-phase={phase}
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
      {!reduced && <canvas ref={canvasRef} className="launch-stars" aria-hidden="true" />}
      <p className="launch-count" role="status">
        {phase === "liftoff" ? (
          <>
            <span className="wordmark" role="img" aria-label="foom">
              <span aria-hidden="true">
                fo
                <span className="wordmark-hole" />m
              </span>
            </span>
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
