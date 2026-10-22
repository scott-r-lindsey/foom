import { useEffect, useRef } from "react";
import { createFlightArt, flightPathGeometry, type Palette } from "./flight-art";

export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

/** Decorative animation, disposed with its surface and paused while unfocused. */
export function FlightCanvas({
  launch = false,
  reduced = false,
  initialElapsedMs = 0,
  onReplay,
}: {
  launch?: boolean;
  reduced?: boolean;
  initialElapsedMs?: number;
  onReplay?: (hole: { x: number; y: number; radius: number }) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const rocketRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const draw = createFlightArt();
    const start = performance.now();
    let frame = 0;
    let paused = false;
    const paint = () => {
      if (!canvas.isConnected) return;
      const style = getComputedStyle(canvas);
      const token = (name: string) => style.getPropertyValue(`--${name}`).trim();
      const dark = launch || style.colorScheme !== "light";
      const P: Palette = {
        mode: dark ? "dark" : "light",
        star: token(launch ? "space-ink" : "ink"),
        accent: token("accent"),
        deep: token("accent-deep"),
        hot: token(dark ? "space-ink" : "accent-deep"),
        cool: token("accent-deep"),
        hull: token("space-ink"),
        outline: dark ? "transparent" : token("accent-deep"),
        hole: token("hole"),
      };
      const ratio = window.devicePixelRatio || 1;
      const w = canvas.clientWidth,
        h = canvas.clientHeight;
      canvas.width = Math.round(w * ratio);
      canvas.height = Math.round(h * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const elapsed = performance.now() - start + initialElapsedMs;
      draw(ctx, w, h, elapsed, P, launch, reduced);
      const button = rocketRef.current;
      if (button) {
        const { rocket } = flightPathGeometry(w, h, reduced ? 0 : elapsed);
        Object.assign(button.style, {
          left: `${String(rocket.x)}px`,
          top: `${String(rocket.y)}px`,
          width: `${String(rocket.size * 0.6)}px`,
          height: `${String(rocket.size * 0.9)}px`,
          transform: `translate(-50%, -60%) rotate(${String(rocket.angle)}rad)`,
        });
      }
    };
    const tick = () => {
      paint();
      if (!reduced && !paused) frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      paused = true;
      cancelAnimationFrame(frame);
    };
    const resume = () => {
      stop();
      paused = false;
      tick();
    };
    tick();
    // Reduced motion and blurred windows have no frame loop to notice layout changes.
    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => {
            if (canvas.clientWidth > 0 && canvas.clientHeight > 0) paint();
          })
        : undefined;
    observer?.observe(canvas);
    window.addEventListener("blur", stop);
    window.addEventListener("focus", resume);
    return () => {
      stop();
      observer?.disconnect();
      window.removeEventListener("blur", stop);
      window.removeEventListener("focus", resume);
    };
  }, [initialElapsedMs, launch, reduced]);
  return (
    <>
      <canvas ref={ref} className="flight-canvas" aria-hidden="true" />
      {onReplay && (
        <button
          ref={rocketRef}
          type="button"
          className="flight-rocket"
          aria-label="Replay launch"
          onClick={() => {
            const bounds = ref.current?.getBoundingClientRect();
            if (!bounds) return;
            const { hole } = flightPathGeometry(bounds.width, bounds.height);
            onReplay({ x: bounds.left + hole.x, y: bounds.top + hole.y, radius: hole.radius });
          }}
        />
      )}
    </>
  );
}
