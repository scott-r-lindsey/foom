// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ThemeFilesStatus } from "../../../../src/renderer/preflight/theme-files-status";
import { interfaceThemes } from "../../../../src/shared/interface-themes";
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

test("groups warnings by theme file and keeps rejected edits visible separately", () => {
  const { container } = render(
    <ThemeFilesStatus
      kind="theme"
      selected="user:personal.json"
      catalog={{
        interface: [
          { id: "user:personal.json", theme: { ...interfaceThemes.graphite, name: "Personal" } },
          { id: "user:other.json", theme: { ...interfaceThemes.graphite, name: "Other" } },
          { id: "user:clean.json", theme: { ...interfaceThemes.graphite, name: "Clean" } },
        ],
        terminal: [],
        errors: [
          {
            kind: "theme",
            file: "personal.json",
            path: "$.colors.ink",
            reason: "reserved-color",
            severity: "warning",
          },
          {
            kind: "theme",
            file: "personal.json",
            path: "$.images.board",
            reason: "image-status-color",
            severity: "warning",
          },
          {
            kind: "theme",
            file: "other.json",
            path: "$.base",
            reason: "base-luminance",
            severity: "warning",
          },
          {
            kind: "terminal-theme",
            file: "personal.json",
            path: "$.colors.accent",
            reason: "color-distance",
            severity: "warning",
          },
          {
            kind: "theme",
            file: "personal.json",
            path: "$",
            reason: "malformed-json",
          },
        ],
      }}
    />,
  );
  const disclosures = Array.from(container.querySelectorAll("details"));
  expect(disclosures.map((details) => details.open)).toEqual([false, false]);
  expect(disclosures.map((details) => details.querySelector("summary")?.textContent)).toEqual([
    "Personal · Applied · 2 warnings",
    "Other · 1 warning",
  ]);
  const [personal, other] = disclosures;
  if (!personal || !other) throw new Error("Expected both theme disclosures");
  personal.open = true;
  expect(
    within(personal)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual([
    "personal.json $.colors.ink · reserved-color",
    "personal.json $.images.board · image-status-color",
  ]);
  expect(other.textContent).toContain("other.json $.base · base-luminance");
  expect(screen.getByRole("status").textContent).toBe("Rejected personal.json · $: malformed-json");
});
