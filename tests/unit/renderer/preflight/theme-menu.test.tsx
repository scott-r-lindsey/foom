// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ThemeMenu } from "../../../../src/renderer/preflight/theme-menu";
import {
  ConfigThemeLauncherContext,
  CustomThemeHint,
} from "../../../../src/renderer/preflight/custom-theme-hint";

afterEach(cleanup);
test("opens the selected theme, navigates and dismisses without changing selection", () => {
  const onChange = vi.fn();
  const view = render(
    <ThemeMenu
      label="Theme"
      selected="follow"
      choices={[
        { id: "follow", name: "Default" },
        { id: "dark", name: "Dark" },
        { id: "custom", name: "Personal", custom: true },
      ]}
      onChange={onChange}
    />,
  );
  const trigger = screen.getByRole("button", { name: "Theme Default" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  fireEvent.keyDown(trigger, { key: "ArrowUp" });
  fireEvent.keyDown(trigger, { key: "a" });
  expect(screen.getByRole("menuitemradio", { name: "Default" })).toBe(document.activeElement);
  const menu = screen.getByRole("menu", { name: "Theme" });
  for (const [key, name] of [
    ["ArrowDown", "Dark"],
    ["End", "Personal"],
    ["Home", "Default"],
    ["ArrowUp", "Personal"],
  ] as const) {
    fireEvent.keyDown(menu, { key });
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name }));
  }
  fireEvent.keyDown(menu, { key: "a" });
  fireEvent.keyDown(menu, { key: "Escape" });
  expect(document.activeElement).toBe(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Dark" }));
  expect(onChange).toHaveBeenCalledWith("dark");
  expect(document.activeElement).toBe(trigger);
  view.rerender(
    <ThemeMenu
      label="Theme"
      selected="missing"
      choices={[{ id: "follow", name: "Default" }]}
      onChange={onChange}
    />,
  );
  expect(screen.getByRole("button", { name: "Theme Custom theme" })).toBeTruthy();
  vi.spyOn(menu, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 280, 1000));
  fireEvent.click(screen.getByRole("button", { name: "Theme Custom theme" }));
  expect(menu.style.top).toBe("8px");
  expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "Default" }));
});

test("custom-theme hint opens the board's config launcher", () => {
  const open = vi.fn();
  render(
    <ConfigThemeLauncherContext value={open}>
      <CustomThemeHint />
    </ConfigThemeLauncherContext>,
  );
  fireEvent.click(screen.getByRole("button", { name: "config agent" }));
  expect(open).toHaveBeenCalledOnce();
  expect(screen.getByText(/Want something else/).textContent).toBe(
    "Want something else? Ask a config agent for any theme you can describe.",
  );
});

test("typeahead buffers prefixes, cycles repeated letters and resets after pauses and reopening", () => {
  let now = 1000;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const onChange = vi.fn();
  render(
    <ThemeMenu
      label="Theme"
      selected="default"
      choices={[
        { id: "default", name: "Default" },
        { id: "deep", name: "Deep Field" },
        { id: "dark", name: "Dark" },
        { id: "moon", name: "Moonlight", custom: true },
      ]}
      onChange={onChange}
    />,
  );
  const trigger = screen.getByRole("button", { name: "Theme Default" });
  const menu = screen.getByRole("menu", { hidden: true });
  const focused = (name: string) => {
    expect(screen.getByRole("menuitemradio", { name })).toBe(document.activeElement);
  };
  fireEvent.keyDown(trigger, { key: "D" });
  focused("Deep Field");
  fireEvent.keyDown(menu, { key: "d" });
  focused("Dark");
  fireEvent.keyDown(menu, { key: "d" });
  focused("Default");
  now += 701;
  for (const key of "deEp f") fireEvent.keyDown(menu, { key });
  focused("Deep Field");
  fireEvent.keyDown(menu, { key: "z" });
  focused("Deep Field");
  now += 701;
  fireEvent.keyDown(menu, { key: "m", ctrlKey: true });
  fireEvent.keyDown(menu, { key: "m", metaKey: true });
  fireEvent.keyDown(menu, { key: "m", altKey: true });
  fireEvent.keyDown(menu, { key: "m", isComposing: true });
  focused("Deep Field");
  fireEvent.keyDown(menu, { key: "m" });
  focused("Moonlight");
  fireEvent.keyDown(menu, { key: "Escape" });
  fireEvent.keyDown(trigger, { key: "d" });
  focused("Deep Field");
  fireEvent.keyDown(menu, { key: "Home" });
  fireEvent.keyDown(menu, { key: "m" });
  focused("Moonlight");
  expect(onChange).not.toHaveBeenCalled();
  clock.mockRestore();
});

test("rapid typing keeps the popover open before its queued toggle notification", () => {
  render(
    <ThemeMenu
      label="Theme"
      selected="default"
      choices={[
        { id: "default", name: "Default" },
        { id: "moon", name: "Moonlight" },
      ]}
      onChange={vi.fn()}
    />,
  );
  const menu = screen.getByRole("menu", { hidden: true });
  const toggle = vi.spyOn(menu, "togglePopover").mockImplementation(() => {
    fireEvent(menu, Object.assign(new Event("beforetoggle"), { newState: "open" }));
    menu.style.display = "block";
    return true;
  });
  fireEvent.keyDown(screen.getByRole("button", { name: "Theme Default" }), { key: "M" });
  for (const key of "oon") fireEvent.keyDown(menu, { key });
  expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "Moonlight" }));
  expect(toggle).toHaveBeenCalledOnce();
  expect(menu.style.display).toBe("block");
  fireEvent(menu, Object.assign(new Event("toggle"), { newState: "open" }));
  expect(screen.getByRole("button", { name: "Theme Default" }).getAttribute("aria-expanded")).toBe(
    "true",
  );
});
