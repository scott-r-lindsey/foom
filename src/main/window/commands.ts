import type { BoardCommand } from "../../shared/board-command";
import type { Input, MenuItemConstructorOptions } from "electron";
import type { AppMenuEntry, CommandItem, ShortcutGroup } from "../../shared/app-menu";
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
] satisfies readonly {
  id: BoardCommand;
  label: string;
  code: string;
  shift: boolean;
  alt: boolean;
  leader: boolean;
}[];

export interface Binding {
  code: string;
  control?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  leader?: boolean;
}
type SheetColumn = "App" | "Board" | "Tiles";
export interface Command {
  id: string;
  /** The native macOS menu label. */
  label: string;
  /** The wordmark menu label, when it differs from the native one. */
  menuLabel?: string;
  section: string;
  bindings: Binding[];
  /** Native accelerator text. */
  shortcut: string;
  /** The first binding as the user reads it on this platform. */
  hint: string;
  enabled: boolean;
  checked?: boolean;
  badge?: string;
  /** Shortcut sheet column and row; commands sharing a row combine their keys. */
  sheet?: [SheetColumn, string];
  role?: MenuItemConstructorOptions["role"];
  run: () => void | Promise<void>;
}
export interface CommandActions {
  board(command: BoardCommand): void;
  zoom(direction: "in" | "out" | "reset"): Promise<void>;
  native(id: string): void;
}
/** The terminal-safe tile leader. It only exists off macOS. */
export const LEADER: Binding = { code: "Space", control: true, shift: true };
const displayKey = (code: string) =>
  ({ Comma: ",", Slash: "/", Equal: "=", Minus: "-", Digit0: "0", Space: "Space" })[code] ??
  code.replace(/^(Key|Digit|Arrow)/, "");
export function shortcutLabel(binding: Binding): string {
  return [
    binding.leader ? "Ctrl+Shift+Space, " : "",
    binding.control ? "Ctrl+" : "",
    binding.meta ? "Command+" : "",
    binding.alt ? "Alt+" : "",
    binding.shift ? "Shift+" : "",
    displayKey(binding.code),
  ].join("");
}
const keyName = (code: string, mac: boolean) =>
  ({
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    ArrowDown: "↓",
    Enter: mac ? "↩" : "Enter",
    Minus: "−",
  })[code] ?? displayKey(code);
/** Modifiers as the user reads them: ⌃⌥⇧⌘ on macOS, Ctrl+Alt+Shift+ elsewhere. */
const modifiers = (binding: Binding, mac: boolean) =>
  mac
    ? [
        binding.control ? "⌃" : "",
        binding.alt ? "⌥" : "",
        binding.shift ? "⇧" : "",
        binding.meta ? "⌘" : "",
      ].join("")
    : [
        binding.control ? "Ctrl+" : "",
        binding.meta ? "Meta+" : "",
        binding.alt ? "Alt+" : "",
        binding.shift ? "Shift+" : "",
      ].join("");
