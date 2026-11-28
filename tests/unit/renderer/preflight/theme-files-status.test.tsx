// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ThemeFilesStatus } from "../../../../src/renderer/preflight/theme-files-status";
import { interfaceThemes } from "../../../../src/shared/interface-themes";
import type { ThemeCatalog } from "../../../../src/shared/theme-file";
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
  const summary = screen.getByText("1 file rejected");
  const rejections = summary.closest("details");
  if (!rejections) throw new Error("Expected a rejection disclosure");
  expect(rejections.open).toBe(false);
  rejections.open = true;
  expect(within(rejections).getByRole("listitem").textContent).toBe(
    "bad.json $.colors.accent · reserved-color",
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
  expect(screen.queryByText("1 file rejected")).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
});

test("groups warnings by theme file and keeps rejected edits visible separately", () => {
  const { container } = render(
    <ThemeFilesStatus
      kind="theme"
      catalog={{
        activeInterfaceTheme: "user:personal.json",
        interface: [
          {
            id: "user:personal.json",
            theme: { ...interfaceThemes.graphite, name: "Personal" },
            warningCount: 3,
          },
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
  expect(disclosures.map((details) => details.open)).toEqual([false, false, false]);
  expect(disclosures.map((details) => details.querySelector("summary")?.textContent)).toEqual([
    "Personal · Applied · 3 warnings",
    "Other · 1 warning",
    "1 file rejected",
  ]);
  const [personal, other, rejected] = disclosures;
  if (!personal || !other || !rejected) throw new Error("Expected all three disclosures");
  personal.open = true;
  expect(
    within(personal)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual([
    "personal.json $.colors.ink · reserved-color",
    "personal.json $.images.board · image-status-color",
    "and 1 more",
  ]);
  expect(other.textContent).toContain("other.json $.base · base-luminance");
  rejected.open = true;
  expect(within(rejected).getByRole("listitem").textContent).toBe(
    "personal.json $ · malformed-json",
  );
});

test("counts every rejected file and limits the details", () => {
  render(
    <ThemeFilesStatus
      kind="theme"
      catalog={{
        interface: [],
        terminal: [],
        errors: Array.from({ length: 102 }, (_, index) => ({
          kind: "theme",
          file: `bad-${String(index)}.json`,
          path: "$",
          reason: "malformed-json",
        })),
      }}
    />,
  );
  const details = screen.getByText("102 files rejected").closest("details");
  if (!details) throw new Error("Expected a rejection disclosure");
  expect(details.open).toBe(false);
  details.open = true;
  expect(within(details).getAllByRole("listitem")).toHaveLength(101);
  expect(within(details).getByText("and 2 more")).toBeTruthy();
});

test("reports folder failures separately from rejected files", () => {
  const catalog: ThemeCatalog = {
    interface: [],
    terminal: [],
    errors: [
      { kind: "theme", file: "(folder)", folder: true, path: "$", reason: "too-many-files" },
      { kind: "theme", file: "bad.json", fileId: "0", path: "$", reason: "malformed-json" },
      { kind: "terminal-theme", file: "(folder)", folder: true, path: "$", reason: "unreadable" },
    ],
  };
  const view = render(<ThemeFilesStatus kind="theme" catalog={catalog} />);
  expect(screen.getByText("Themes folder: too many files")).toBeTruthy();
  const details = screen.getByText("1 file rejected").closest("details");
  if (!details) throw new Error("Expected a rejection disclosure");
  details.open = true;
  expect(within(details).getByRole("listitem").textContent).toBe("bad.json $ · malformed-json");
  view.rerender(<ThemeFilesStatus kind="terminal-theme" catalog={catalog} />);
  expect(screen.getByText("Terminal themes folder: unreadable")).toBeTruthy();
  expect(screen.queryByText(/file.*rejected/)).toBeNull();
});

test("counts filenames that look identical and groups multiple diagnostics for each file", () => {
  const file = "a".repeat(100);
  render(
    <ThemeFilesStatus
      kind="theme"
      catalog={{
        interface: [],
        terminal: [],
        errors: [
          { kind: "theme", file, fileId: "1", path: "$", reason: "unsafe-file" },
          { kind: "theme", file, fileId: "2", path: "$", reason: "unsafe-file" },
          { kind: "theme", file, fileId: "2", path: "$.images.board", reason: "image-unavailable" },
        ],
      }}
    />,
  );
  const details = screen.getByText("2 files rejected").closest("details");
  if (!details) throw new Error("Expected a rejection disclosure");
  details.open = true;
  expect(within(details).getAllByRole("listitem")).toHaveLength(3);
});
