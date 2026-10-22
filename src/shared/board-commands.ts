import type { BoardCommand } from "./board-command";
/** Board command definitions shared by direct shortcuts and the tile leader. */
export const BOARD_COMMANDS = [
  { id: "settings", label: "Settings", code: "Comma", shift: false, alt: false, leader: false },
  { id: "sidebar", label: "Focus sidebar", code: "KeyB", shift: true, alt: false, leader: false },
  {
    id: "next-waiting",
    label: "Longest waiting",
    code: "KeyN",
    shift: true,
    alt: false,
    leader: false,
  },
  { id: "maximize", label: "Maximize tile", code: "Enter", shift: true, alt: false, leader: false },
  ...(
    [
      ["left", "Focus left", "ArrowLeft"],
      ["right", "Focus right", "ArrowRight"],
      ["up", "Focus up", "ArrowUp"],
      ["down", "Focus down", "ArrowDown"],
      ["split-right", "Split right", "KeyR"],
      ["split-down", "Split down", "KeyD"],
      ["close-tile", "Close tile", "KeyW"],
      ["hide-session", "Hide session", "KeyH"],
      ["tidy-tiles", "Tidy tiles", "KeyT"],
    ] as const
  ).map(([id, label, code]) => ({ id, label, code, shift: true, alt: true, leader: true })),
  ...(
    [
      ["swap-left", "Swap with left tile", "ArrowLeft"],
      ["swap-right", "Swap with right tile", "ArrowRight"],
      ["swap-up", "Swap with tile above", "ArrowUp"],
      ["swap-down", "Swap with tile below", "ArrowDown"],
    ] as const
  ).map(([id, label, code]) => ({ id, label, code, shift: false, alt: true, leader: true })),
  ...(
    [
      "tile-1",
      "tile-2",
      "tile-3",
      "tile-4",
      "tile-5",
      "tile-6",
      "tile-7",
      "tile-8",
      "tile-9",
    ] as const
  ).map((id, index) => ({
    id,
    label: `Focus tile ${String(index + 1)}`,
    code: `Digit${String(index + 1)}`,
    shift: false,
    alt: false,
    leader: true,
  })),
] as const satisfies readonly {
  id: string;
  label: string;
  code: string;
  shift: boolean;
  alt: boolean;
  leader: boolean;
}[];

/** Commands without a tile shortcut still cross the same validated bridge. */
export const BOARD_ACTIONS = [
  ...BOARD_COMMANDS.map(({ id }) => id),
  "about",
  "manual",
  "action-log",
  "toggle-sidebar",
  "new-worktree",
  "add-repository",
] as const;

export function isBoardCommand(value: unknown): value is BoardCommand {
  return (
    typeof value === "string" &&
    (BOARD_ACTIONS.some((id) => id === value) || /^via-[a-z][a-z0-9-]{0,39}$/u.test(value))
  );
}
