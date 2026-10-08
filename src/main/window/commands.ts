import type { BoardCommand } from "../../shared/board-command";
import type { Input, MenuItemConstructorOptions } from "electron";
import type { CommandItem } from "../../shared/app-menu";
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
export interface Command extends CommandItem {
  bindings: Binding[];
  role?: MenuItemConstructorOptions["role"];
  run: () => void;
}
export interface CommandActions {
  board(command: BoardCommand): void;
  zoom(direction: "in" | "out" | "reset"): void;
  native(id: string): void;
}
const displayKey = (code: string) =>
  ({ Comma: ",", Equal: "=", Minus: "-", Digit0: "0", Space: "Space" })[code] ??
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
/** All app actions, native roles and accelerators are defined here, in main. */
export function createCommands(
  platform: string,
  development: boolean,
  actions: CommandActions,
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
    run = () => {
      actions.native(id);
    },
    role?: Command["role"],
  ) => {
    commands.push({
      id,
      label,
      section,
      bindings,
      shortcut: bindings[0] ? shortcutLabel(bindings[0]) : "",
      enabled: id !== "new-window",
      run,
      ...(role ? { role } : {}),
    });
  };
  add("about", "About Foom", "Foom");
  for (const entry of BOARD_COMMANDS) {
    const binding: Binding =
      !mac && entry.leader
        ? { code: entry.code, leader: true }
        : { ...chord(entry.code, entry.id === "settings" ? !mac : entry.shift), alt: entry.alt };
    add(
      entry.id,
      entry.id === "settings" ? "Settings…" : entry.label,
      entry.id === "settings" ? "Foom" : "View",
      [binding],
      () => {
        actions.board(entry.id);
      },
    );
  }
  if (mac) {
    add("hide", "Hide Foom", "Foom", [chord("KeyH")], undefined, "hide");
    add(
      "hide-others",
      "Hide Others",
      "Foom",
      [{ ...chord("KeyH"), alt: true }],
      undefined,
      "hideOthers",
    );
  }
  add("quit", "Quit Foom", "Foom", [chord("KeyQ")]);
  add("new-window", "New Window", "File", [chord("KeyN", !mac)]);
  // Ctrl+Shift+N is already Longest waiting; New Window remains disabled without a binding.
  if (!mac) {
    const entry = commands.find((item) => item.id === "new-window");
    if (entry) {
      entry.bindings = [];
      entry.shortcut = "";
    }
  }
  add("new-worktree", "New Worktree…", "File", [chord("KeyT")], () => {
    actions.board("new-worktree");
  });
  add("close-window", "Close Window", "File", mac ? [chord("KeyW")] : [{ code: "F4", alt: true }]);
  for (const [id, label, code, shift] of [
    ["undo", "Undo", "KeyZ", false],
    ["redo", "Redo", "KeyZ", true],
    ["cut", "Cut", "KeyX", false],
    ["copy", "Copy", "KeyC", false],
    ["paste", "Paste", "KeyV", false],
    ["selectAll", "Select All", "KeyA", false],
  ] as const) {
    if (mac || id === "copy" || id === "paste")
      add(id, label, "Edit", [chord(code, mac ? shift : true)], undefined, id);
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
    add(`zoom-${id}`, label, "View", bindings, () => {
      actions.zoom(id);
    });
  }
  if (mac) {
    add("minimize", "Minimize", "Window", [chord("KeyM")], undefined, "minimize");
    add("zoom", "Zoom", "Window", [], undefined, "zoom");
    add("front", "Bring All to Front", "Window", [], undefined, "front");
  }
  add("licenses", "Third-party licenses", "Help");
  add("github", "Foom on GitHub", "Help");
  if (development) {
    add("reload", "Reload", "Developer", [chord("KeyR")]);
    add(
      "force-reload",
      "Force Reload",
      "Developer",
      mac ? [chord("KeyR", true)] : [{ ...chord("KeyR"), alt: true }],
    );
    add("devtools", "Toggle Developer Tools", "Developer", [{ ...chord("KeyI", true) }]);
  }
  const sections = ["Foom", "File", "Edit", "View", "Window", "Help", "Developer"];
  return commands.sort((a, b) => sections.indexOf(a.section) - sections.indexOf(b.section));
}
export const projectCommands = (commands: readonly Command[]): CommandItem[] =>
  commands.map(({ id, label, section, shortcut, enabled, checked }) => ({
    id,
    label,
    section,
    shortcut,
    enabled,
    ...(checked === undefined ? {} : { checked }),
  }));
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
      if (platform !== "darwin" && matches(input, { code: "Space", control: true, shift: true })) {
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
        if (command.enabled) command.run();
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
          ...(command.role ? { role: command.role } : { click: command.run }),
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
