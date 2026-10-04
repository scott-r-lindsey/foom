import { expect, test } from "vitest";
import {
  anchoredOrigin,
  initialSize,
  boardShortcut,
  BOARD_COMMANDS,
  createBoardShortcuts,
  nextScale,
  scaledBounds,
  scaledSize,
  zoomShortcut,
} from "../../../../src/main/window/appearance";
import type { ZoomDirection } from "../../../../src/main/window/appearance";

test("interface scale moves between fixed steps and stops at the ends", () => {
  expect(nextScale(100, "in")).toBe(110);
  expect(nextScale(100, "out")).toBe(90);
  expect(nextScale(150, "in")).toBe(150);
  expect(nextScale(80, "out")).toBe(80);
  expect(nextScale(130, "reset")).toBe(100);
  // A value between steps moves to the neighbouring step.
  expect(nextScale(105, "in")).toBe(110);
  expect(nextScale(105, "out")).toBe(100);
});

const key = (
  code: string,
  modifiers: { control?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {},
  type: "keyDown" | "keyUp" = "keyDown",
) => ({
  type,
  code,
  control: false,
  shift: false,
  alt: false,
  meta: false,
  ...modifiers,
});

test("Linux and Windows use Ctrl+Shift to zoom and Ctrl+0 to reset", () => {
  const cases: [ReturnType<typeof key>, ZoomDirection | undefined][] = [
    [key("Equal", { control: true, shift: true }), "in"],
    [key("NumpadAdd", { control: true, shift: true }), "in"],
    [key("Minus", { control: true, shift: true }), "out"],
    [key("NumpadSubtract", { control: true, shift: true }), "out"],
    [key("Digit0", { control: true }), "reset"],
    [key("Numpad0", { control: true, shift: true }), "reset"],
    // Plain Ctrl+- and Ctrl+= belong to the terminal.
    [key("Minus", { control: true }), undefined],
    [key("Equal", { control: true }), undefined],
    [key("Equal", { control: true, shift: true, alt: true }), undefined],
    [key("Equal", { control: true, shift: true, meta: true }), undefined],
    [key("Equal", { shift: true }), undefined],
    [key("KeyA", { control: true, shift: true }), undefined],
    [key("Equal", { control: true, shift: true }, "keyUp"), undefined],
  ];
  for (const platform of ["linux", "win32"] as const)
    for (const [input, expected] of cases)
      expect(zoomShortcut(input, platform), `${platform} ${JSON.stringify(input)}`).toBe(expected);
});

test("macOS uses Command, which never reaches the terminal", () => {
  expect(zoomShortcut(key("Equal", { meta: true }), "darwin")).toBe("in");
  expect(zoomShortcut(key("Equal", { meta: true, shift: true }), "darwin")).toBe("in");
  expect(zoomShortcut(key("Minus", { meta: true }), "darwin")).toBe("out");
  expect(zoomShortcut(key("Digit0", { meta: true }), "darwin")).toBe("reset");
  expect(zoomShortcut(key("Equal", { control: true, shift: true }), "darwin")).toBeUndefined();
  expect(zoomShortcut(key("Equal", { meta: true, control: true }), "darwin")).toBeUndefined();
});

test("window sizes follow the scale and always fit the screen's usable area", () => {
  const area = { x: 0, y: 25, width: 1280, height: 775 };
  expect(scaledSize({ width: 900, height: 640 }, 120, area)).toEqual({ width: 1080, height: 768 });
  expect(scaledSize({ width: 900, height: 640 }, 150, area)).toEqual({ width: 1280, height: 775 });
  const bounds = { x: 100, y: 50, width: 900, height: 640 };
  const base = { width: 900, height: 640 };
  // Grows from the top-left corner while it fits.
  expect(scaledBounds(bounds, base, 110, area)).toEqual({
    x: 100,
    y: 50,
    width: 990,
    height: 704,
  });
  // Past an edge, the window moves back onto the screen.
  expect(scaledBounds(bounds, base, 150, area)).toEqual({ x: 0, y: 25, width: 1280, height: 775 });
  // Never below the minimum at that scale, even for a small window.
  expect(scaledBounds(bounds, { width: 300, height: 200 }, 100, area)).toMatchObject({
    width: 900,
    height: 640,
  });
});

test("a scaled window can move to an origin and keep room for its frame", () => {
  const area = { x: 0, y: 0, width: 1280, height: 800 };
  const bounds = { x: 100, y: 100, width: 900, height: 670 };
  const frame = { width: 0, height: 30 };
  // The page scales; the title bar doesn't.
  expect(
    scaledBounds(bounds, { width: 900, height: 640 }, 110, area, { x: 90.4, y: 50 }, frame),
  ).toEqual({ x: 90, y: 50, width: 990, height: 734 });
  // A page as tall as the screen leaves room for the title bar.
  expect(scaledBounds(bounds, { width: 900, height: 900 }, 100, area, bounds, frame)).toMatchObject(
    { y: 0, height: 800 },
  );
});

test("the anchored origin keeps the page under the pointer through a zoom", () => {
  const bounds = { x: 100, y: 100, width: 900, height: 670 };
  const content = { x: 100, y: 130, width: 900, height: 640 };
  // The pointer at the page's top-left corner: the window doesn't move.
  expect(anchoredOrigin(bounds, content, { x: 100, y: 130 }, 1.5)).toEqual({ x: 100, y: 100 });
  // 200px into the page: growing by 10% moves the window 20px the other way.
  const moved = anchoredOrigin(bounds, content, { x: 300, y: 330 }, 1.1);
  expect(moved.x).toBeCloseTo(80);
  expect(moved.y).toBeCloseTo(80);
});

test("board chords reserve only platform navigation, preserving terminal control keys", () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    const modifiers =
      platform === "darwin" ? { meta: true, shift: true } : { control: true, shift: true };
    expect(boardShortcut(key("Comma", { ...modifiers, shift: false }), platform)).toBe("settings");
    expect(boardShortcut(key("Comma", modifiers), platform)).toBeUndefined();
    expect(boardShortcut(key("KeyB", modifiers), platform)).toBe("sidebar");
    expect(boardShortcut(key("KeyN", modifiers), platform)).toBe("next-waiting");
    for (const input of [
      key("KeyB", { control: true }),
      key("KeyN"),
      key("Escape"),
      key("KeyC", modifiers),
      key("KeyB", { ...modifiers, alt: true }),
      key("KeyB", { ...modifiers, control: true, meta: true }),
      key("KeyB", modifiers, "keyUp"),
    ])
      expect(boardShortcut(input, platform)).toBeUndefined();
  }
});

