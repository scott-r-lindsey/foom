// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ThemeFilesStatus } from "../../../../src/renderer/preflight/theme-files-status";
afterEach(cleanup);
test("shows fixed diagnostic text for the relevant kind and handles folder failure", async () => {
  const open = vi.fn(async () => {});
  const catalog = {
    interface: [],
    terminal: [],
    errors: [
      {
        kind: "theme" as const,
        file: "bad.json",
        path: "$.colors.accent",
        reason: "reserved-color" as const,
      },
      {
        kind: "terminal-theme" as const,
        file: "terminal.json",
        path: "$",
        reason: "malformed-json" as const,
      },
    ],
  };
  const view = render(<ThemeFilesStatus catalog={catalog} kind="theme" openFolder={open} />);
  expect(screen.getByRole("status").textContent).toContain(
    "Rejected bad.json · $.colors.accent: reserved-color",
  );
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => {
    expect(open).toHaveBeenCalledOnce();
  });
  open.mockRejectedValueOnce(new Error("private path"));
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => {
    expect(screen.getByRole("alert").textContent).toBe("Unable to open themes folder.");
  });
  view.rerender(<ThemeFilesStatus kind="terminal-theme" />);
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
});
