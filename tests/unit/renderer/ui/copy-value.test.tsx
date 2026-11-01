// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { CopyValue } from "../../../../src/renderer/ui/copy-value";
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
test("value and icon copy together, show a check for one second, and never add helper copy", async () => {
  vi.useFakeTimers();
  const copy = vi.fn(async () => {});
  const view = render(<CopyValue value="/checkout" copy={copy} />);
  const button = view.getByRole("button", { name: "Copy path" });
  expect(button.textContent).toBe("/checkout");
  expect(button.getAttribute("data-copied")).toBe("false");
  await act(async () => {
    await Promise.resolve();
    fireEvent.click(button);
    await Promise.resolve();
  });
  expect(copy).toHaveBeenCalledOnce();
  expect(button.getAttribute("data-copied")).toBe("true");
  expect(view.getByRole("status").textContent).toBe("");
  act(() => {
    vi.advanceTimersByTime(999);
  });
  expect(button.getAttribute("data-copied")).toBe("true");
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(button.getAttribute("data-copied")).toBe("false");
  copy.mockRejectedValueOnce(new Error("clipboard"));
  await act(async () => {
    await Promise.resolve();
    fireEvent.click(button.querySelector("svg") ?? button);
    await Promise.resolve();
  });
  expect(view.getByRole("status").textContent).toBe("Unable to copy");
  await act(async () => {
    await Promise.resolve();
    fireEvent.click(button);
    await Promise.resolve();
  });
  expect(view.getByRole("status").textContent).toBe("");
  view.unmount();
  act(() => {
    vi.runAllTimers();
  });
});