test("starting size uses the work area with a scaled minimum and fits small displays", () => {
  expect(initialSize(100, { width: 1920, height: 1080 })).toEqual({ width: 1152, height: 648 });
  expect(initialSize(100, { width: 1000, height: 700 })).toEqual({ width: 900, height: 640 });
  expect(initialSize(150, { width: 1600, height: 1000 })).toEqual({ width: 1350, height: 960 });
  expect(initialSize(100, { width: 800, height: 600 })).toEqual({ width: 800, height: 600 });
});

test("restored dimensions respect the minimum and current display without rescaling", () => {
  expect(initialSize(120, { width: 1920, height: 1080 }, { width: 1400, height: 900 })).toEqual({
    width: 1400,
    height: 900,
  });
  expect(initialSize(100, { width: 1280, height: 800 }, { width: 1800, height: 1000 })).toEqual({
    width: 1280,
    height: 800,
  });
  expect(initialSize(100, { width: 1280, height: 800 }, { width: 600, height: 400 })).toEqual({
    width: 900,
    height: 640,
  });
});

test("tile chords cover both platforms without consuming plain terminal keys", () => {
  for (const platform of ["darwin"] as const) {
    const modifier = { meta: true };
    for (let index = 1; index <= 9; index++)
      expect(boardShortcut(key(`Digit${String(index)}`, modifier), platform)).toBe(
        `tile-${String(index)}`,
      );
    expect(boardShortcut(key("Enter", { ...modifier, shift: true }), platform)).toBe("maximize");
    for (const [code, command] of Object.entries({
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "up",
      ArrowDown: "down",
      KeyR: "split-right",
      KeyD: "split-down",
      KeyW: "close-tile",
      KeyH: "hide-session",
    })) {
      expect(boardShortcut(key(code, { ...modifier, shift: true, alt: true }), platform)).toBe(
        command,
      );
      expect(boardShortcut(key(code, { ...modifier, alt: true }), platform)).toBeUndefined();
    }
    expect(
      boardShortcut(key("KeyX", { ...modifier, shift: true, alt: true }), platform),
    ).toBeUndefined();
    expect(boardShortcut(key("KeyW", modifier), platform)).toBeUndefined();
  }
});

