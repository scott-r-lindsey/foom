// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { DialogRequest } from "../../../src/shared/confirmation";
import { resolveInterfaceTheme } from "../../../src/shared/interface-themes";
import { ConfirmationPage } from "../../../src/renderer/confirmation";
afterEach(cleanup);
test("focuses Cancel for every request, traps Tab, and renders untrusted content as text", () => {
  let receive: (value: DialogRequest | null) => void = () => undefined;
  const off = vi.fn();
  const answer = vi.fn();
  const size = vi.fn();
  const disconnect = vi.fn();
  let measure: () => void = () => undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        measure = callback;
      }
      observe = vi.fn();
      disconnect = disconnect;
    },
  );
  Object.defineProperty(window, "confirmation", {
    configurable: true,
    value: {
      render(callback: (request: DialogRequest | null) => void) {
        receive = callback;
        return off;
      },
      answer,
      size,
    },
  });
  const view = render(<ConfirmationPage />);
  expect(view.queryByRole("alertdialog")).toBeNull();
  const request: DialogRequest = {
    id: "one",
    title: "Remove <script>branch</script>?",
    worktrees: [{ branch: "merged" }, { branch: "kept", reason: "running" }],
    changes: "?? <img src=x>\0",
    detail: "<script>disclosure</script>",
    accept: "Discard 1 change and remove",
    theme: {
      ...resolveInterfaceTheme("follow", false),
      version: 2,
      areas: { dialogs: { ink: "#010203" } },
      states: { focus: "#223344" },
      shape: { radius: 0, shadow: 0.4 },
    },
  };
  act(() => {
    receive(request);
  });
  expect(document.documentElement.style.getPropertyValue("--ink")).toBe("#010203");
  expect(document.documentElement.style.getPropertyValue("--shape-radius")).toBe("0px");
  expect(document.documentElement.style.getPropertyValue("--shape-shadow")).toBe("0.4");
  expect(document.documentElement.style.getPropertyValue("--state-focus")).toBe("#223344");
  expect(view.getByRole("alertdialog").textContent).toContain("<img src=x>");
  expect(view.container.querySelector("img")).toBeNull();
  expect(view.getByText("<script>disclosure</script>")).toBeTruthy();
  expect(view.container.querySelector("script")).toBeNull();
  expect(view.getByRole("list", { name: "Worktrees to delete" }).textContent).toBe("merged");
  expect(view.getByRole("list", { name: "Skipped worktrees" }).textContent).toBe("keptrunning");
  const card = view.getByRole("alertdialog");
  const content = view.getByRole("region", { name: "Details" });
  const body = content.firstElementChild;
  if (!body) throw Error("Missing dialog content");
  const heights = (cardHeight: number, contentHeight: number) => {
    for (const [element, height] of [
      [card, cardHeight],
      [content, contentHeight],
      [body, 600.5],
    ] as const)
      element.getBoundingClientRect = () => DOMRect.fromRect({ height });
  };
  heights(300.25, 150.5);
  measure();
  expect(size).toHaveBeenLastCalledWith({ width: 440, height: 762.25 });
  // A clamped viewport changes the card and its scrolling content together, not the size.
  heights(299.75, 150);
  measure();
  expect(size).toHaveBeenLastCalledWith({ width: 440, height: 762.25 });
  expect(size).toHaveBeenCalledTimes(3);
  const cancel = view.getByRole("button", { name: "Cancel" });
  const accept = view.getByRole("button", { name: request.accept });
  expect(document.activeElement).toBe(cancel);
  // Late native focus selection must still land on Cancel before user input.
  content.focus();
  fireEvent.focus(window);
  expect(document.activeElement).toBe(cancel);
  fireEvent.keyDown(cancel, { key: "Tab" });
  expect(document.activeElement).toBe(accept);
  fireEvent.focus(window);
  expect(document.activeElement).toBe(accept);
  fireEvent.keyDown(accept, { key: "Tab" });
  expect(document.activeElement).toBe(cancel);
  fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(accept);
  Object.defineProperty(content, "scrollHeight", { value: 600, configurable: true });
  fireEvent.keyDown(accept, { key: "Tab" });
  expect(document.activeElement).toBe(content);
  fireEvent.keyDown(content, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(accept);
  fireEvent.keyDown(accept, { key: "Tab" });
  fireEvent.keyDown(content, { key: "Tab" });
  expect(document.activeElement).toBe(cancel);
  Object.defineProperty(content, "scrollHeight", { value: 0 });
  fireEvent.keyDown(accept, { key: "Escape" });
  expect(answer).toHaveBeenLastCalledWith("one", false);
  fireEvent.click(cancel);
  fireEvent.click(accept);
  expect(answer).toHaveBeenLastCalledWith("one", true);
  act(() => {
    receive({
      id: "two",
      title: "Quit?",
      accept: "Stop all and quit",
      theme: resolveInterfaceTheme("follow", true),
      sessions: [{ id: "t", name: "shell", location: "/repo", state: "working" }],
    });
  });
  expect(document.activeElement).toBe(view.getByRole("button", { name: "Cancel" }));
  fireEvent.pointerDown(view.getByRole("button", { name: "Stop all and quit" }));
  view.getByRole("button", { name: "Stop all and quit" }).focus();
  fireEvent.focus(window);
  expect(document.activeElement).toBe(view.getByRole("button", { name: "Stop all and quit" }));
  expect(view.getByRole("img", { name: "Working" })).toBeTruthy();
  expect(document.documentElement.style.colorScheme).toBe("dark");
  fireEvent.keyDown(view.getByRole("alertdialog"), { key: "x" });
  for (const id of ["graphite", "eclipse-light", "deep-field", "eclipse-dark"] as const) {
    const theme = resolveInterfaceTheme(id, false);
    act(() => {
      receive({ ...request, id, theme });
    });
    expect(document.documentElement.style.getPropertyValue("--highlight")).toBe(
      theme.colors.highlight ?? theme.colors.accent,
    );
    expect(document.documentElement.style.getPropertyValue("--highlight-deep")).toBe(
      theme.colors["highlight-deep"] ?? theme.colors["accent-deep"],
    );
  }
  act(() => {
    receive(null);
  });
  expect(view.queryByRole("alertdialog")).toBeNull();
  view.unmount();
  expect(off).toHaveBeenCalledOnce();
  expect(disconnect).toHaveBeenCalled();
  vi.unstubAllGlobals();
});

