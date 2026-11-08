// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { TerminalMenu } from "../../../../src/renderer/terminal/terminal-menu";
import { initialLayout } from "../../../../src/renderer/board/tiles";

afterEach(cleanup);
test("commands and reused pads close and act; Copy requires a selection", () => {
  const anchor = document.body.appendChild(document.createElement("textarea"));
  const close = vi.fn(),
    action = vi.fn(),
    copy = vi.fn(),
    paste = vi.fn(),
    selectAll = vi.fn(),
    clear = vi.fn();
  const menu = {
    id: "a",
    anchor,
    point: { x: 40, y: 40 },
    copy: undefined,
    paste,
    selectAll,
    clear,
  };
  const result = render(
    <TerminalMenu menu={menu} layout={initialLayout()} close={close} action={action} />,
  );
  fireEvent.scroll(anchor);
  expect(close).not.toHaveBeenCalled();
  expect(
    screen
      .getAllByRole("menuitem")
      .map((item) => item.getAttribute("aria-label") ?? item.textContent),
  ).toEqual([
    "Copy",
    "Paste",
    "Select all",
    "Clear",
    "Split terminal right",
    "Split terminal up",
    "Split terminal left",
    "Split terminal down",
    "Grow right",
    "Grow up",
    "Grow left",
    "Grow down",
  ]);
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Paste" }));
  expect(screen.getByRole("menuitem", { name: "Copy" }).hasAttribute("disabled")).toBe(true);
  result.rerender(
    <TerminalMenu
      menu={{ ...menu, copy }}
      layout={initialLayout()}
      close={close}
      action={action}
    />,
  );
  for (const label of ["Copy", "Paste", "Select all", "Clear"])
    fireEvent.click(screen.getByRole("menuitem", { name: label }));
  for (const command of [copy, paste, selectAll, clear]) expect(command).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("menuitem", { name: "Split terminal right" }));
  expect(action).toHaveBeenCalledWith("right");
  expect(close).toHaveBeenCalledTimes(5);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(document.activeElement).toBe(anchor);
  anchor.remove();
});

test.each([false, true])(
  "link menus contain only link commands and retain keyboard focus (selection=%s)",
  async (selected) => {
    const anchor = document.body.appendChild(document.createElement("textarea"));
    const close = vi.fn(),
      copy = vi.fn().mockResolvedValue(undefined),
      open = vi.fn();
    render(
      <TerminalMenu
        menu={{
          id: "a",
          anchor,
          point: { x: 10, y: 10 },
          copy: selected ? vi.fn() : undefined,
          paste: vi.fn(),
          clear: vi.fn(),
          selectAll: vi.fn(),
          link: { url: "https://example.com/Case", copy, open },
        }}
        layout={initialLayout()}
        close={close}
        action={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Copy link",
      "Open link",
    ]);
    expect(screen.getByRole("menu").querySelector(".tile-pads, hr")).toBeNull();
    const copyItem = screen.getByRole("menuitem", { name: "Copy link" });
    const openItem = screen.getByRole("menuitem", { name: "Open link" });
    expect(document.activeElement).toBe(copyItem);
    fireEvent.keyDown(copyItem, { key: "ArrowDown" });
    expect(document.activeElement).toBe(openItem);
    fireEvent.keyDown(openItem, { key: "ArrowDown" });
    expect(document.activeElement).toBe(copyItem);
    fireEvent.keyDown(copyItem, { key: "End" });
    expect(document.activeElement).toBe(openItem);
    fireEvent.keyDown(openItem, { key: "Home" });
    expect(document.activeElement).toBe(copyItem);
    expect(screen.getByRole("menuitem", { name: "Copy link" }).title).toBe(
      "https://example.com/Case",
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy link" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open link" }));
    expect(copy).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
    copy.mockRejectedValue(new Error("clipboard unavailable"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy link" }));
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(3);
    fireEvent.keyDown(copyItem, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(4);
    expect(document.activeElement).toBe(anchor);
    anchor.remove();
  },
);
