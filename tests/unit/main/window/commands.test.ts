import { expect, test, vi } from "vitest";
import {
  createCommands,
  createShortcuts,
  nativeMenu,
  projectAppMenu,
  shortcutSheet,
} from "../../../../src/main/window/commands";
import { AGENTS } from "../../../../src/main/agents/agent-list";
import type { CommandItem } from "../../../../src/shared/app-menu";
import type { Binding } from "../../../../src/main/window/commands";
const key = (
  code: string,
  modifiers: Partial<Binding> = {},
  type: "keyDown" | "keyUp" = "keyDown",
) => ({ type, code, control: false, shift: false, alt: false, meta: false, ...modifiers });
const actions = () => ({
  board: vi.fn(),
  zoom: vi.fn(() => Promise.resolve()),
  native: vi.fn(),
});
test.each(["linux", "win32", "darwin"])(
  "%s entire command list has unique safe bindings and dispatches each action",
  (platform) => {
    const calls = actions();
    const commands = createCommands(platform, true, calls);
    const shortcuts = createShortcuts(commands, platform, vi.fn());
    const seen = new Set<string>();
    for (const command of commands) {
      for (const binding of command.bindings) {
        const signature = JSON.stringify([
          binding.code,
          !!binding.control,
          !!binding.meta,
          !!binding.shift,
          !!binding.alt,
          !!binding.leader,
        ]);
        expect(seen.has(signature), `${command.id}: ${signature}`).toBe(false);
        seen.add(signature);
        if (platform !== "darwin" && binding.control) expect(binding.shift).toBe(true);
        if (binding.leader) shortcuts.handle(key("Space", { control: true, shift: true }));
        expect(shortcuts.handle(key(binding.code, binding)), command.id).toBe(true);
      }
      if (command.enabled) void command.run();
    }
    expect(calls.board).toHaveBeenCalledWith("preset-grid");
    expect(calls.zoom).toHaveBeenCalledWith("reset");
    expect(calls.native).toHaveBeenCalledWith("quit");
    expect(calls.native).toHaveBeenCalledWith("new-window");
    expect(calls.board).toHaveBeenCalledWith("add-repository");
    expect(calls.native).toHaveBeenCalledWith("shortcuts");
    // The projection is plain data: it survives structured cloning unchanged.
    const projection = projectAppMenu(commands, 100);
    expect(structuredClone(projection)).toEqual(projection);
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ")
      expect(shortcuts.handle(key(`Key${letter}`, { control: true }))).toBe(false);
    for (let i = 0; i < 10; i++)
      expect(shortcuts.handle(key(`Digit${String(i)}`, { control: true }))).toBe(false);
  },
);
test("packaged registry cannot reload or open DevTools; native menu comes from the same list", () => {
  const commands = createCommands("darwin", false, actions());
  expect(commands.some((item) => item.section === "Developer")).toBe(false);
  const maximize = commands.find((item) => item.id === "maximize");
  if (!maximize) throw new Error("Missing maximize");
  maximize.checked = true;
  const menu = nativeMenu(commands);
  expect(menu.map((item) => item.label)).toEqual([
    "Foom",
    "File",
    "Edit",
    "View",
    "Window",
    "Help",
  ]);
  const items = menu.flatMap((section) => (Array.isArray(section.submenu) ? section.submenu : []));
  // Every implemented command; planned ones only exist in the wordmark menu.
  expect(items.map((item) => item.id).sort()).toEqual(
    commands
      .filter((item) => item.section !== "Planned")
      .map((item) => item.id)
      .sort(),
  );
  expect(items.map((item) => item.id)).toEqual(
    expect.arrayContaining(["add-repository", "shortcuts", "licenses", "github", "preset-grid"]),
  );
  expect(items.every((item) => item.registerAccelerator === false)).toBe(true);
  expect(items.find((item) => item.id === "maximize")).toMatchObject({
    type: "checkbox",
    checked: true,
  });
  expect(items.find((item) => item.id === "copy")).toMatchObject({ role: "copy" });
});
test("leader cancels on timeout, blur, Escape and unmatched control input", () => {
  let time = 100;
  const calls = actions();
  const shortcuts = createShortcuts(
    createCommands("linux", false, calls),
    "linux",
    vi.fn(),
    () => time,
  );
  const arm = () => shortcuts.handle(key("Space", { control: true, shift: true }));
  arm();
  expect(shortcuts.handle(key("ShiftLeft", { shift: true }))).toBe(false);
  expect(shortcuts.handle(key("Space", {}, "keyUp"))).toBe(false);
  expect(shortcuts.handle(key("KeyR"))).toBe(true);
  expect(calls.board).toHaveBeenCalledWith("split-right");
  arm();
  time += 2000;
  expect(shortcuts.handle(key("KeyR"))).toBe(false);
  arm();
  shortcuts.reset();
  expect(shortcuts.handle(key("KeyR"))).toBe(false);
  arm();
  expect(shortcuts.handle(key("Escape"))).toBe(true);
  arm();
  expect(shortcuts.handle(key("KeyC", { control: true }))).toBe(false);
  expect(shortcuts.handle(key("KeyR"))).toBe(false);
  arm();
  expect(shortcuts.handle(key("KeyX"))).toBe(false);
});
test("Alt alone and F10 open the menu, Alt combinations and macOS don't", () => {
  const open = vi.fn();
  const shortcuts = createShortcuts([], "win32", open);
  shortcuts.handle(key("AltLeft", { alt: true }));
  expect(open).not.toHaveBeenCalled();
  shortcuts.handle(key("AltLeft", {}, "keyUp"));
  expect(open).toHaveBeenCalledTimes(1);
  shortcuts.handle(key("AltRight", { alt: true }));
  shortcuts.handle(key("KeyX", { alt: true }));
  shortcuts.handle(key("AltRight", {}, "keyUp"));
  expect(open).toHaveBeenCalledTimes(1);
  shortcuts.handle(key("AltLeft", { alt: true, control: true }));
  shortcuts.handle(key("AltLeft", {}, "keyUp"));
  shortcuts.handle(key("F10", { shift: true }));
  expect(open).toHaveBeenCalledTimes(1);
  shortcuts.handle(key("F10"));
  expect(open).toHaveBeenCalledTimes(2);
  createShortcuts([], "darwin", open).handle(key("F10"));
  expect(open).toHaveBeenCalledTimes(2);
});

