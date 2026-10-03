import { type CSSProperties, useEffect, useState } from "react";
import { prefersReducedMotion } from "./launch-sequence";

type Phase = "noise" | "calm" | "settled";
type TileStyle = CSSProperties & { "--i": number; "--light": number; "--scroll": string };

/** Ten made-up agents. One will need you; one will finish. */
export const AGENTS = [
  ["feat/sidebar-tree", "Claude Code"],
  ["fix/session-restore", "Codex"],
  ["feat/soundscapes", "Claude Code"],
  ["fix/esc-passthrough", "Codex"],
  ["docs/licenses", "Antigravity"],
  ["feat/themes", "Claude Code"],
  ["fix/wheel-scroll", "Codex"],
  ["chore/fonts", "Claude Code"],
  ["feat/validate-config", "Antigravity"],
  ["test/removal-race", "Codex"],
] as const;
export const NEEDS_YOU = 3;
export const DONE = 7;

const OUTPUT = [
  "● Read src/renderer/sidebar.tsx",
  "  ⎿ 212 lines",
  "$ npm test",
  " ✓ board.test.tsx (41)",
  "+ const rows = pinnedFirst(repos);",
  "- const rows = sortRows(repos);",
  "Compiling 318 modules…",
  "› eslint --cache src",
  "● Thinking…",
  "exec git status --short",
  " M src/renderer/app.tsx",
  "?? src/renderer/tree.tsx",
  "PASS shell-controller (12)",
  "Applying patch",
  "  ⎿ Updated 3 lines",
  "$ npm run typecheck",
  "● Edit workspace.ts",
  "  ⎿ +14 −6",
  "fetching 4 files…",
  '● Grep "activeId"',
  "  ⎿ 9 matches",
  " ✓ alternate-scroll (6)",
  "$ git diff --stat",
  " 3 files changed",
];

function lines(index: number): string {
  const step = (index % 3) + 1;
  const start = (index * 5) % OUTPUT.length;
  return Array.from(
    { length: 16 },
    (_, line) => OUTPUT[(start + line * step) % OUTPUT.length] ?? "",
  ).join("\n");
}

function state(phase: Phase, index: number): "working" | "needs_input" | "done" {
  if (phase !== "settled") return "working";
  return index === NEEDS_YOU ? "needs_input" : index === DONE ? "done" : "working";
}

/**
 * Ten terminals scroll at once, then fold into ten lights. Brightness follows output;
 * one finishes, one asks for you. Reduced motion shows only the settled board.
 */
export function NoiseToCalm({ random = Math.random }: { random?: () => number }) {
  const [reduced] = useState(prefersReducedMotion);
  const [phase, setPhase] = useState<Phase>(reduced ? "settled" : "noise");
  const [levels, setLevels] = useState(() => AGENTS.map((_, index) => 0.5 + (index % 4) * 0.15));
  useEffect(() => {
    if (reduced) return;
    const calm = window.setTimeout(() => {
      setPhase("calm");
    }, 2200);
    const settled = window.setTimeout(() => {
      setPhase("settled");
    }, 4200);
    const flicker = window.setInterval(() => {
      setLevels((current) =>
        current.map((level) => Math.min(1, Math.max(0.25, level + (random() - 0.5) * 0.45))),
      );
    }, 420);
    return () => {
      window.clearTimeout(calm);
      window.clearTimeout(settled);
      window.clearInterval(flicker);
    };
  }, [reduced, random]);

  return (
    <div className="welcome-noise" data-phase={phase} aria-hidden="true">
      {AGENTS.map(([branch, agent], index) => {
        const current = state(phase, index);
        const style: TileStyle = {
          "--i": index,
          "--light": current === "working" ? (levels[index] ?? 1) : 1,
          "--scroll": `${String(3 + (index % 4) * 1.3)}s`,
        };
        return (
          <div key={branch} className="noise-tile" data-state={current} style={style}>
            <pre className="noise-output">
              {lines(index)}
              {"\n"}
              {lines(index)}
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