export function displayShortcut(binding: Binding, mac: boolean): string {
  return `${binding.leader ? `${displayShortcut(LEADER, mac)}, ` : ""}${modifiers(binding, mac)}${keyName(binding.code, mac)}`;
}
/** All app actions, native roles and accelerators are defined here, in main. */
export function createCommands(
  platform: string,
  development: boolean,
  actions: CommandActions,
  agents: readonly { id: string; name: string; mark: string }[] = [],
): Command[] {
  const mac = platform === "darwin";
  const chord = (code: string, shift = !mac): Binding => ({
    code,
    meta: mac,
    control: !mac,
    shift,
  });
  const commands: Command[] = [];
  const add = (
    id: string,
    label: string,
    section: string,
    bindings: Binding[] = [],
    run: Command["run"] = () => {
      actions.native(id);
    },
    extra: Partial<Pick<Command, "role" | "menuLabel" | "badge" | "sheet" | "enabled">> = {},
  ) => {
    commands.push({
      id,
      label,
      section,
      bindings,
      shortcut: bindings[0] ? shortcutLabel(bindings[0]) : "",
      hint: bindings[0] ? displayShortcut(bindings[0], mac) : "",
      enabled: true,
      run,
      ...extra,
    });
  };
  // Planned commands exist from the start and stay disabled until they land.
  const planned = { enabled: false } as const;
  add("about", "About Foom", "Foom");
  for (const agent of agents)
    add(`via-${agent.id}`, `Via ${agent.name}`, "Planned", [], undefined, {
      ...planned,
      badge: agent.mark,
    });
  const sheet: Partial<Record<BoardCommand, Command["sheet"]>> = {
    settings: ["App", "Settings"],
    sidebar: ["Board", "Focus sidebar"],
    "next-waiting": ["Board", "Longest waiting"],
    maximize: ["Board", "Maximize tile"],
    left: ["Tiles", "Focus"],
    right: ["Tiles", "Focus"],
    up: ["Tiles", "Focus"],
    down: ["Tiles", "Focus"],
    "swap-left": ["Tiles", "Swap"],
    "swap-right": ["Tiles", "Swap"],
    "swap-up": ["Tiles", "Swap"],
    "swap-down": ["Tiles", "Swap"],
    "split-right": ["Tiles", "Split right"],
    "split-down": ["Tiles", "Split down"],
    "hide-session": ["Tiles", "Hide"],
    "close-tile": ["Tiles", "Close"],
  };
  for (const entry of BOARD_COMMANDS) {
    const binding: Binding =
      !mac && entry.leader
        ? { code: entry.code, leader: true, shift: entry.id.startsWith("swap-") }
        : { ...chord(entry.code, entry.id === "settings" ? !mac : entry.shift), alt: entry.alt };
    add(
      entry.id,
      entry.id === "settings" ? "Settings…" : entry.label,
      entry.id === "settings" ? "Foom" : "View",
      [binding],
      () => {
        actions.board(entry.id);
      },
      {
        ...(entry.id === "settings" ? { menuLabel: "Via Settings UI" } : {}),
        sheet: sheet[entry.id] ?? ["Tiles", "Focus tile"],
      },
    );
  }
  if (mac) {
    add("hide", "Hide Foom", "Foom", [chord("KeyH")], undefined, { role: "hide" });
    add("hide-others", "Hide Others", "Foom", [{ ...chord("KeyH"), alt: true }], undefined, {
      role: "hideOthers",
    });
  }
  add("quit", "Quit Foom", "Foom", [chord("KeyQ")], undefined, { sheet: ["App", "Quit"] });
  add("new-window", "New Window", "File", [chord(mac ? "KeyN" : "KeyO", !mac)], undefined, {
    menuLabel: "New window",
    sheet: ["App", "New window"],
  });
  add(
    "new-worktree",
    "New Worktree…",
    "File",
    [chord("KeyT")],
    () => {
      actions.board("new-worktree");
    },
    { menuLabel: "New worktree…", sheet: ["App", "New worktree"] },
  );
  add(
    "add-repository",
    "Add Repository…",
    "File",
    [],
    () => {
      actions.board("add-repository");
    },
    { menuLabel: "Add repository…" },
  );
  add("new-orchestrator", "New Orchestrator…", "Planned", [], undefined, {
    ...planned,
    menuLabel: "New orchestrator…",
  });
  add(
    "close-window",
    "Close Window",
    "File",
    mac ? [chord("KeyW")] : [{ code: "F4", alt: true }],
    undefined,
    {
      sheet: ["App", "Close window"],
    },
  );
  for (const [id, label, code, shift] of [
    ["undo", "Undo", "KeyZ", false],
    ["redo", "Redo", "KeyZ", true],
    ["cut", "Cut", "KeyX", false],
    ["copy", "Copy", "KeyC", false],
    ["paste", "Paste", "KeyV", false],
    ["selectAll", "Select All", "KeyA", false],
  ] as const) {
    if (mac || id === "copy" || id === "paste")
      add(id, label, "Edit", [chord(code, mac ? shift : true)], undefined, {
        role: id,
        ...(id === "copy" || id === "paste" ? { sheet: ["App", label] as const } : {}),
      });
  }
  for (const [id, label] of [
    ["one", "One"],
    ["columns", "Two side by side"],
    ["rows", "Two stacked"],
    ["grid", "Two by two"],
    ["main2", "One and two"],
    ["main3", "One and three"],
  ] as const)
    add(`preset-${id}`, label, "View", [], () => {
      actions.board(`preset-${id}`);
    });
  for (const [id, label, code] of [
    ["in", "Bigger interface", "Equal"],
    ["out", "Smaller interface", "Minus"],
    ["reset", "Actual size", "Digit0"],
  ] as const) {
    const bindings = [
      chord(code),
      chord(id === "in" ? "NumpadAdd" : id === "out" ? "NumpadSubtract" : "Numpad0"),
    ];
    if (mac && id === "in") bindings.push(chord(code, true));
    add(`zoom-${id}`, label, "View", bindings, () => actions.zoom(id), {
      sheet: ["App", "Interface size"],
    });
  }
  if (mac) {
    add("minimize", "Minimize", "Window", [chord("KeyM")], undefined, { role: "minimize" });
    add("zoom", "Zoom", "Window", [], undefined, { role: "zoom" });
    add("front", "Bring All to Front", "Window", [], undefined, { role: "front" });
  }
  add("action-log", "Action Log", "Planned", [], undefined, {
    ...planned,
    menuLabel: "Action log",
  });
  add("shortcuts", "Keyboard Shortcuts", "Help", [chord("Slash")], undefined, {
    menuLabel: "Keyboard shortcuts",
    sheet: ["App", "Keyboard shortcuts"],
  });
  add("licenses", "Third-party licenses", "Help");
  add("github", "Foom on GitHub", "Help");
  if (development) {
    add("reload", "Reload", "Developer", [chord("KeyR")]);
    add(
      "force-reload",
      "Force Reload",
      "Developer",
      mac ? [chord("KeyR", true)] : [{ ...chord("KeyR"), alt: true }],
      undefined,
      { menuLabel: "Force reload" },
    );
    add(
      "devtools",
      "Toggle Developer Tools",
      "Developer",
      [{ ...chord("KeyI", true) }],
      undefined,
      {
        menuLabel: "Developer tools",
      },
    );
  }
  const sections = ["Foom", "File", "Edit", "View", "Window", "Help", "Developer", "Planned"];
  return commands.sort((a, b) => sections.indexOf(a.section) - sections.indexOf(b.section));
}
type Layout = string | null | { submenu: string; label: string; items: readonly (string | null)[] };
/**
 * The curated wordmark menu: app-wide commands only. Everything else keeps its
 * shortcut and stays in the macOS menu bar. `size` is the interface size row.
 */
