// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import type { createShell } from "../../../../src/renderer/terminal/shell-controller";
import type { ShellView } from "../../../../src/renderer/terminal/shell.d";
import { createTerminalView } from "../../../../src/renderer/terminal/terminal-view-source";
const mock = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../../../../src/renderer/terminal/shell-controller", () => ({ createShell: mock.create }));
afterEach(() => {
  document.body.replaceChildren();
});
test("one passive controller per mount, ordered transfer, focus, subscriptions and disposal", async () => {
  const events: string[] = [];
  let update: ((view: ShellView) => void) | undefined;
  let count = 0;
  mock.create.mockImplementation((_element: HTMLElement, publish: (view: ShellView) => void) => {
    const name = String(++count);
    update = publish;
    return {
      open: (id: string) => {
        events.push(`open ${name} ${id}`);
        return Promise.resolve();
      },
      hide: () => {
        events.push(`hide ${name}`);
        return Promise.resolve();
      },
      dispose: () => {
        events.push(`dispose ${name}`);
      },
      terminal: {
        focus: () => {
          events.push(`focus ${name}`);
        },
      },
    };
  });
  let queue = Promise.resolve();
  const schedule = (operation: () => Promise<void>) => {
    queue = queue.then(operation);
    return queue;
  };
  const owners = new Map<string, ReturnType<typeof createShell>>();
  const first = createTerminalView(schedule, owners),
    second = createTerminalView(schedule, owners);
  await first.open("unmounted");
  await first.hide();
  first.focus();
  await queue;
  const dispose = first.mount(document.createElement("div")),
    disposeSecond = second.mount(document.createElement("div"));
  expect(mock.create).toHaveBeenCalledWith(
    expect.any(HTMLElement),
    expect.any(Function),
    false,
    undefined,
    false,
    false,
    expect.any(Function),
    expect.any(Function),
  );
  const listener = vi.fn(),
    off = second.subscribe(listener);
  const state = { ...second.getSnapshot(), status: "Attached" };
  update?.(state);
  expect(listener).toHaveBeenCalledOnce();
  expect(second.getSnapshot()).toBe(state);
  off();
  update?.(state);
  expect(listener).toHaveBeenCalledOnce();
  await first.open("a");
  await first.open("b");
  await second.open("b");
  second.focus();
  await queue;
  expect(events).toEqual(["open 1 a", "open 1 b", "hide 1", "open 2 b", "focus 2"]);
  await second.open("b");
  await first.open("a");
  await second.hide();
  dispose();
  disposeSecond();
  await queue;
  expect(owners.size).toBe(0);
  expect(events.slice(-4)).toEqual(["hide 1", "dispose 1", "hide 2", "dispose 2"]);
  await second.open("gone");
  second.focus();
  await queue;
});
test("a standalone view has an immediate operation scheduler", async () => {
  const view = createTerminalView();
  await view.open("absent");
  await view.hide();
  view.focus();
});

test("queued opens recheck inventory and failed operations report status without rejecting", async () => {
  let live = true;
  const open = vi.fn(() => Promise.resolve());
  const hide = vi.fn(() => Promise.reject(new Error("connection closed")));
  const dispose = vi.fn();
  mock.create.mockReturnValue({ open, hide, dispose, terminal: { focus: vi.fn() } });
  let queue = Promise.resolve();
  const schedule = (operation: () => Promise<void>) => {
    queue = queue.then(operation, operation);
    return queue;
  };
  const view = createTerminalView(schedule, new Map(), () => live);
  const unmount = view.mount(document.createElement("div"));
  const pending = view.open("removed");
  live = false;
  await pending;
  expect(open).not.toHaveBeenCalled();
  const listener = vi.fn();
  view.subscribe(listener);
  await expect(view.hide()).resolves.toBeUndefined();
  expect(view.getSnapshot().status).toBe("Unable to update terminal view.");
  expect(listener).toHaveBeenCalled();
  unmount();
  await queue.catch(() => {});
  expect(dispose).toHaveBeenCalledOnce();
});

test("a newer sidebar focus choice cancels focus queued behind attachment", async () => {
  const host = document.createElement("div");
  const input = document.createElement("textarea");
  const sidebar = document.createElement("button");
  host.append(input);
  document.body.append(host, sidebar);
  const focus = vi.fn(() => {
    input.focus();
  });
  let release = () => {};
  const attachment = new Promise<void>((resolve) => {
    release = resolve;
  });
  mock.create.mockReturnValue({ open: () => attachment, terminal: { focus } });
  let queue = Promise.resolve();
  const view = createTerminalView((operation) => {
    queue = queue.then(operation);
    return queue;
  });
  view.mount(host);
  input.focus();
  const attaching = view.open("session");
  await Promise.resolve();
  view.focus({ from: document.activeElement });
  sidebar.focus();
  release();
  await attaching;
  await queue;
  expect(document.activeElement).toBe(sidebar);
  expect(focus).not.toHaveBeenCalled();
});