test.each(["linux", "win32"] as const)(
  "%s command bindings avoid AltGr, OS chords and plain Ctrl letters/numbers",
  (platform) => {
    const seen = new Set<string>();
    for (const command of BOARD_COMMANDS) {
      const binding = command.leader
        ? `leader:${command.code}`
        : `ctrl:${String(command.shift)}:${command.code}`;
      expect(seen.has(binding)).toBe(false);
      seen.add(binding);
      if (!command.leader) {
        expect(command.alt).toBe(false);
        expect(command.shift || !/^Key/.test(command.code)).toBe(true);
      }
      expect(
        boardShortcut(key(command.code, { control: true, alt: true, shift: true }), platform),
      ).toBeUndefined();
      const shortcuts = createBoardShortcuts(platform, () => 100);
      if (command.leader) {
        expect(shortcuts.handle(key("Space", { control: true, shift: true }))).toEqual({
          handled: true,
        });
        expect(shortcuts.handle(key(command.code))).toEqual({ handled: true, command: command.id });
      }
    }
    for (let i = 1; i <= 9; i++)
      expect(boardShortcut(key(`Digit${String(i)}`, { control: true }), platform)).toBeUndefined();
  },
);
test("leader cancels on timeout, blur, Escape or unmatched input and preserves modifier/key-up events", () => {
  let time = 100;
  const shortcuts = createBoardShortcuts("linux", () => time);
  const arm = () => shortcuts.handle(key("Space", { control: true, shift: true }));
  arm();
  expect(shortcuts.handle(key("ShiftLeft", { shift: true }))).toEqual({ handled: false });
  expect(shortcuts.handle(key("Space", {}, "keyUp"))).toEqual({ handled: false });
  expect(shortcuts.handle(key("KeyR"))).toEqual({ handled: true, command: "split-right" });
  arm();
  time += 2000;
  expect(shortcuts.handle(key("KeyR"))).toEqual({ handled: false });
  arm();
  shortcuts.reset();
  expect(shortcuts.handle(key("KeyR"))).toEqual({ handled: false });
  arm();
  expect(shortcuts.handle(key("Escape"))).toEqual({ handled: true });
  arm();
  expect(shortcuts.handle(key("KeyC", { control: true }))).toEqual({ handled: false });
  expect(shortcuts.handle(key("KeyR"))).toEqual({ handled: false });
  arm();
  expect(shortcuts.handle(key("KeyX"))).toEqual({ handled: false });
  expect(shortcuts.handle(key("KeyB", { control: true, shift: true }))).toEqual({
    handled: true,
    command: "sidebar",
  });
  const mac = createBoardShortcuts("darwin");
  expect(mac.handle(key("KeyR", { meta: true, alt: true, shift: true }))).toEqual({
    handled: true,
    command: "split-right",
  });
});
