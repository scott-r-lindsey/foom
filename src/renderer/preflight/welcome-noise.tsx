import { type CSSProperties, useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "./launch-sequence";
import { type Agent, Feed, type Line, TICK_MS } from "./welcome-noise-output";

type Phase = "noise" | "calm" | "settled";
type TileStyle = CSSProperties & {
  "--i": number;
  "--light": number;
  "--x": number;
  "--y": number;
  "--w": number;
  "--h": number;
};

/** Ten made-up agents. One will need you; one will finish. */
export const AGENTS = [
  ["feat/sidebar-tree", "Claude Code"],
  ["fix/resume-exited", "Codex"],
  ["feat/soundscapes", "Claude Code"],
  ["fix/esc-passthrough", "Codex"],
  ["docs/licenses", "Antigravity"],
  ["feat/themes", "Claude Code"],
  ["fix/wheel-scroll", "Codex"],
  ["chore/fonts", "Claude Code"],
  ["feat/validate-config", "Antigravity"],
  ["test/removal-race", "Codex"],
] as const satisfies readonly (readonly [string, Agent])[];
export const NEEDS_YOU = 3;
export const DONE = 7;
/** Tiled like a window manager, in percent: x, y, width, height. */
export const LAYOUT = [
  [0, 0, 40, 56],
  [0, 56, 20, 44],
  [20, 56, 20, 44],
  [40, 0, 30, 32],
  [40, 32, 30, 38],
  [40, 70, 15, 30],
  [55, 70, 15, 30],
  [70, 0, 30, 46],
  [70, 46, 30, 24],
  [70, 70, 30, 30],
] as const;

function state(phase: Phase, index: number): "working" | "needs_input" | "done" {
  if (phase !== "settled") return "working";
  return index === NEEDS_YOU ? "needs_input" : index === DONE ? "done" : "working";
}

function Colored({ line }: { line: Line }) {
  return line.map(([tone, text], index) => (
    <span key={`${String(index)}-${tone}`} className={`tone-${tone}`}>
      {text}
    </span>
  ));
}

/**
 * Ten tiled terminals print at once, then fold into ten lights. Each light follows
 * its own terminal's output; one finishes, one asks for you. Reduced motion shows
 * only the settled board.
 */
export function NoiseToCalm({ random = Math.random }: { random?: () => number }) {
  const [reduced] = useState(prefersReducedMotion);
  const [phase, setPhase] = useState<Phase>(reduced ? "settled" : "noise");
  const [feeds] = useState(() => AGENTS.map(([, agent]) => new Feed(agent, random)));
  const [views, setViews] = useState(() => feeds.map((feed) => feed.view()));
  const phaseRef = useRef(phase);
  useEffect(() => {
    if (reduced) return;
    const move = (next: Phase) => {
      phaseRef.current = next;
      setPhase(next);
    };
    const calm = window.setTimeout(() => {
      move("calm");
    }, 3000);
    const settled = window.setTimeout(() => {
      move("settled");
    }, 5000);
    const tick = window.setInterval(() => {
      feeds.forEach((feed, index) => {
        feed.step(state(phaseRef.current, index) === "working");
      });
      setViews(feeds.map((feed) => feed.view()));
    }, TICK_MS);
    return () => {
      window.clearTimeout(calm);
      window.clearTimeout(settled);
      window.clearInterval(tick);
    };
  }, [reduced, feeds]);

  return (
    <div className="welcome-noise" data-phase={phase} aria-hidden="true">
      {AGENTS.map(([branch, agent], index) => {
        const current = state(phase, index);
        const view = views[index];
        const [x, y, w, h] = LAYOUT[index] ?? [0, 0, 0, 0];
        const style: TileStyle = {
          "--i": index,
          "--light": current !== "working" ? 1 : reduced ? 0.7 : (view?.level ?? 1),
          "--x": x,
          "--y": y,
          "--w": w,
          "--h": h,
        };
        return (
          <div key={branch} className="noise-tile" data-state={current} style={style}>
            <div className="noise-title">{branch}</div>
            <pre className="noise-output">
              {view?.lines.map((line) => (
                <span key={line.id} className="noise-line">
                  <Colored line={line.segments} />
                </span>
              ))}
              {view && (
                <span className="noise-line noise-status">
                  <Colored line={view.status} />
                </span>
              )}
            </pre>
            <div className="noise-row">
              <span className="noise-light" />
              <span className="noise-branch">{branch}</span>
              <span className="noise-agent">
                {current === "needs_input" ? "needs you" : current === "done" ? "done" : agent}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
