import { expect, test } from "vitest";
import { TerminalViews } from "../../../../src/main/window/terminal-views";

test("view reservations are exclusive and cannot be released by another window", () => {
  const views = new TerminalViews();
  expect(views.owner("a")).toBeUndefined();
  expect(views.claim("a", 1)).toBe(true);
  expect(views.claim("a", 1)).toBe(true);
  expect(views.claim("a", 2)).toBe(false);
  expect(views.release("a", 2)).toBe(false);
  expect(views.owner("a")).toBe(1);
  expect(views.release("a", 1)).toBe(true);
  expect(views.claim("a", 2)).toBe(true);
});

test("closing releases only that window's views and permits a new view elsewhere", () => {
  const views = new TerminalViews();
  views.claim("a", 1);
  views.claim("b", 2);
  views.claim("c", 1);
  expect(views.close(1)).toEqual(["a", "c"]);
  expect(views.snapshot()).toEqual([{ id: "b", window: 2 }]);
  expect(views.close(1)).toEqual([]);
  expect(views.claim("a", 2)).toBe(true);
});

test("transfers detach before ownership changes and refuse foreign reservations", () => {
  const views = new TerminalViews();
  views.claim("a", 1);
  expect(
    views.transfer("a", 2, 3, () => {
      throw new Error("must not detach");
    }),
  ).toBe(false);
  expect(
    views.transfer("a", 1, 3, () => {
      expect(views.owner("a")).toBe(1);
    }),
  ).toBe(true);
  expect(views.owner("a")).toBe(3);
  expect(views.transfer("hidden", 1, 2, () => {})).toBe(true);
  expect(views.owner("hidden")).toBe(2);
});
