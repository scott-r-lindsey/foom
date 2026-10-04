/**
 * Made-up agent output for the welcome step. Prose streams in a few characters at a
 * time, tool output lands in bursts, and agents stall between steps, so each tile
 * moves like a real terminal rather than a smooth scroll.
 */
export type Tone = "plain" | "dim" | "bold" | "accent" | "blue" | "cyan" | "green" | "red";
export type Segment = readonly [Tone, string];
export type Line = readonly Segment[];
export type Agent = "Claude Code" | "Codex" | "Antigravity";

export interface FeedView {
  lines: { id: number; segments: Line }[];
  status: Line;
  /** 0.25–1: how hard this terminal is printing right now. */
  level: number;
}

type Random = () => number;
/** A template prints one line; prose lines stream instead of landing at once. */
type Template = { prose?: true; line: (random: Random) => Line };

/** Lines kept per terminal; the largest tile shows about this many. */
export const KEEP = 28;
export const TICK_MS = 70;
const SPINNER = ["·", "✢", "✳", "✶", "✻", "✽"];
const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const FILES = [
  "src/renderer/sidebar.tsx",
  "src/main/workspace.ts",
  "src/renderer/terminal/shell-controller.ts",
  "tests/unit/board.test.tsx",
  "src/shared/setup.ts",
  "src/main/worktrees.ts",
  "src/renderer/styles/board.css",
  "docs/architecture.md",
];
const TESTS = ["board", "shell-controller", "worktrees", "alternate-scroll", "setup-source"];
const PROSE = [
  "I'll keep the selection when a worktree is removed.",
  "The detach fails because main already revoked the ID.",
  "Let me check how the evaluator handles stale output.",
  "Tests pass. Now the Electron boundary.",
  "That rename should also move the pin.",
  "Looking at why the wheel sends arrow keys here.",
];

function pick(items: readonly string[], random: Random): string {
  return items[Math.floor(random() * items.length)] ?? "";
}
function count(random: Random, low: number, high: number): string {
  return String(Math.floor(low + random() * (high - low)));
}

const CLAUDE: Template[] = [
  {
    line: (r) => [
      ["accent", "● "],
      ["bold", "Read "],
      ["blue", pick(FILES, r)],
    ],
  },
  {
    line: (r) => [
      ["dim", "  ⎿ "],
      ["dim", `Read ${count(r, 20, 400)} lines`],
    ],
  },
  {
    line: (r) => [
      ["accent", "● "],
      ["bold", "Update "],
      ["blue", pick(FILES, r)],
    ],
  },
  {
    line: (r) => [
      ["dim", "  ⎿ "],
      ["green", `+${count(r, 1, 30)} `],
      ["red", `-${count(r, 0, 12)}`],
    ],
  },
  { line: () => [["green", "+   const rows = pinnedFirst(repos, pins);"]] },
  { line: () => [["red", "-   const rows = sortRows(repos);"]] },
  {
    line: (r) => [
      ["accent", "● "],
      ["bold", "Bash"],
      ["dim", `(npm test -- ${pick(TESTS, r)})`],
    ],
  },
  {
    line: (r) => [
      ["dim", "  ⎿ "],
      ["green", "✓ "],
      ["plain", `${count(r, 4, 60)} passed`],
    ],
  },
  {
    prose: true,
    line: (r) => [
      ["accent", "● "],
      ["plain", pick(PROSE, r)],
    ],
  },
];
const CODEX: Template[] = [
  {
    line: () => [
      ["cyan", "• "],
      ["bold", "Ran "],
      ["plain", "git status --short"],
    ],
  },
  {
    line: (r) => [
      ["dim", "  └ "],
      ["green", "M "],
      ["plain", pick(FILES, r)],
    ],
  },
  {
    line: (r) => [
      ["cyan", "• "],
      ["bold", "Explored "],
      ["plain", `${count(r, 2, 9)} files`],
    ],
  },
  {
    line: (r) => [
      ["dim", "  └ "],
      ["plain", "Search "],
      ["blue", `"${pick(["activeId", "detach", "generation"], r)}"`],
    ],
  },
  {
    line: (r) => [
      ["cyan", "• "],
      ["bold", "Edited "],
      ["blue", pick(FILES, r)],
    ],
  },
  {
    line: (r) => [
      ["dim", `    ${count(r, 40, 300)} `],
      ["green", "+    if (removed) activeId = undefined;"],
    ],
  },
  {
    line: (r) => [
      ["dim", "$ "],
      ["plain", `npx vitest run ${pick(TESTS, r)}`],
    ],
  },
  {
    line: (r) => [
      ["green", " ✓ "],
      ["plain", `tests/unit/${pick(TESTS, r)}.test.ts `],
      ["dim", `(${count(r, 3, 40)})`],
    ],
  },
  { prose: true, line: (r) => [["plain", pick(PROSE, r)]] },
];
const ANTIGRAVITY: Template[] = [
  {
    line: (r) => [
      ["blue", "info "],
      ["plain", `Compiling ${count(r, 120, 400)} modules`],
    ],
  },
  {
    line: (r) => [
      ["blue", "info "],
      ["plain", "bundled in "],
      ["green", `${count(r, 80, 900)}ms`],
    ],
  },
  {
    line: (r) => {
      const filled = Number(count(r, 1, 10));
      return [
        ["plain", `transform ${String(filled * 10).padStart(3)}% `],
        ["accent", "█".repeat(filled)],
        ["dim", "░".repeat(10 - filled)],
      ];
    },
  },
  {
    line: (r) => [
      ["dim", "> "],
      ["plain", `eslint ${pick(FILES, r)}`],
    ],
  },
  {
    line: (r) => [
      ["green", "✓ "],
      ["plain", `${pick(TESTS, r)} `],
      ["dim", `${count(r, 2, 90)}ms`],
    ],
  },
  {
    prose: true,
    line: (r) => [
      ["accent", "◆ "],
      ["plain", pick(PROSE, r)],
    ],
  },
];
const TEMPLATES: Record<Agent, Template[]> = {
  "Claude Code": CLAUDE,
  Codex: CODEX,
  Antigravity: ANTIGRAVITY,
};

