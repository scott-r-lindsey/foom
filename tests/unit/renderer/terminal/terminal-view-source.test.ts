// @vitest-environment jsdom
import { expect, test, vi } from "vitest";
import type { createShell } from "../../../../src/renderer/terminal/shell-controller";
import type { ShellView } from "../../../../src/renderer/terminal/shell.d";
import { createTerminalView } from "../../../../src/renderer/terminal/terminal-view-source";
const mock = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../../../../src/renderer/terminal/shell-controller", () => ({ createShell: mock.create }));
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
  expect(view.getSnapshot().status).toContain("connection closed");
  expect(listener).toHaveBeenCalled();
  unmount();
  await queue.catch(() => {});
  expect(dispose).toHaveBeenCalledOnce();
});
