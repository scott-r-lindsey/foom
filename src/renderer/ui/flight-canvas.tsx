import { useEffect, useRef } from "react";
import { createFlightArt, type Palette } from "./flight-art";

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
}: {
  launch?: boolean;
  reduced?: boolean;
  initialElapsedMs?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const draw = createFlightArt();
    const start = performance.now();
    let frame = 0;
    let paused = false;
    const tick = () => {
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
      draw(ctx, w, h, performance.now() - start + initialElapsedMs, P, launch, reduced);
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
    window.addEventListener("blur", stop);
    window.addEventListener("focus", resume);
    return () => {
      stop();
      window.removeEventListener("blur", stop);
      window.removeEventListener("focus", resume);
    };
  }, [initialElapsedMs, launch, reduced]);
  return <canvas ref={ref} className="flight-canvas" aria-hidden="true" />;
}
