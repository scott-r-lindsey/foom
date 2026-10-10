// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppMenu } from "../../../../src/renderer/board/app-menu";
import type { AppMenuApi, AppMenuEntry, ShortcutGroup } from "../../../../src/shared/app-menu";
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(cleanup);
const entries = (scale = 100): AppMenuEntry[] => [
  { kind: "command", id: "settings", label: "Settings…", shortcut: "Ctrl+Shift+,", enabled: true },
  { kind: "command", id: "new-window", label: "New Window", shortcut: "", enabled: false },
  {
    kind: "command",
    id: "maximize",
    label: "Maximize tile",
    shortcut: "Ctrl+Shift+Enter",
    enabled: true,
    checked: true,
  },
  null,
  {
    kind: "submenu",
    id: "settings-menu",
    label: "Settings",
    items: [
      { id: "via-claude", label: "Via Claude Code", shortcut: "", enabled: false, badge: "CC" },
      null,
      { id: "settings", label: "Via Settings UI", shortcut: "Ctrl+Shift+,", enabled: true },
    ],
  },
  {
    kind: "size",
    label: "Size",
    scale,
    smaller: {
      id: "zoom-out",
      label: "Smaller interface",
      shortcut: "Ctrl+Shift+−",
      enabled: true,
    },
    bigger: { id: "zoom-in", label: "Bigger interface", shortcut: "", enabled: true },
  },
  null,
  { kind: "command", id: "quit", label: "Quit Foom", shortcut: "Ctrl+Shift+Q", enabled: true },
];
const sheet: ShortcutGroup[] = [
  { title: "App", lead: "", rows: [{ label: "Menu", keys: "Alt or F10" }] },
  { title: "Board", lead: "", rows: [{ label: "Focus sidebar", keys: "Ctrl+Shift+B" }] },
  { title: "Tiles", lead: "Ctrl+Shift+Space, then", rows: [{ label: "Split right", keys: "R" }] },
];
function fixture() {
  let open = () => {};
  let shortcuts = () => {};
  const dispose = vi.fn();
  const api: AppMenuApi = {
    platform: "linux",
    setView: vi.fn().mockResolvedValue(undefined),
    commands: vi.fn().mockResolvedValue(entries()),
    shortcuts: vi.fn().mockResolvedValue(sheet),
    execute: vi.fn().mockResolvedValue(undefined),
    onSession: vi.fn(),
    onOpen: (callback) => {
      open = callback;
      return dispose;
    },
    onShortcuts: (callback) => {
      shortcuts = callback;
      return vi.fn();
    },
  };
  return {
    api,
    dispose,
    open: () => {
      open();
    },
    shortcuts: () => {
      shortcuts();
    },
  };
}
test("wordmark opens a menu below it, skips disabled actions and restores keyboard focus", async () => {
  const f = fixture();
  const view = render(<AppMenu api={f.api} development />);
  const button = screen.getByRole("button", { name: "Foom menu" });
  fireEvent.click(button);
  const menu = await screen.findByRole("menu", { name: "Foom" });
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(menu.classList.contains("app-menu")).toBe(true);
  expect(screen.getByRole("menuitem", { name: "New Window" })).toHaveProperty("disabled", true);
  expect(document.activeElement?.textContent).toContain("Settings");
  fireEvent.keyDown(menu, { key: "ArrowDown" });
  expect(document.activeElement).toBe(screen.getByRole("menuitemcheckbox"));
  expect(document.activeElement?.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(document.activeElement ?? menu);
  await waitFor(() => {
    expect(f.api.execute).toHaveBeenCalledWith("maximize");
    expect(screen.queryByRole("menu")).toBeNull();
  });
  expect(document.activeElement).not.toBe(button);
  act(f.open);
  await screen.findByRole("menu");
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(button);
  fireEvent.click(button);
  await screen.findByRole("menu");
  fireEvent.click(button);
  expect(screen.queryByRole("menu")).toBeNull();
  view.unmount();
  expect(f.dispose).toHaveBeenCalledOnce();
});
test("macOS gets the same wordmark button; failed or stale loads don't open", async () => {
  const f = fixture();
  const view = render(<AppMenu api={{ ...f.api, platform: "darwin" }} />);
  const mac = screen.getByRole("button", { name: "Foom menu" });
  expect(mac.querySelector(".menu-chevron")).not.toBeNull();
  view.rerender(<AppMenu />);
  expect(screen.queryByRole("button")).toBeNull();
  vi.mocked(f.api.commands).mockRejectedValueOnce(new Error("offline"));
  view.rerender(<AppMenu api={f.api} />);
  fireEvent.click(screen.getByRole("button"));
  await screen.findByRole("alert");
  let resolve: (items: AppMenuEntry[]) => void = () => {};
  vi.mocked(f.api.commands).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  fireEvent.click(screen.getByRole("button"));
  view.unmount();
  await act(async () => {
    resolve([]);
    await Promise.resolve();
  });
  expect(screen.queryByRole("menu")).toBeNull();
});

test("restores the original input selection before dispatch and reports command failures", async () => {
  const f = fixture();
  const view = render(
    <>
      <input aria-label="Edit target" defaultValue="before" />
      <AppMenu api={f.api} />
    </>,
  );
  const input = screen.getByRole<HTMLInputElement>("textbox");
  input.focus();
  input.setSelectionRange(2, 5, "backward");
  const trigger = screen.getByRole("button", { name: "Foom menu" });
  expect(fireEvent.pointerDown(trigger, { button: 0 })).toBe(false);
  expect(fireEvent.pointerDown(trigger, { button: 2 })).toBe(true);
  fireEvent.click(trigger);
  await screen.findByRole("menu");
  // A second keyboard open must not replace the saved target with a menu button.
  act(f.open);
  await act(async () => {
    await Promise.resolve();
  });
  input.setSelectionRange(0, 0);
  vi.mocked(f.api.execute).mockImplementation(() => {
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([
      2,
      5,
      "backward",
    ]);
    return Promise.reject(new Error("Unavailable command"));
  });
  fireEvent.click(screen.getByRole("menuitem", { name: /^Settings…/ }));
  expect(screen.queryByRole("menu")).toBeNull();
  await screen.findByRole("alert");
  expect(document.activeElement).toBe(input);
  view.unmount();
});
test("dismisses before asynchronous focus-changing actions and never refocuses the wordmark", async () => {
  const f = fixture();
  render(
    <>
      <textarea aria-label="Terminal" />
      <button type="button">Sidebar row</button>
      <AppMenu api={f.api} />
    </>,
  );
  const terminal = screen.getByRole<HTMLTextAreaElement>("textbox");
  terminal.focus();
  act(f.open);
  await screen.findByRole("menu");
  let finish = () => {};
  vi.mocked(f.api.execute).mockImplementation(() => {
    screen.getByRole("button", { name: "Sidebar row" }).focus();
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  fireEvent.click(screen.getByRole("menuitemcheckbox"));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement?.textContent).toBe("Sidebar row");
  await act(async () => {
    finish();
    await Promise.resolve();
  });
  expect(document.activeElement?.textContent).toBe("Sidebar row");
});
test("restores document selections and tolerates an edit target removed while the menu is open", async () => {
  const f = fixture();
  const target = document.createElement("div");
  target.tabIndex = 0;
  target.textContent = "selected terminal output";
  document.body.append(target);
  render(<AppMenu api={f.api} />);
  target.focus();
  const range = document.createRange();
  range.selectNodeContents(target);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  act(f.open);
  await screen.findByRole("menu");
  selection?.removeAllRanges();
  vi.mocked(f.api.execute).mockImplementation(() => {
    expect(document.activeElement).toBe(target);
    expect(selection?.toString()).toBe("selected terminal output");
    return Promise.resolve();
  });
  fireEvent.click(screen.getByRole("menuitemcheckbox"));
  await act(async () => {
    await Promise.resolve();
  });
  act(f.open);
  await screen.findByRole("menu");
  target.remove();
  vi.mocked(f.api.execute).mockResolvedValue(undefined);
  fireEvent.click(screen.getByRole("menuitemcheckbox"));
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.queryByRole("menu")).toBeNull();
});

const rect = (left: number, right: number) =>
  ({
    left,
    right,
    top: 50,
    bottom: 80,
    width: right - left,
    height: 30,
    x: left,
    y: 50,
  }) as DOMRect;
test("Settings opens a submenu by keyboard, click or hover and returns focus on Left or Escape", async () => {
  const f = fixture();
  render(<AppMenu api={f.api} />);
  const wordmark = screen.getByRole("button", { name: "Foom menu" });
  fireEvent.click(wordmark);
  const menu = await screen.findByRole("menu", { name: "Foom" });
  const settings = screen.getByRole("menuitem", { name: "Settings" });
  expect(settings.getAttribute("aria-haspopup")).toBe("menu");
  expect(settings.getAttribute("aria-expanded")).toBe("false");
  settings.focus();
  fireEvent.keyDown(settings, { key: "ArrowRight" });
  const sub = screen.getByRole("menu", { name: "Settings" });
  expect(sub.classList.contains("row-submenu")).toBe(true);
  expect(settings.getAttribute("aria-expanded")).toBe("true");
  // The disabled agent entry is skipped, in the submenu as at the top level.
  const ui = screen.getByRole("menuitem", { name: /Via Settings UI/ });
  expect(document.activeElement).toBe(ui);
  fireEvent.keyDown(ui, { key: "ArrowDown" });
  expect(document.activeElement).toBe(ui);
  fireEvent.keyDown(ui, { key: "ArrowLeft" });
  expect(screen.queryByRole("menu", { name: "Settings" })).toBeNull();
  expect(document.activeElement).toBe(settings);
  fireEvent.click(settings);
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: /Via Settings UI/ }));
  fireEvent.keyDown(document.activeElement ?? sub, { key: "Escape" });
  expect(screen.queryByRole("menu", { name: "Settings" })).toBeNull();
  expect(screen.getByRole("menu", { name: "Foom" })).toBe(menu);
  expect(document.activeElement).toBe(settings);
  // Hover opens without moving focus; hovering another item closes it.
  const quit = screen.getByRole("menuitem", { name: /Quit Foom/ });
  quit.focus();
  fireEvent.pointerEnter(settings);
  expect(screen.getByRole("menu", { name: "Settings" })).toBeTruthy();
  expect(document.activeElement).toBe(quit);
  // Right on an already open submenu moves focus into it.
  fireEvent.keyDown(settings, { key: "ArrowRight" });
  fireEvent.pointerEnter(quit);
  expect(screen.queryByRole("menu", { name: "Settings" })).toBeNull();
  // Pressing inside the submenu doesn't dismiss; a disabled entry does nothing.
  fireEvent.pointerEnter(settings);
  const claude = screen.getByRole("menuitem", { name: /Via Claude Code/ });
  expect(claude).toHaveProperty("disabled", true);
  expect(claude.querySelector(".board-agent")?.textContent).toBe("CC");
  fireEvent.pointerDown(claude);
  fireEvent.click(claude);
  expect(screen.getByRole("menu", { name: "Settings" })).toBeTruthy();
  expect(f.api.execute).not.toHaveBeenCalled();
  // Focus lost to the body after pressing a disabled entry: Escape still dismisses.
  (document.activeElement as HTMLElement | null)?.blur();
  fireEvent.keyDown(document.body, { key: "a" });
  expect(screen.getByRole("menu", { name: "Foom" })).toBeTruthy();
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(wordmark);
  fireEvent.click(wordmark);
  await screen.findByRole("menu", { name: "Foom" });
  fireEvent.pointerEnter(screen.getByRole("menuitem", { name: "Settings" }));
  // Tab from the submenu closes every level and returns to the wordmark.
  fireEvent.keyDown(screen.getByRole("menuitem", { name: /Via Settings UI/ }), { key: "Tab" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(wordmark);
  fireEvent.click(wordmark);
  await screen.findByRole("menu", { name: "Foom" });
  fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /Via Settings UI/ }));
  expect(screen.queryByRole("menu")).toBeNull();
  await waitFor(() => {
    expect(f.api.execute).toHaveBeenCalledWith("settings");
  });
  fireEvent.click(wordmark);
  await screen.findByRole("menu", { name: "Foom" });
  fireEvent.pointerEnter(screen.getByRole("menuitem", { name: "Settings" }));
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("menu")).toBeNull();
});
test("the submenu sits beside Settings and flips left without room on the right", async () => {
  const f = fixture();
  render(<AppMenu api={f.api} />);
  fireEvent.click(screen.getByRole("button", { name: "Foom menu" }));
  await screen.findByRole("menu", { name: "Foom" });
  const settings = screen.getByRole("menuitem", { name: "Settings" });
  const bounds = vi.spyOn(settings, "getBoundingClientRect").mockReturnValue(rect(100, 300));
  fireEvent.click(settings);
  expect(screen.getByRole("menu", { name: "Settings" }).style.left).toBe("310px");
  fireEvent.keyDown(document.activeElement ?? settings, { key: "Escape" });
  bounds.mockReturnValue(rect(window.innerWidth - 120, window.innerWidth - 4));
  fireEvent.click(settings);
  expect(screen.getByRole("menu", { name: "Settings" }).style.left).toBe(
    `${String(window.innerWidth - 130)}px`,
  );
});
test("the Size row is one stop, steps without closing and shows main's size", async () => {
  const f = fixture();
  render(<AppMenu api={f.api} />);
  fireEvent.click(screen.getByRole("button", { name: "Foom menu" }));
  const menu = await screen.findByRole("menu", { name: "Foom" });
  expect(screen.getByRole("group", { name: "Size 100%" })).toBeTruthy();
  const settings = screen.getByRole("menuitem", { name: "Settings" });
  const smaller = screen.getByRole("menuitem", { name: "Smaller interface" });
  const bigger = screen.getByRole("menuitem", { name: "Bigger interface" });
  const quit = screen.getByRole("menuitem", { name: /Quit Foom/ });
  expect(smaller.title).toBe("Smaller interface (Ctrl+Shift+−)");
  expect(bigger.title).toBe("Bigger interface");
  settings.focus();
  fireEvent.keyDown(settings, { key: "ArrowDown" });
  expect(document.activeElement).toBe(smaller);
  fireEvent.keyDown(smaller, { key: "ArrowRight" });
  expect(document.activeElement).toBe(bigger);
  fireEvent.keyDown(bigger, { key: "ArrowDown" });
  expect(document.activeElement).toBe(quit);
  fireEvent.keyDown(quit, { key: "ArrowUp" });
  expect(document.activeElement).toBe(smaller);
  fireEvent.keyDown(smaller, { key: "ArrowRight" });
  fireEvent.keyDown(bigger, { key: "ArrowUp" });
  expect(document.activeElement).toBe(settings);
  fireEvent.keyDown(settings, { key: "ArrowDown" });
  fireEvent.keyDown(smaller, { key: "ArrowRight" });
  fireEvent.keyDown(bigger, { key: "ArrowLeft" });
  expect(document.activeElement).toBe(smaller);
  // Left and Right elsewhere do nothing.
  fireEvent.keyDown(quit, { key: "ArrowLeft" });
  fireEvent.keyDown(quit, { key: "ArrowRight" });
  vi.mocked(f.api.commands).mockResolvedValue(entries(110));
  fireEvent.click(bigger);
  await waitFor(() => {
    expect(screen.getByRole("group", { name: /^Size/ }).textContent).toContain("110%");
  });
  expect(f.api.execute).toHaveBeenCalledWith("zoom-in");
  // Interface size changes resize the window; the menu repositions instead of closing.
  fireEvent(window, new Event("resize"));
  expect(screen.getByRole("menu", { name: "Foom" })).toBe(menu);
  vi.mocked(f.api.execute).mockRejectedValueOnce(new Error("Unavailable"));
  fireEvent.click(smaller);
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Unable to run Smaller interface.",
  );
  fireEvent.pointerEnter(screen.getByRole("group", { name: /^Size/ }));
});
test("the shortcut sheet shows main's columns and returns focus when dismissed", async () => {
  const f = fixture();
  render(
    <>
      <textarea aria-label="Terminal" />
      <AppMenu api={f.api} />
    </>,
  );
  const terminal = screen.getByRole("textbox");
  terminal.focus();
  act(f.shortcuts);
  const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
  expect(
    screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent),
  ).toEqual(["App", "Board", "TilesCtrl+Shift+Space, then"]);
  expect(dialog.textContent).toContain("Alt or F10");
  screen.getByRole("heading", { name: "Keyboard shortcuts" }).focus();
  fireEvent(dialog, new Event("cancel", { cancelable: true }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(terminal);
  act(f.shortcuts);
  const again = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
  fireEvent.click(screen.getByText("Split right"));
  expect(screen.queryByRole("dialog")).not.toBeNull();
  fireEvent.click(again);
  expect(screen.queryByRole("dialog")).toBeNull();
  vi.mocked(f.api.shortcuts).mockRejectedValueOnce(new Error("gone"));
  act(f.shortcuts);
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Unable to show keyboard shortcuts.",
  );
});
