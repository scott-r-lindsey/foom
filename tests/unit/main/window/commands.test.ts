import { expect, test, vi } from "vitest";
import {
  createCommands,
  createShortcuts,
  nativeMenu,
  projectCommands,
} from "../../../../src/main/window/commands";
import type { Binding } from "../../../../src/main/window/commands";
const key = (
  code: string,
  modifiers: Partial<Binding> = {},
  type: "keyDown" | "keyUp" = "keyDown",
) => ({ type, code, control: false, shift: false, alt: false, meta: false, ...modifiers });
const actions = () => ({ board: vi.fn(), zoom: vi.fn(), native: vi.fn() });
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
      if (command.enabled) command.run();
    }
    expect(calls.board).toHaveBeenCalledWith("preset-grid");
    expect(calls.zoom).toHaveBeenCalledWith("reset");
    expect(calls.native).toHaveBeenCalledWith("quit");
    expect(calls.native).toHaveBeenCalledWith("new-window");
    expect(
      projectCommands(commands).every((item) => !("run" in item) && !("bindings" in item)),
    ).toBe(true);
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
  expect(items.map((item) => item.id).sort()).toEqual(commands.map((item) => item.id).sort());
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
