// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { RowMenu } from "../../../../src/renderer/board/row-menu";
afterEach(cleanup);
test("menu escapes its anchor, fits the viewport, navigates and restores focus on Escape", () => {
  const anchor = document.createElement("button");
  document.body.append(anchor);
  const close = vi.fn();
  const run = vi.fn();
  const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 270,
    y: 700,
    left: 270,
    top: 700,
    bottom: 720,
    right: 290,
    width: 220,
    height: 200,
    toJSON: () => ({}),
  });
  const view = render(
    <RowMenu
      anchor={anchor}
      actions={[{ label: "Launch", badge: "CC", run }, null, { label: "Pin", run }]}
      close={close}
    />,
  );
  const menu = view.getByRole("menu");
  expect(view.container.contains(menu)).toBe(false);
  expect(menu.style.top).toBe(`${String(window.innerHeight - 208)}px`);
  expect(document.activeElement).toBe(view.getByRole("menuitem", { name: "Launch" }));
  fireEvent.keyDown(menu, { key: "ArrowUp" });
  expect(document.activeElement).toBe(view.getByRole("menuitem", { name: "Pin" }));
  fireEvent.keyDown(menu, { key: "ArrowDown" });
  expect(document.activeElement?.textContent).toContain("Launch");
  fireEvent.keyDown(menu, { key: "End" });
  expect(document.activeElement?.textContent).toBe("Pin");
  fireEvent.keyDown(menu, { key: "Home" });
  expect(document.activeElement?.textContent).toContain("Launch");
  fireEvent.keyDown(menu, { key: "x" });
  expect(close).not.toHaveBeenCalled();
  fireEvent.keyDown(menu, { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(anchor);
  fireEvent.keyDown(menu, { key: "Tab" });
  expect(close).toHaveBeenCalledTimes(2);
  fireEvent.click(view.getByRole("menuitem", { name: "Pin" }));
  expect(run).toHaveBeenCalledOnce();
  rect.mockRestore();
  anchor.remove();
});
test("outside pointer, tree scroll and resize close, while menu and anchor interactions do not", () => {
  const anchor = document.createElement("button");
  document.body.append(anchor);
  const close = vi.fn();
  const view = render(
    <RowMenu anchor={anchor} actions={[{ label: "Close", run: vi.fn() }]} close={close} />,
  );
  const menu = view.getByRole("menu");
  fireEvent.pointerDown(menu);
  fireEvent.pointerDown(anchor);
  fireEvent.scroll(menu);
  expect(close).not.toHaveBeenCalled();
  fireEvent.pointerDown(document.body);
  fireEvent.scroll(document);
  fireEvent.resize(window);
  expect(close).toHaveBeenCalledTimes(3);
  view.unmount();
  fireEvent.pointerDown(document.body);
  fireEvent.scroll(document);
  fireEvent.resize(window);
  expect(close).toHaveBeenCalledTimes(3);
  anchor.remove();
});
