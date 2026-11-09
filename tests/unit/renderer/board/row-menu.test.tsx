// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ArmedConfirmation } from "../../../../src/shared/confirmation";
import { RowMenu } from "../../../../src/renderer/board/row-menu";
afterEach(cleanup);
test("menu uses untransformed dimensions to fit the viewport, navigates and restores focus on Escape", () => {
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
    height: 192,
    toJSON: () => ({}),
  });
  const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(200);
  const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(220);
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
  height.mockRestore();
  width.mockRestore();
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

test("footer panel aligns its bottom with the gear and points at it", () => {
  const sidebar = document.createElement("aside");
  sidebar.className = "sidebar-shell";
  const anchor = document.createElement("button");
  sidebar.append(anchor);
  document.body.append(sidebar);
  const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 100,
    y: 500,
    left: 100,
    top: 500,
    bottom: 526,
    right: 280,
    width: 24,
    height: 26,
    toJSON: () => ({}),
  });
  const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(200);
  const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(400);
  const view = render(
    <RowMenu
      anchor={anchor}
      bottomAligned
      close={() => {}}
      actions={[{ label: "Settings", run: () => {} }]}
      panel={{
        title: "Foom config",
        kind: "Settings folder",
        mark: "config",
        facts: null,
        pinned: true,
      }}
    />,
  );
  const panel = view.getByRole("dialog");
  expect(panel.style.top).toBe("326px");
  expect(panel.style.left).toBe("290px");
  expect(panel.style.getPropertyValue("--notch")).toBe("187px");
  rect.mockRestore();
  height.mockRestore();
  width.mockRestore();
  sidebar.remove();
});

test("programmatic menu dismissal restores its anchor and respects focus moved elsewhere", () => {
  const anchor = document.createElement("button");
  const other = document.createElement("input");
  document.body.append(anchor, other);
  const props = { anchor, actions: [{ label: "Action", run: vi.fn() }], close: vi.fn() };
  const menu = render(<RowMenu {...props} />);
  menu.unmount();
  expect(document.activeElement).toBe(anchor);
  const next = render(<RowMenu {...props} />);
  other.focus();
  next.unmount();
  expect(document.activeElement).toBe(other);
  anchor.remove();
  other.remove();
});

test("pointer pinning leaves focus to the pressed launcher while keyboard pinning selects the first", () => {
  const anchor = document.createElement("button");
  document.body.append(anchor);
  anchor.focus();
  const pin = vi.fn();
  const panel = {
    title: "Checkout",
    kind: "Worktree",
    mark: "checkout",
    facts: null,
    pinned: false,
    pin,
  };
  const actions = [
    { label: "Agent", run: vi.fn() },
    { label: "Shell", run: vi.fn() },
  ];
  const props = { anchor, actions, close: vi.fn() };
  const view = render(<RowMenu {...props} panel={panel} />);
  const shell = view.getByRole("menuitem", { name: "Shell" });
  fireEvent.pointerDown(shell);
  expect(pin).toHaveBeenCalledOnce();
  view.rerender(<RowMenu {...props} panel={{ ...panel, pinned: true }} />);
  expect(document.activeElement).toBe(anchor);
  shell.focus();
  expect(document.activeElement).toBe(shell);
  view.rerender(<RowMenu {...props} panel={panel} />);
  view.rerender(<RowMenu {...props} panel={{ ...panel, pinned: true }} />);
  expect(document.activeElement).toBe(view.getByRole("menuitem", { name: "Agent" }));
  view.unmount();
  anchor.remove();
});

test("nested menu actions retain the shared-agent confirmation until accepted", async () => {
  const listeners = new Set<(arm: ArmedConfirmation | null, accepted?: boolean) => void>();
  const operation = Promise.withResolvers<undefined>();
  const confirm = vi.fn(() => {
    operation.resolve(undefined);
    return Promise.resolve();
  });
  const confirmations = {
    subscribe(callback: Parameters<typeof listeners.add>[0]) {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    confirm,
    cancel: vi.fn(() => Promise.resolve()),
  };
  const anchor = document.createElement("button");
  document.body.append(anchor);
  const close = vi.fn();
  const run = vi.fn(() => operation.promise);
  const view = render(
    <RowMenu
      anchor={anchor}
      close={close}
      confirmations={confirmations}
      actions={[{ label: "New agent", run: () => {}, submenu: [{ label: "Codex", run }] }]}
    />,
  );
  fireEvent.click(view.getByRole("menuitem", { name: "New agent" }));
  fireEvent.click(view.getByRole("menuitem", { name: "Codex" }));
  const arm = { nonce: "n", target: "repo", label: "Click again for multiple agents here" };
  act(() => {
    for (const receive of listeners) receive(arm);
  });
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("menuitem", { name: arm.label }));
  expect(confirm).toHaveBeenCalledExactlyOnceWith(arm);
  await act(async () => {
    await operation.promise;
  });
  expect(run).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  view.unmount();
  anchor.remove();
});

