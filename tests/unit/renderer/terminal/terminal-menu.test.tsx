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
  fireEvent.click(screen.getByRole("menuitem", { name: "Split right" }));
  expect(action).toHaveBeenCalledWith("right");
  expect(close).toHaveBeenCalledTimes(5);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(document.activeElement).toBe(anchor);
  anchor.remove();
});