test("cleanup checking, ready and run controls follow main state; Escape only hides", () => {
  let receive: (request: DialogRequest | null) => void = () => {};
  const answer = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(window, "confirmation", {
    configurable: true,
    value: {
      render(callback: typeof receive) {
        receive = callback;
        return () => {};
      },
      answer,
      size: vi.fn(),
    },
  });
  const view = render(<ConfirmationPage />);
  const base: DialogRequest = {
    id: "cleanup",
    title: "Delete merged worktrees?",
    accept: "Delete",
    theme: resolveInterfaceTheme("follow", false),
  };
  const progress = {
    total: 1,
    done: 0,
    phase: "fetch" as const,
    stopped: false,
    items: [{ id: "0", branch: "<script>", state: "queued" as const }],
  };
  act(() => {
    receive({ ...base, cleanup: { stage: "checking", progress } });
  });
  expect(view.getByRole("button", { name: "Delete 1" }).hasAttribute("disabled")).toBe(true);
  act(() => {
    receive({ ...base, cleanup: { stage: "ready", progress } });
  });
  fireEvent.click(view.getByRole("button", { name: "Delete 1" }));
  expect(answer).toHaveBeenLastCalledWith("cleanup", true);
  act(() => {
    receive({ ...base, cleanup: { stage: "run", progress } });
  });
  fireEvent.click(view.getByRole("button", { name: "Stop" }));
  expect(answer).toHaveBeenLastCalledWith("cleanup", true);
  act(() => {
    receive({
      ...base,
      cleanup: { stage: "run", progress: { ...progress, phase: "remove", stopped: true } },
    });
  });
  expect(view.getByRole("button", { name: "Stop" }).hasAttribute("disabled")).toBe(true);
  fireEvent.keyDown(view.getByRole("button", { name: "Hide" }), { key: "Escape" });
  expect(answer).toHaveBeenLastCalledWith("cleanup", false);
  act(() => {
    receive({
      ...base,
      cleanup: {
        stage: "run",
        progress: { ...progress, phase: "finished" },
        error: "fetch failed",
      },
    });
  });
  expect(view.getByText("fetch failed")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Done" }));
  expect(answer).toHaveBeenLastCalledWith("cleanup", false);
});
