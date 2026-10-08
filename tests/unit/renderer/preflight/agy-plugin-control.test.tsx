// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AgyPluginControl } from "../../../../src/renderer/preflight/agy-plugin-control";
import type { AgyPluginStatus } from "../../../../src/shared/agy-plugin";
afterEach(cleanup);

test.each([
  ["not-installed", "Install Foom plugin", "install"],
  ["outdated", "Update Foom plugin", "update"],
  ["disabled", "Enable Foom plugin", "enable"],
  ["installed", "Remove Foom plugin", "remove"],
] as const)("discloses the effect before an explicit %s action", (state, label, action) => {
  const change = vi.fn(() => Promise.resolve());
  const { container } = render(
    <AgyPluginControl status={{ state }} busy={false} change={change} />,
  );
  expect(container.textContent).toContain("~/.gemini/config/plugins/foom");
  expect(container.textContent).toContain("does nothing outside Foom-launched sessions");
  expect(container.textContent).toContain("agy plugin uninstall foom");
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
  expect(screen.getByText(/will not replace an unrecognized plugin/u)).toBeTruthy();
});
