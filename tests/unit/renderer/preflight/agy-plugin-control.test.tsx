// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AgyPluginControl } from "../../../../src/renderer/preflight/agy-plugin-control";
import type { AgyPluginStatus } from "../../../../src/shared/agy-plugin";
afterEach(cleanup);

test.each([
  ["not-installed", "Install plugin", "install"],
  ["outdated", "Update plugin", "update"],
  ["disabled", "Enable plugin", "enable"],
  ["installed", "Remove plugin", "remove"],
] as const)("offers an inline %s action", (state, label, action) => {
  const change = vi.fn(() => Promise.resolve());
  const { container } = render(
    <AgyPluginControl status={{ state }} busy={false} change={change} />,
  );
  expect(container.querySelector("p")).toBeNull();
  expect(screen.getByText(/Lifecycle plugin/)).toBeTruthy();
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: label }));
  expect(change).toHaveBeenCalledWith(action);
});

test.each(["not-installed", "installed", "outdated", "disabled"] as const)(
  "blocks duplicate %s operations while busy",
  (state) => {
    const change = vi.fn(() => Promise.resolve());
    render(<AgyPluginControl status={{ state }} busy change={change} />);
    for (const button of screen.getAllByRole("button")) {
      fireEvent.click(button);
      expect(button.hasAttribute("disabled")).toBe(true);
    }
    expect(change).not.toHaveBeenCalled();
  },
);

test("unavailable status never offers to replace an unknown plugin", () => {
  const status: AgyPluginStatus = { state: "unavailable" };
  render(<AgyPluginControl status={status} busy={false} change={vi.fn()} />);
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getByText(/Status unavailable/u)).toBeTruthy();
});
