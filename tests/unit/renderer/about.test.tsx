// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AboutDialog, SCOTT_NOTE } from "../../../src/renderer/about/about-dialog";
import type { AppMenuApi } from "../../../src/shared/app-menu";
import { canvasContext } from "./flight-canvas-fixture";

const menu: AppMenuApi = {
  version: vi.fn(() =>
    Promise.resolve({ app: "0.1.0-nightly.20261021+abcdef0", electron: "44.4.5" }),
  ),
  platform: "linux",
  setView: vi.fn(),
  commands: vi.fn(),
  shortcuts: vi.fn(),
  execute: vi.fn(),
  onOpen: vi.fn(),
  onShortcuts: vi.fn(),
  onSession: vi.fn(),
};
let reduced = false;
beforeEach(() => {
  reduced = false;
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
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(canvasContext().ctx);
  vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
async function open() {
  const close = vi.fn();
  await act(async () => {
    render(<AboutDialog menu={menu} close={close} />);
    await Promise.resolve();
  });
  return close;
}
test("shows About content, nightly version and fixed command links; closes and restores focus", async () => {
  const anchor = document.createElement("button");
  document.body.append(anchor);
  anchor.focus();
  const close = await open();
  expect(screen.getByRole("dialog", { name: "About Foom" })).toBeTruthy();
  expect(screen.getByText("By Scott Lindsey")).toBeTruthy();
  expect(screen.getByText("Nothing needs you. Yet.")).toBeTruthy();
  expect(
    screen.getByText(/Version 0.1.0-nightly.20261021\+abcdef0 · Electron 44.4.5/u),
  ).toBeTruthy();
  for (const label of ["Licenses", "Third-party notices", "Source"])
    fireEvent.click(screen.getByRole("button", { name: label }));
  expect(vi.mocked(menu.execute).mock.calls).toEqual([["licenses"], ["notices"], ["github"]]);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(close).toHaveBeenCalledOnce();
  cleanup();
  expect(document.activeElement).toBe(anchor);
  anchor.remove();
});
test("note opens by keyboard click, Escape closes only the note and restores its button", async () => {
  const close = await open();
  const button = screen.getByRole("button", { name: "A note from Scott" });
  fireEvent.click(button);
  const note = screen.getByRole("dialog", { name: "A note from Scott" });
  expect(document.activeElement).toBe(note);
  expect(note.textContent).toContain(SCOTT_NOTE.split("\n\n")[0]);
  expect(screen.getByText("— Scott")).toBeTruthy();
  expect(button.getAttribute("aria-expanded")).toBe("true");
  fireEvent.keyDown(note, { key: "Escape" });
  expect(close).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(button);
  fireEvent.click(button);
  fireEvent.pointerDown(screen.getByText("Nothing needs you. Yet."));
  expect(screen.queryByRole("dialog", { name: "A note from Scott" })).toBeNull();
  expect(document.activeElement).toBe(button);
  fireEvent.click(button);
  fireEvent.click(button);
  expect(button.getAttribute("aria-expanded")).toBe("false");
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(close).toHaveBeenCalledOnce();
});
test("cancel dismisses a note first, reduced motion draws only once, and rejected versions are tolerated", async () => {
  reduced = true;
  vi.mocked(menu.version).mockRejectedValueOnce(new Error("offline"));
  const close = await open();
  expect(requestAnimationFrame).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "A note from Scott" }));
  fireEvent(
    screen.getByRole("dialog", { name: "About Foom" }),
    new Event("cancel", { cancelable: true }),
  );
  expect(close).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "a" });
});