const appMenuLayout = (agents: readonly string[]): readonly Layout[] => [
  "new-window",
  "new-worktree",
  "add-repository",
  "new-orchestrator",
  null,
  {
    submenu: "settings-menu",
    label: "Settings",
    items: [...agents.map((agent) => `via-${agent}`), null, "settings"],
  },
  "size",
  null,
  "action-log",
  "shortcuts",
  "about",
  "licenses",
  null,
  "reload",
  "force-reload",
  "devtools",
  null,
  "quit",
];
const item = (command: Command): CommandItem => ({
  id: command.id,
  label: command.menuLabel ?? command.label,
  shortcut: command.hint,
  enabled: command.enabled,
  ...(command.checked === undefined ? {} : { checked: command.checked }),
  ...(command.badge ? { badge: command.badge } : {}),
});
/** Drops leading, trailing and repeated separators left by absent commands. */
function tidy<T>(entries: readonly (T | null)[]): (T | null)[] {
  const result: (T | null)[] = [];
  for (const entry of entries)
    if (entry !== null || (result.length > 0 && result.at(-1) !== null)) result.push(entry);
  if (result.at(-1) === null) result.pop();
  return result;
}
/** The wordmark menu projection: data only, the same on every platform. */
export function projectAppMenu(commands: readonly Command[], scale: number): AppMenuEntry[] {
  const byId = new Map(commands.map((command) => [command.id, command]));
  const agents = commands.flatMap((command) =>
    command.id.startsWith("via-") ? [command.id.slice(4)] : [],
  );
  return tidy(
    appMenuLayout(agents).flatMap((entry): AppMenuEntry[] => {
      if (entry === null) return [null];
      if (typeof entry !== "string") {
        const items = tidy(
          entry.items.flatMap((id) => {
            if (id === null) return [null];
            const command = byId.get(id);
            return command ? [item(command)] : [];
          }),
        );
        return items.length
          ? [{ kind: "submenu", id: entry.submenu, label: entry.label, items }]
          : [];
      }
      if (entry === "size") {
        const smaller = byId.get("zoom-out");
        const bigger = byId.get("zoom-in");
        return smaller && bigger
          ? [{ kind: "size", label: "Size", scale, smaller: item(smaller), bigger: item(bigger) }]
          : [];
      }
      const command = byId.get(entry);
      return command ? [{ kind: "command", ...item(command) }] : [];
    }),
  );
}
/** Joins keys sharing modifiers: digits become a range, others a spaced list. */
function combine(bindings: readonly Binding[], mac: boolean, led: boolean): string {
  const prefixes = bindings.map((binding) => modifiers(binding, mac));
  const keys = bindings.map((binding) => keyName(binding.code, mac));
  if (bindings.length === 1 || prefixes.some((prefix) => prefix !== prefixes[0]))
    return bindings
      .map((binding) => displayShortcut(led ? { ...binding, leader: false } : binding, mac))
      .join(", ");
  const digits = keys.every((key, index) => key === String(Number(keys[0]) + index));
  return `${prefixes[0] ?? ""}${digits && keys.length > 2 ? `${keys[0] ?? ""}–${keys.at(-1) ?? ""}` : keys.join(" ")}`;
}
/** The keyboard shortcut sheet, generated from the same registry the dispatcher uses. */
export function shortcutSheet(commands: readonly Command[], platform: string): ShortcutGroup[] {
  const mac = platform === "darwin";
  return (["App", "Board", "Tiles"] as const).map((title) => {
    const rows = new Map<string, Binding[]>();
    for (const command of commands) {
      const binding = command.bindings[0];
      if (command.sheet?.[0] !== title || !binding) continue;
      const row = rows.get(command.sheet[1]) ?? [];
      row.push(binding);
      rows.set(command.sheet[1], row);
    }
    const bindings = [...rows.values()].flat();
    const led = bindings.length > 0 && bindings.every((binding) => binding.leader);
    return {
      title,
      lead: led ? `${displayShortcut(LEADER, mac)}, then` : "",
      rows: [
        ...(title === "App" && !mac ? [{ label: "Menu", keys: "Alt or F10" }] : []),
        ...[...rows].map(([label, bindings]) => ({
          label,
          keys: combine(bindings, mac, led),
        })),
      ],
    };
  });
}
type ShortcutInput = Pick<Input, "type" | "code" | "control" | "shift" | "alt" | "meta">;
const matches = (input: ShortcutInput, binding: Binding) =>
  binding.code === input.code &&
  Boolean(binding.control) === input.control &&
  Boolean(binding.meta) === input.meta &&
  Boolean(binding.shift) === input.shift &&
  Boolean(binding.alt) === input.alt;
