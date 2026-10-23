// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AboutDialog, SCOTT_NOTE } from "../../../src/renderer/about/about-dialog";
import type { AppMenuApi } from "../../../src/shared/app-menu";
import { canvasContext } from "./flight-canvas-fixture";

const menu: AppMenuApi = {
  legal: vi.fn(),
  onLegal: vi.fn(),
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
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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
  const ctx = canvasContext().ctx;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((kind) =>
    kind === "2d" ? ctx : null,
  );
  vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
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

function ReplayAbout({ done }: { done: () => void }) {
  const [open, setOpen] = useState(true);
  return open ? (
    <AboutDialog
      menu={menu}
      close={() => {
        done();
        setOpen(false);
      }}
    />
  ) : null;
}
async function replay() {
  const done = vi.fn();
  await act(async () => {
    render(<ReplayAbout done={done} />);
    await Promise.resolve();
  });
  fireEvent.click(screen.getByRole("button", { name: "Replay launch" }));
  // Flush jsdom’s selectionchange task scheduled by focus.
  act(() => {
    vi.advanceTimersByTime(0);
  });
  return done;
}
test("replay reveals the countdown, closes About after the iris and completes the full linger", async () => {
  const done = await replay();
  expect(screen.getByRole("status").textContent).toBe("3T-minus");
  expect(screen.getByRole("dialog", { name: "About Foom" }).hasAttribute("open")).toBe(true);
  act(() => {
    vi.advanceTimersByTime(500);
  });
  expect(screen.queryByRole("dialog", { name: "About Foom" })).toBeNull();
  act(() => {
    vi.advanceTimersByTime(3400);
  });
  expect(screen.getByRole("status").textContent).toContain("Takeoff was faster");
  act(() => {
    vi.advanceTimersByTime(10_000);
  });
  expect(done).not.toHaveBeenCalled();
  act(() => {
    vi.advanceTimersByTime(200);
  });
  expect(done).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  expect(cancelAnimationFrame).toHaveBeenCalled();
});
for (const elapsed of [100, 1000, 5000]) {
  for (const key of ["Escape", "Enter", " ", "click"]) {
    test(`replay dismisses once at ${String(elapsed)}ms via ${key} and disposes all timers`, async () => {
      const done = await replay();
      act(() => {
        vi.advanceTimersByTime(elapsed);
      });
      const launch = screen.getByRole("dialog", { name: "Launch" });
      if (key === "click") fireEvent.click(launch);
      else fireEvent.keyDown(launch, { key });
      expect(done).toHaveBeenCalledOnce();
      expect(screen.queryByRole("dialog", { name: "Launch replay" })).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });
  }
}
test("reduced replay cross-fades to the still final frame and holds for ten seconds", async () => {
  reduced = true;
  const done = await replay();
  expect(screen.getByRole("status").textContent).toContain("Takeoff was faster");
  expect(document.querySelector(".launch-replay-scene")?.getAttribute("data-reduced")).toBe("true");
  expect(requestAnimationFrame).not.toHaveBeenCalled();
  act(() => {
    vi.advanceTimersByTime(200);
  });
  expect(screen.queryByRole("dialog", { name: "About Foom" })).toBeNull();
  act(() => {
    vi.advanceTimersByTime(9800);
  });
  expect(done).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
test("native cancellation and clicks outside the iris dismiss and unmount cancels pending work", async () => {
  const done = await replay();
  fireEvent(
    screen.getByRole("dialog", { name: "Launch replay" }),
    new Event("cancel", { cancelable: true }),
  );
  expect(done).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  await replay();
  fireEvent.click(screen.getByRole("dialog", { name: "Launch replay" }));
  expect(vi.getTimerCount()).toBe(0);
  await replay();
  cleanup();
  expect(vi.getTimerCount()).toBe(0);
});

for (const elapsed of [100, 1000, 14_100]) {
  test(`replay releases native modality before completing at ${String(elapsed)}ms`, async () => {
    const done = await replay();
    const openAtDone: boolean[] = [];
    done.mockImplementation(() => {
      openAtDone.push(document.querySelector(".launch-replay")?.hasAttribute("open") ?? false);
    });
    act(() => {
      vi.advanceTimersByTime(elapsed);
    });
    if (elapsed < 14_100)
      fireEvent.keyDown(screen.getByRole("dialog", { name: "Launch" }), { key: "Escape" });
    expect(openAtDone).toEqual([false]);
    expect(done).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
}
for (const reducedMotion of [false, true]) {
  for (const key of ["Enter", " ", "Escape"]) {
    test(`Tab remains in replay and ${key} dismisses with reduced motion ${String(reducedMotion)}`, async () => {
      reduced = reducedMotion;
      const done = await replay();
      fireEvent.keyDown(screen.getByRole("dialog", { name: "Launch" }), { key: "Tab" });
      const modal = screen.getByRole("dialog", { name: "Launch replay" });
      expect(document.activeElement).toBe(modal);
      for (const modifier of ["Shift", "Control", "Alt", "Meta"]) {
        fireEvent.keyDown(modal, { key: modifier });
      }
      expect(done).not.toHaveBeenCalled();
      fireEvent.keyDown(modal, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(modal);
      // Flush jsdom's selectionchange task from the focus move.
      act(() => {
        vi.advanceTimersByTime(0);
      });
      if (!reducedMotion) {
        fireEvent.keyDown(modal, { key: "a" });
        expect(done).not.toHaveBeenCalled();
      }
      fireEvent.keyDown(modal, { key });
      expect(done).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });
  }
}
