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
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  view.rerender(<ThemeFilesStatus kind="terminal-theme" />);
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
});

test("warnings describe applied themes without rejection styling", () => {
  render(
    <ThemeFilesStatus
      kind="theme"
      catalog={{
        interface: [],
        terminal: [],
        errors: [
          {
            kind: "theme",
            file: "personal.json",
            path: "$.colors.ink",
            reason: "reserved-color",
            severity: "warning",
          },
        ],
      }}
    />,
  );
  expect(screen.getByRole("status").textContent).toBe(
    "Warning personal.json · $.colors.ink: reserved-color",
  );
  expect(screen.getByRole("status").className).toBe("preflight-note");
});