/** One keyboard dispatcher, including the terminal-safe tile leader and Alt-alone gesture. */
export function createShortcuts(
  commands: readonly Command[],
  platform: string,
  open: () => void,
  now = Date.now,
) {
  let expires = 0;
  let altAlone = false;
  return {
    reset: () => {
      expires = 0;
      altAlone = false;
    },
    handle(input: ShortcutInput): boolean {
      const altKey = input.code === "AltLeft" || input.code === "AltRight";
      if (platform !== "darwin") {
        if (input.type === "keyUp" && altKey && altAlone) {
          altAlone = false;
          open();
          return true;
        }
        if (input.type === "keyDown") {
          altAlone = altKey && !input.control && !input.meta && !input.shift;
          if (input.code === "F10" && !input.control && !input.meta && !input.shift && !input.alt) {
            open();
            return true;
          }
        }
      }
      if (input.type !== "keyDown") return false;
      if (platform !== "darwin" && matches(input, LEADER)) {
        expires = now() + 2000;
        return true;
      }
      if (/^(Control|Shift|Alt|Meta)(Left|Right)$/.test(input.code)) return false;
      const armed = expires > now();
      expires = 0;
      const command = commands.find((command) =>
        command.bindings.some((binding) => (!binding.leader || armed) && matches(input, binding)),
      );
      if (command) {
        if (command.enabled) void command.run();
        return true;
      }
      return armed && matches(input, { code: "Escape" });
    },
  };
}
export function nativeMenu(commands: readonly Command[]): MenuItemConstructorOptions[] {
  return ["Foom", "File", "Edit", "View", "Window", "Help", "Developer"].flatMap((section) => {
    const items = commands
      .filter((command) => command.section === section)
      .map(
        (command): MenuItemConstructorOptions => ({
          id: command.id,
          label: command.label,
          enabled: command.enabled,
          ...(command.checked === undefined ? {} : { type: "checkbox", checked: command.checked }),
          ...(command.role ? { role: command.role } : { click: () => void command.run() }),
          ...(command.shortcut ? { accelerator: command.shortcut } : {}),
          registerAccelerator: false,
        }),
      );
    return items.length
      ? [
          {
            label: section,
            ...(section === "Window" ? { role: "windowMenu" as const } : {}),
            submenu: items,
          },
        ]
      : [];
  });
}