function length(line: Line): number {
  return line.reduce((total, [, text]) => total + text.length, 0);
}

/** The first `shown` characters of a line, keeping each segment's color. */
export function clip(line: Line, shown: number): Line {
  const result: Segment[] = [];
  let left = shown;
  for (const [tone, text] of line) {
    if (left <= 0) break;
    result.push([tone, text.slice(0, left)]);
    left -= text.length;
  }
  return result;
}

interface Printed {
  id: number;
  line: Line;
  shown: number;
}

export class Feed {
  private printed: Printed[] = [];
  private next = 0;
  private wait = 0;
  private rate = 0;
  private ticks = 0;
  private readonly started: number;

  constructor(
    private readonly agent: Agent,
    private readonly random: Random,
  ) {
    this.started = Math.floor(random() * 90);
    // Start mid-session: the terminal already has a screenful.
    for (let line = 0; line < KEEP; line++) this.print(true);
  }

  private print(whole: boolean): void {
    const templates = TEMPLATES[this.agent];
    const chosen = templates[Math.floor(this.random() * templates.length)];
    if (!chosen) return;
    const line = chosen.line(this.random);
    this.printed.push({ id: this.next++, line, shown: whole || !chosen.prose ? Infinity : 0 });
    if (this.printed.length > KEEP) this.printed.shift();
  }

  /** One tick of output. A quiet feed only keeps its clock running. */
  step(active: boolean): void {
    this.ticks++;
    let printed = 0;
    const last = this.printed.at(-1);
    if (active && last && last.shown < length(last.line)) {
      // Streaming prose: a few characters, sometimes a stall mid-word.
      const chunk = this.random() < 0.15 ? 0 : Math.ceil(this.random() * 9);
      last.shown += chunk;
      printed = chunk;
    } else if (active && this.wait > 0) {
      this.wait--;
    } else if (active) {
      // A burst of one to seven lines, then a pause that is usually short.
      const burst = 1 + Math.floor(this.random() ** 2 * 7);
      for (let line = 0; line < burst; line++) {
        this.print(false);
        printed += 24;
        if ((this.printed.at(-1)?.shown ?? 0) === 0) break;
      }
      this.wait = Math.floor(this.random() ** 3 * 28);
    }
    this.rate = this.rate * 0.82 + Math.min(1, printed / 40) * 0.18;
  }

  view(): FeedView {
    const seconds = String(this.started + Math.floor((this.ticks * TICK_MS) / 1000));
    const frame = this.ticks >> 1;
    const status: Line =
      this.agent === "Claude Code"
        ? [
            ["accent", `${SPINNER[frame % SPINNER.length] ?? "·"} `],
            ["accent", "Thinking… "],
            ["dim", `(${seconds}s · esc to interrupt)`],
          ]
        : this.agent === "Codex"
          ? [
              ["cyan", frame % 6 < 3 ? "• " : "◦ "],
              ["bold", "Working "],
              ["dim", `(${seconds}s • esc to interrupt)`],
            ]
          : [
              ["accent", `${BRAILLE[frame % BRAILLE.length] ?? "⠋"} `],
              ["dim", `${seconds}s`],
            ];
    return {
      lines: this.printed.map(({ id, line, shown }) => ({ id, segments: clip(line, shown) })),
      status,
      level: Math.min(1, 0.25 + this.rate * 4),
    };
  }
}
