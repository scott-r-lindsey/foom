// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LegalDialog } from "../../../src/renderer/about/legal-dialog";
import type { AppMenuApi, LegalDocument } from "../../../src/shared/app-menu";

const menu: AppMenuApi = {
  legal: vi.fn(() => Promise.resolve("License\n<script>inert text</script>\nEnd")),
  onLegal: vi.fn(),
  version: vi.fn(),
  platform: "linux",
  setView: vi.fn(),
  commands: vi.fn(),
  shortcuts: vi.fn(),
  execute: vi.fn(),
  onOpen: vi.fn(),
  onShortcuts: vi.fn(),
  onSession: vi.fn(),
};
beforeEach(() => {
  vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute("open", "");
  });
  vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.removeAttribute("open");
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
async function open(id: LegalDocument = "notices") {
  const close = vi.fn();
  await act(async () => {
    render(<LegalDialog id={id} menu={menu} close={close} />);
    await Promise.resolve();
  });
  return close;
}
test("renders fixed document text as inert selectable text and restores focus on close", async () => {
  const anchor = document.createElement("button");
  document.body.append(anchor);
  anchor.focus();
  const close = await open();
  const dialog = screen.getByRole("dialog", { name: "Third-party notices" });
  expect(menu.legal).toHaveBeenCalledWith("notices");
  expect(screen.getByRole("region", { name: "Third-party notices" }).tabIndex).toBe(0);
  expect(dialog.querySelector("pre")?.textContent).toContain("<script>inert text</script>");
  expect(dialog.querySelector("script")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(close).toHaveBeenCalledOnce();
  cleanup();
  expect(document.activeElement).toBe(anchor);
  anchor.remove();
});
test("licenses dismiss with Escape and outside clicks, never clicks within the dialog", async () => {
  const close = await open("licenses");
  const dialog = screen.getByRole("dialog", { name: "Licenses" });
  expect(menu.legal).toHaveBeenCalledWith("licenses");
  fireEvent.click(screen.getByRole("heading", { name: "Licenses" }));
  vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 10, 500, 500));
  fireEvent.click(dialog, { clientX: 20, clientY: 20 });
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(dialog, { clientX: 1, clientY: 20 });
  expect(close).toHaveBeenCalledOnce();
  fireEvent(dialog, new Event("cancel", { cancelable: true }));
  expect(close).toHaveBeenCalledTimes(2);
});
test("failed bundled reads leave a dismissible dialog", async () => {
  vi.mocked(menu.legal).mockRejectedValueOnce(new Error("missing"));
  const close = await open();
  expect(screen.getByText("Unable to read bundled notices.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(close).toHaveBeenCalledOnce();
});
test.each([false, true])(
  "late read completion after unmount is ignored (failure: %s)",
  async (failure) => {
    let resolve: (value: string) => void = () => {};
    let reject: (reason: Error) => void = () => {};
    vi.mocked(menu.legal).mockReturnValueOnce(
      new Promise<string>((yes, no) => {
        resolve = yes;
        reject = no;
      }),
    );
    await open();
    cleanup();
    await act(async () => {
      if (failure) reject(new Error("late"));
      else resolve("late");
      await Promise.resolve();
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  },
);
