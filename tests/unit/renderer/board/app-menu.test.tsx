// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppMenu } from "../../../../src/renderer/board/app-menu";
import type { AppMenuApi, CommandItem } from "../../../../src/shared/app-menu";
afterEach(cleanup);
function fixture() {
  let open = () => {};
  const dispose = vi.fn();
  const items: CommandItem[] = [
    {
      id: "settings",
      label: "Settings…",
      section: "Foom",
      shortcut: "Ctrl+Shift+,",
      enabled: true,
    },
    { id: "new-window", label: "New Window", section: "File", shortcut: "", enabled: false },
    {
      id: "maximize",
      label: "Maximize tile",
      section: "View",
      shortcut: "Ctrl+Shift+Enter",
      enabled: true,
      checked: true,
    },
  ];
  const api: AppMenuApi = {
    platform: "linux",
    setView: vi.fn().mockResolvedValue(undefined),
    commands: vi.fn().mockResolvedValue(items),
    execute: vi.fn().mockResolvedValue(undefined),
    onSession: vi.fn(),
    onOpen: (callback) => {
      open = callback;
      return dispose;
    },
  };
  return {
    api,
    dispose,
    open: () => {
      open();
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
  expect(document.activeElement).toBe(button);
  act(f.open);
  await screen.findByRole("menu");
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.click(button);
  await screen.findByRole("menu");
  fireEvent.click(button);
  expect(screen.queryByRole("menu")).toBeNull();
  view.unmount();
  expect(f.dispose).toHaveBeenCalledOnce();
});
test("macOS and sources without a menu keep the wordmark; failed or stale loads don't open", async () => {
  const f = fixture();
  const view = render(<AppMenu api={{ ...f.api, platform: "darwin" }} />);
  expect(screen.queryByRole("button")).toBeNull();
  view.rerender(<AppMenu />);
  expect(screen.queryByRole("button")).toBeNull();
  vi.mocked(f.api.commands).mockRejectedValueOnce(new Error("offline"));
  view.rerender(<AppMenu api={f.api} />);
  fireEvent.click(screen.getByRole("button"));
  await screen.findByRole("alert");
  let resolve: (items: CommandItem[]) => void = () => {};
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