test("an unarmed launch dismisses before dispatch and does not wait for startup", () => {
  const anchor = document.createElement("button");
  document.body.append(anchor);
  const order: string[] = [];
  const view = render(
    <RowMenu
      anchor={anchor}
      actions={[
        {
          label: "Shell",
          dismissBeforeRun: true,
          run: () => {
            order.push("launch");
            return Promise.resolve();
          },
        },
      ]}
      close={() => {
        order.push("close");
      }}
    />,
  );
  fireEvent.click(view.getByRole("menuitem", { name: "Shell" }));
  expect(order).toEqual(["close", "launch"]);
  anchor.remove();
});

test("late panel facts and pinning keep commands stationary; explicit resize refits the viewport", () => {
  const anchor = document.createElement("button");
  document.body.append(anchor);
  let resized = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 100,
    y: 650,
    left: 100,
    top: 650,
    bottom: 670,
    right: 120,
    width: 20,
    height: 20,
    toJSON: () => ({}),
  });
  const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(100);
  const props = {
    anchor,
    keepOnResize: true,
    close: vi.fn(),
    actions: [{ label: "New agent", run: () => {} }],
    panel: {
      title: "Repository",
      kind: "Repository",
      mark: "repository",
      facts: null,
      pinned: false,
    },
  };
  const view = render(<RowMenu {...props} />);
  try {
    const panel = view.getByRole("dialog");
    expect(panel.style.top).toBe("650px");
    expect(panel.style.maxHeight).toBe(`${String(window.innerHeight - 658)}px`);
    height.mockReturnValue(200);
    act(() => {
      resized();
    });
    expect(panel.style.top).toBe("650px");
    view.rerender(<RowMenu {...props} panel={{ ...props.panel, pinned: true }} />);
    expect(panel.style.top).toBe("650px");
    // A requested resize is allowed to re-anchor; content arrival and pinning are not.
    fireEvent.resize(window);
    expect(panel.style.top).toBe(`${String(window.innerHeight - 208)}px`);
    expect(panel.style.maxHeight).toBe("200px");
  } finally {
    view.unmount();
    rect.mockRestore();
    height.mockRestore();
    vi.unstubAllGlobals();
    anchor.remove();
  }
});

test("scrolling a panel body dismisses every submenu while retaining the panel", () => {
  const anchor = document.createElement("button");
  document.body.append(anchor);
  const close = vi.fn();
  const view = render(
    <RowMenu
      anchor={anchor}
      close={close}
      panel={{
        title: "Repository",
        kind: "Repository",
        mark: "repository",
        facts: null,
        pinned: true,
      }}
      actions={[
        {
          label: "New agent",
          run: () => {},
          submenu: [
            { label: "Builder", run: () => {}, submenu: [{ label: "Claude Code", run: () => {} }] },
          ],
        },
      ]}
    />,
  );
  fireEvent.pointerEnter(view.getByRole("menuitem", { name: "New agent" }));
  fireEvent.pointerEnter(view.getByRole("menuitem", { name: "Builder" }));
  expect(view.getByRole("menu", { name: "Builder" })).toBeTruthy();
  const panel = view.getByRole("dialog");
  const body = panel.querySelector(".panel-body");
  expect(body).not.toBeNull();
  if (body) fireEvent.scroll(body);
  expect(view.queryByRole("menu", { name: "New agent" })).toBeNull();
  expect(view.queryByRole("menu", { name: "Builder" })).toBeNull();
  expect(view.getByRole("dialog")).toBe(panel);
  expect(close).not.toHaveBeenCalled();
  view.unmount();
  anchor.remove();
});
