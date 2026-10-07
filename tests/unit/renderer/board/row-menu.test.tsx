// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
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

test("a trusted dialog closes the menu and restores its anchor before taking focus", () => {
  let opening: () => void = () => undefined;
  const off = vi.fn();
  const confirmations = {
    subscribe: vi.fn(() => vi.fn()),
    confirm: vi.fn(() => Promise.resolve()),
    cancel: vi.fn(() => Promise.resolve()),
    onDialog(callback: () => void) {
      opening = callback;
      return off;
    },
  };
  const anchor = document.createElement("button");
  document.body.append(anchor);
  const close = vi.fn();
  const view = render(
    <RowMenu
      anchor={anchor}
      close={close}
      confirmations={confirmations}
      actions={[{ label: "Remove", run: vi.fn() }]}
    />,
  );
  opening();
  expect(close).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(anchor);
  view.unmount();
  expect(off).toHaveBeenCalledOnce();
  anchor.remove();
});

test("an armed menu item confirms in place; choosing another item only disarms", async () => {
  let receive: (
    arm: { nonce: string; target: string; label: string } | null,
    accepted?: boolean,
  ) => void = () => undefined;
  const operation = Promise.withResolvers<undefined>();
  const confirm = vi.fn(() => Promise.resolve());
  const cancel = vi.fn(() => Promise.resolve());
  const confirmations = {
    subscribe(callback: typeof receive) {
      receive = callback;
      return () => undefined;
    },
    confirm,
    cancel,
  };
  const anchor = document.createElement("button");
  document.body.append(anchor);
  const close = vi.fn();
  const other = vi.fn();
  const view = render(
    <RowMenu
      confirmations={confirmations}
      anchor={anchor}
      close={close}
      actions={[
        { label: "Remove", run: () => operation.promise },
        { label: "Other", run: other },
      ]}
    />,
  );
  fireEvent.click(view.getByRole("menuitem", { name: "Remove" }));
  const arm = { nonce: "n", target: "repo", label: "Click again to remove" };
  act(() => {
    receive(arm);
  });
  const armed = view.getByRole("menuitem", { name: arm.label });
  expect(armed.dataset["armed"]).toBe("true");
  fireEvent.click(armed);
  expect(confirm).toHaveBeenCalledWith(arm);
  fireEvent.click(view.getByRole("menuitem", { name: "Other" }));
  expect(other).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledOnce();
  await act(async () => {
    receive(null, false);
    operation.resolve(undefined);
    await operation.promise;
  });
  expect(close).not.toHaveBeenCalled();
  expect(view.getByRole("menuitem", { name: "Remove" })).toBeTruthy();
  view.unmount();
  anchor.remove();
});
