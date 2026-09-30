import { expect, test } from "vitest";
import { nextScale, zoomShortcut } from "../src/appearance";
import type { ZoomDirection } from "../src/appearance";

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
