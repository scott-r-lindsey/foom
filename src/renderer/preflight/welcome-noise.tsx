import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import { TileLight } from "../board/terminal-tile";
import { AgentBadge } from "../board/agent-badge";
import { agentBadges } from "../board/sidebar-model";
import { WelcomeSidebar, welcomeRows, NEEDS_YOU, DONE } from "./welcome-sidebar";
import { prefersReducedMotion } from "./launch-sequence";
import { Feed, type Line, TICK_MS } from "./welcome-noise-output";

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
export const AGENTS = welcomeRows.map((row) => [row.branch, row.agent] as const);
export { NEEDS_YOU, DONE };
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
  const stageRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = stageRef.current;
    const sidebar = element?.querySelector<HTMLElement>(".welcome-sidebar");
    if (!element || !sidebar) return;
    const measure = () => {
      const fit = Math.min(
        0.8,
        element.clientHeight / Math.max(1, sidebar.offsetHeight),
        element.clientWidth / Math.max(1, sidebar.offsetWidth),
      );
      element.style.setProperty("--sidebar-scale", String(fit));
      const stage = element.getBoundingClientRect();
      const scale = stage.width / element.offsetWidth || 1;
      for (const tile of element.querySelectorAll<HTMLElement>(".noise-tile")) {
        const row = element.querySelector<HTMLElement>(
          `[data-welcome-session="${tile.dataset["session"] ?? ""}"] .board-row`,
        );
        if (!row) continue;
        const target = row.getBoundingClientRect();
        tile.style.setProperty("--target-x", `${String((target.x - stage.x) / scale)}px`);
        tile.style.setProperty("--target-y", `${String((target.y - stage.y) / scale)}px`);
        tile.style.setProperty("--target-w", `${String(target.width / scale)}px`);
        tile.style.setProperty("--target-h", `${String(target.height / scale)}px`);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(sidebar);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
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
    <div ref={stageRef} className="welcome-noise" data-phase={phase} aria-hidden="true" inert>
      <WelcomeSidebar settled={phase === "settled"} views={views} reduced={reduced} />
      {welcomeRows.map((row, index) => {
        const { branch, agent } = row;
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
          <div
            key={row.id}
            className="noise-tile"
            data-session={row.id}
            data-state={current}
            style={style}
          >
            <div className="noise-title">
              <TileLight row={{ ...row, state: current }} />
              <AgentBadge mark={agentBadges.get(agent)} />
              <span className="noise-location">
                {row.repository} › {branch}
              </span>
              <span className="noise-tile-menu">{index + 1}⌄</span>
              <span>□</span>
              <span>−</span>
            </div>
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
          </div>
        );
      })}
    </div>
  );
}
