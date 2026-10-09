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
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
  const paint = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    act(() => {
      for (const callback of callbacks) callback(0);
    });
  };
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
    theme: resolveInterfaceTheme("follow", false),
  };
  act(() => {
    receive(request);
  });
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
  Object.defineProperty(card, "offsetHeight", { value: 300 });
  Object.defineProperty(content, "clientHeight", { value: 150 });
  Object.defineProperty(body, "offsetHeight", { value: 600 });
  measure();
  expect(size).toHaveBeenLastCalledWith({ width: 440, height: 762 });
  expect(size).toHaveBeenCalledTimes(2);
  const cancel = view.getByRole("button", { name: "Cancel" });
  const accept = view.getByRole("button", { name: request.accept });
  expect(frames.size).toBe(0);
  // A hidden page must wait for reveal; native activation can pick the first tab stop.
  content.focus();
  fireEvent.focus(window);
  expect(document.activeElement).toBe(content);
  visibility.mockReturnValue("visible");
  fireEvent(document, new Event("visibilitychange"));
  fireEvent.focus(window);
  expect(document.activeElement).toBe(content);
  paint();
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
  paint();
  expect(document.activeElement).toBe(view.getByRole("button", { name: "Cancel" }));
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
  expect(frames.size).toBe(0);
  visibility.mockRestore();
  vi.unstubAllGlobals();
});