const entryIds = (entries: ReturnType<typeof projectAppMenu>) =>
  entries.map((entry) =>
    entry === null
      ? "-"
      : entry.kind === "submenu"
        ? { [entry.id]: entry.items.map((item) => item?.id ?? "-") }
        : entry.kind === "size"
          ? `size:${String(entry.scale)}`
          : entry.id,
  );
test("the wordmark menu is curated, the same on every platform, with planned items disabled", () => {
  for (const platform of ["linux", "win32", "darwin"]) {
    const commands = createCommands(platform, true, actions(), AGENTS);
    const menu = projectAppMenu(commands, 120);
    expect(entryIds(menu)).toEqual([
      "new-window",
      "new-worktree",
      "add-repository",
      "new-orchestrator",
      "-",
      { "settings-menu": ["via-claude", "via-codex", "via-agy", "-", "settings"] },
      "size:120",
      "-",
      "action-log",
      "shortcuts",
      "about",
      "licenses",
      "-",
      "reload",
      "force-reload",
      "devtools",
      "-",
      "quit",
    ]);
    const flat = menu.flatMap((entry): CommandItem[] =>
      entry === null || entry.kind === "size"
        ? []
        : entry.kind === "submenu"
          ? entry.items.flatMap((item) => (item ? [item] : []))
          : [entry],
    );
    const disabled = flat.flatMap((item) => (item.enabled ? [] : [item.id]));
    expect(disabled).toEqual([
      "new-orchestrator",
      "via-claude",
      "via-codex",
      "via-agy",
      "action-log",
    ]);
    // Disabled entries carry no explanation, issue number or shortcut.
    for (const item of flat) if (!item.enabled) expect(item.shortcut).toBe("");
  }
  const linux = projectAppMenu(createCommands("linux", false, actions(), AGENTS), 100);
  // Packaged: no developer group and no doubled separator before Quit.
  expect(entryIds(linux).slice(-4)).toEqual(["about", "licenses", "-", "quit"]);
  const settings = linux.find((entry) => entry?.kind === "submenu");
  expect(settings).toMatchObject({
    label: "Settings",
    items: [
      { label: "Via Claude Code", badge: "CC", enabled: false, shortcut: "" },
      { label: "Via Codex", badge: "CX" },
      { label: "Via Antigravity", badge: "AG" },
      null,
      { id: "settings", label: "Via Settings UI", shortcut: "Ctrl+Shift+,", enabled: true },
    ],
  });
  expect(linux.find((entry) => entry?.kind === "size")).toMatchObject({
    label: "Size",
    scale: 100,
    smaller: { id: "zoom-out", label: "Smaller interface" },
    bigger: { id: "zoom-in", label: "Bigger interface" },
  });
  expect(linux[0]).toMatchObject({ label: "New window", shortcut: "Ctrl+Shift+O" });
  expect(linux[3]).toMatchObject({ label: "New orchestrator…", enabled: false });
  expect(
    linux.find((entry) => entry?.kind === "command" && entry.id === "shortcuts"),
  ).toMatchObject({
    label: "Keyboard shortcuts",
    shortcut: "Ctrl+Shift+/",
  });
  const mac = projectAppMenu(createCommands("darwin", true, actions(), AGENTS), 100);
  expect(mac.slice(0, 2)).toMatchObject([{ shortcut: "⌘N" }, { shortcut: "⌘T" }]);
  expect(
    mac.find((entry) => entry?.kind === "command" && entry.id === "force-reload"),
  ).toMatchObject({
    label: "Force reload",
    shortcut: "⇧⌘R",
  });
  // A registry missing optional commands still projects a tidy menu.
  expect(projectAppMenu([], 100)).toEqual([]);
});
test("removed menu items keep their shortcuts", () => {
  const calls = actions();
  const commands = createCommands("linux", false, calls, AGENTS);
  const shortcuts = createShortcuts(commands, "linux", vi.fn());
  const ids = JSON.stringify(entryIds(projectAppMenu(commands, 100)));
  for (const id of ["sidebar", "next-waiting", "maximize", "tile-1", "copy", "close-window"])
    expect(ids).not.toContain(`"${id}"`);
  expect(shortcuts.handle(key("KeyB", { control: true, shift: true }))).toBe(true);
  expect(calls.board).toHaveBeenCalledWith("sidebar");
  shortcuts.handle(key("Space", { control: true, shift: true }));
  expect(shortcuts.handle(key("Digit1"))).toBe(true);
  expect(calls.board).toHaveBeenCalledWith("tile-1");
  expect(shortcuts.handle(key("KeyC", { control: true, shift: true }))).toBe(true);
  expect(calls.native).toHaveBeenCalledWith("copy");
  // Keyboard shortcuts takes Ctrl+Shift+/ only; plain Ctrl+/ stays terminal input.
  expect(shortcuts.handle(key("Slash", { control: true }))).toBe(false);
  expect(shortcuts.handle(key("Slash", { control: true, shift: true }))).toBe(true);
  expect(calls.native).toHaveBeenCalledWith("shortcuts");
});
test("disabled planned commands never run from a shortcut or the native menu", () => {
  const calls = actions();
  const commands = createCommands("darwin", false, calls, AGENTS);
  const planned = commands.filter((command) => command.section === "Planned");
  expect(planned.map((command) => command.id)).toEqual([
    "via-claude",
    "via-codex",
    "via-agy",
    "new-orchestrator",
    "action-log",
  ]);
  expect(planned.every((command) => !command.enabled && command.bindings.length === 0)).toBe(true);
  const native = nativeMenu(commands).flatMap((section) =>
    Array.isArray(section.submenu) ? section.submenu : [],
  );
  expect(native.some((item) => planned.some((command) => command.id === item.id))).toBe(false);
});
test("the shortcut sheet is generated from the registry for each platform", () => {
  const linux = shortcutSheet(createCommands("linux", true, actions(), AGENTS), "linux");
  expect(linux.map((group) => [group.title, group.lead])).toEqual([
    ["App", ""],
    ["Board", ""],
    ["Tiles", "Ctrl+Shift+Space, then"],
  ]);
  expect(linux[0]?.rows).toEqual([
    { label: "Menu", keys: "Alt or F10" },
    { label: "Settings", keys: "Ctrl+Shift+," },
    { label: "Quit", keys: "Ctrl+Shift+Q" },
    { label: "New window", keys: "Ctrl+Shift+O" },
    { label: "New worktree", keys: "Ctrl+Shift+T" },
    { label: "Close window", keys: "Alt+F4" },
    { label: "Copy", keys: "Ctrl+Shift+C" },
    { label: "Paste", keys: "Ctrl+Shift+V" },
    { label: "Interface size", keys: "Ctrl+Shift+= − 0" },
    { label: "Keyboard shortcuts", keys: "Ctrl+Shift+/" },
  ]);
  expect(linux[1]?.rows).toEqual([
    { label: "Focus sidebar", keys: "Ctrl+Shift+B" },
    { label: "Longest waiting", keys: "Ctrl+Shift+N" },
    { label: "Maximize tile", keys: "Ctrl+Shift+Enter" },
  ]);
  expect(linux[2]?.rows).toEqual([
    { label: "Focus", keys: "← → ↑ ↓" },
    { label: "Split right", keys: "R" },
    { label: "Split down", keys: "D" },
    { label: "Close", keys: "W" },
    { label: "Hide", keys: "H" },
    { label: "Swap", keys: "Shift+← → ↑ ↓" },
    { label: "Focus tile", keys: "1–9" },
  ]);
  const mac = shortcutSheet(createCommands("darwin", false, actions(), AGENTS), "darwin");
  expect(mac.map((group) => group.lead)).toEqual(["", "", ""]);
  expect(mac[0]?.rows[0]).toEqual({ label: "Settings", keys: "⌘," });
  expect(mac[1]?.rows).toContainEqual({ label: "Maximize tile", keys: "⇧⌘↩" });
  expect(mac[2]?.rows).toContainEqual({ label: "Focus tile", keys: "⌘1–9" });
  expect(mac[2]?.rows).toContainEqual({ label: "Focus", keys: "⌥⇧⌘← → ↑ ↓" });
  // Every bound sheet row belongs to a real command; developer commands stay off the sheet.
  const labels = linux.flatMap((group) => group.rows.map((row) => row.label));
  expect(labels).not.toContain("Reload");
  // Mixed modifiers in one row list each binding in full.
  const [base] = createCommands("linux", false, actions());
  if (!base) throw new Error("Missing command");
  expect(
    shortcutSheet(
      [
        {
          ...base,
          bindings: [{ code: "KeyA", control: true }],
          sheet: ["Board", "Mixed"],
        },
        {
          ...base,
          bindings: [{ code: "KeyB", alt: true }],
          sheet: ["Board", "Mixed"],
        },
      ],
      "linux",
    )[1]?.rows,
  ).toEqual([{ label: "Mixed", keys: "Ctrl+A, Alt+B" }]);
});
