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
  Object.defineProperty(window, "confirmation", {
    configurable: true,
    value: {
      render(callback: (request: DialogRequest | null) => void) {
        receive = callback;
        return off;
      },
      answer,
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
  const cancel = view.getByRole("button", { name: "Cancel" });
  const accept = view.getByRole("button", { name: request.accept });
  expect(document.activeElement).toBe(cancel);
  fireEvent.keyDown(cancel, { key: "Tab" });
  expect(document.activeElement).toBe(accept);
  fireEvent.keyDown(accept, { key: "Tab" });
  expect(document.activeElement).toBe(cancel);
  fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(accept);
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
  expect(view.getByRole("img", { name: "Working" })).toBeTruthy();
  expect(document.documentElement.style.colorScheme).toBe("dark");
  fireEvent.keyDown(view.getByRole("alertdialog"), { key: "x" });
  act(() => {
    receive(null);
  });
  expect(view.queryByRole("alertdialog")).toBeNull();
  view.unmount();
  expect(off).toHaveBeenCalledOnce();
});