test.each(["unchanged", "round trip", "blur", "hide", "unmount", "new request"])(
  "queued focus respects %s while attachment is held",
  async (choice) => {
    const host = document.createElement("div");
    const input = document.createElement("textarea");
    const other = document.createElement("button");
    host.append(input);
    document.body.append(host, other);
    const focus = vi.fn(() => {
      input.focus();
    });
    const hide = vi.fn(() => Promise.resolve());
    const dispose = vi.fn();
    let release = () => {};
    mock.create.mockReturnValue({
      open: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      hide,
      dispose,
      terminal: { focus },
    });
    let queue = Promise.resolve();
    const view = createTerminalView((operation) => {
      queue = queue.then(operation);
      return queue;
    });
    const unmount = view.mount(host);
    input.focus();
    void view.open("session");
    await Promise.resolve();
    view.focus({ from: document.activeElement });
    if (choice === "round trip") {
      other.focus();
      input.focus();
    } else if (choice === "blur") {
      input.blur();
    } else if (choice === "hide") {
      void view.hide();
    } else if (choice === "unmount") {
      unmount();
    } else if (choice === "new request") {
      view.focus();
    }
    release();
    await queue;
    expect(focus).toHaveBeenCalledTimes(choice === "unchanged" || choice === "new request" ? 1 : 0);
    expect(document.activeElement).toBe(choice === "blur" ? document.body : input);
  },
);

test("a newer focus request in another tile wins before either queued focus runs", async () => {
  const firstInput = document.createElement("textarea");
  const secondInput = document.createElement("textarea");
  document.body.append(firstInput, secondInput);
  const firstFocus = vi.fn(() => {
    firstInput.focus();
  });
  const secondFocus = vi.fn(() => {
    secondInput.focus();
  });
  mock.create
    .mockReturnValueOnce({ terminal: { focus: firstFocus } })
    .mockReturnValueOnce({ terminal: { focus: secondFocus } });
  let queue = Promise.resolve();
  const schedule = (operation: () => Promise<void>) => {
    queue = queue.then(operation);
    return queue;
  };
  const first = createTerminalView(schedule);
  const second = createTerminalView(schedule);
  first.mount(document.createElement("div"));
  second.mount(document.createElement("div"));
  first.focus({ from: document.activeElement });
  second.focus();
  await queue;
  expect(firstFocus).not.toHaveBeenCalled();
  expect(secondFocus).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(secondInput);
});

test("explicit terminal focus completes after the browser's click focus action", async () => {
  const tile = document.createElement("section");
  tile.tabIndex = 0;
  const input = document.createElement("textarea");
  tile.append(input);
  document.body.append(tile);
  const focus = vi.fn(() => {
    input.focus();
  });
  mock.create.mockReturnValue({ terminal: { focus } });
  let queue = Promise.resolve();
  const view = createTerminalView((operation) => {
    queue = queue.then(operation);
    return queue;
  });
  view.mount(tile);
  view.focus();
  // The tile pointer handler requests input focus before the browser's default
  // pointer action puts focus on the section. This is still the same choice.
  tile.focus();
  await queue;
  expect(document.activeElement).toBe(input);
  expect(focus).toHaveBeenCalledOnce();
});

test("a focus choice before the restoration effect runs also revokes restoration", async () => {
  const input = document.createElement("textarea");
  const sidebar = document.createElement("button");
  document.body.append(input, sidebar);
  const focus = vi.fn(() => {
    input.focus();
  });
  mock.create.mockReturnValue({ terminal: { focus } });
  let queue = Promise.resolve();
  const view = createTerminalView((operation) => {
    queue = queue.then(operation);
    return queue;
  });
  view.mount(document.createElement("div"));
  input.focus();
  const restoration = { from: document.activeElement };
  sidebar.focus();
  // React can deliver the tile's effect after the user has made a new choice.
  view.focus(restoration);
  await queue;
  expect(focus).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(sidebar);
});

test.each([false, true])(
  "queued modal hide respects a newer sidebar choice: %s",
  async (newChoice) => {
    const host = document.createElement("div");
    const input = document.createElement("textarea");
    host.append(input);
    const sidebar = document.createElement("button");
    document.body.append(host, sidebar);
    const focus = vi.fn(() => {
      input.focus();
    });
    let release = () => {};
    const attachment = new Promise<void>((resolve) => {
      release = resolve;
    });
    const open = vi.fn(() => {
      host.hidden = false;
      return Promise.resolve();
    });
    open.mockImplementationOnce(() => attachment);
    mock.create.mockReturnValue({
      open,
      hide: () => {
        host.hidden = true;
        input.blur();
        return Promise.resolve();
      },
      terminal: { focus },
    });
    let queue = Promise.resolve();
    const view = createTerminalView((operation) => {
      queue = queue.then(operation);
      return queue;
    });
    view.mount(host);
    void view.open("session");
    await Promise.resolve();
    input.focus();
    // Settings opens and closes while the initial attachment is still held.
    void view.hide();
    void view.open("session");
    const restoration = { from: document.activeElement };
    if (newChoice) sidebar.focus();
    view.focus(restoration);
    release();
    await queue;
    expect(document.activeElement).toBe(newChoice ? sidebar : input);
    expect(focus).toHaveBeenCalledTimes(newChoice ? 0 : 1);
  },
);
