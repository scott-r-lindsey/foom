// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import {
  ago,
  defaultSelection,
  pending,
  RepositoryPicker,
} from "../src/renderer/repository-picker";
import type { CodeSelection, Scanning } from "../src/renderer/repository-picker";
import type { SetupSource } from "../src/renderer/setup-source.d";
import type { CodeScan, CodeSuggestion, FoundRepository } from "../src/shared/setup";
import type { Repository } from "../src/shared/worktrees";

const DAY = 86_400_000;
const now = Date.now();
const repo = (name: string, days: number | null, overrides: Partial<FoundRepository> = {}) => ({
  path: `/code/${name}`,
  name,
  relative: name,
  branch: "main",
  lastActive: days === null ? null : now - days * DAY,
  recent: days !== null && days <= 30,
  added: false,
  ...overrides,
});
const scan = (repositories: FoundRepository[], truncated = false): CodeScan => ({
  folder: "/code",
  folders: 12,
  truncated,
  repositories,
});

afterEach(() => {
  cleanup();
});

test("ages read naturally", () => {
  expect(ago(null, now)).toBe("no git activity");
  expect(ago(now - 3_600_000, now)).toBe("today");
  expect(ago(now - DAY, now)).toBe("yesterday");
  expect(ago(now - 5 * DAY, now)).toBe("5 days ago");
  expect(ago(now - 35 * DAY, now)).toBe("a month ago");
  expect(ago(now - 95 * DAY, now)).toBe("3 months ago");
  expect(ago(now - 400 * DAY, now)).toBe("over a year ago");
});

test("recent or already added start selected; pending compares with what is added", () => {
  const found = scan([repo("a", 1), repo("b", 60), repo("c", 90, { added: true })]);
  const selected = defaultSelection(found);
  expect([...selected]).toEqual(["/code/a", "/code/c"]);
  const added: Repository[] = [{ path: "/code/c", name: "c" }];
  expect(pending({ scan: found, selected }, added)).toBe(true);
  expect(pending({ scan: found, selected }, [...added, { path: "/code/a", name: "a" }])).toBe(
    false,
  );
});

const setup = (
  suggestions: readonly CodeSuggestion[] = [
    { path: "/home/me/code", repositories: 12, more: false },
    { path: "/home/me/projects", repositories: 1, more: false },
    { path: "/home/me/src", repositories: 5000, more: true },
  ],
) => {
  const fake = { suggestions: vi.fn(() => Promise.resolve(suggestions)) };
  return { fake, source: fake as unknown as SetupSource };
};

function Harness(props: {
  source: SetupSource;
  added?: Repository[];
  initial?: CodeSelection;
  progress?: Scanning;
  onScan?: (folder: string | null) => void;
}) {
  const [selection, setSelection] = useState(props.initial);
  return (
    <RepositoryPicker
      source={props.source}
      selection={selection}
      added={props.added ?? []}
      progress={props.progress}
      onScan={props.onScan ?? vi.fn()}
      onSelection={setSelection}
    />
  );
}
const picked = (found: CodeScan) => ({ scan: found, selected: defaultSelection(found) });

test("before a scan: one panel of found folders with counts, and the picker as a fallback", async () => {
  const onScan = vi.fn();
  const { source } = setup();
  const { rerender } = render(<Harness source={source} onScan={onScan} />);
  expect(screen.getByRole("status").textContent).toBe("Looking for code on this computer…");
  const panel = await screen.findByRole("region", { name: "Found on this computer" });
  expect(Array.from(panel.querySelectorAll("li button"), (row) => row.textContent)).toEqual([
    "/home/me/code12 repositories→",
    "/home/me/projects1 repository→",
    "/home/me/src5000+ repositories→",
  ]);
  fireEvent.click(screen.getByRole("button", { name: /^\/home\/me\/code/ }));
  expect(onScan).toHaveBeenLastCalledWith("/home/me/code");
  // The picker sits in the panel, as the quieter choice.
  const choose = screen.getByRole("button", { name: "Choose folder…" });
  expect(panel.contains(choose)).toBe(true);
  expect(choose.className).toBe("");
  fireEvent.click(choose);
  expect(onScan).toHaveBeenLastCalledWith(null);
  expect(screen.queryByText(/Already added/)).toBeNull();
  rerender(<Harness source={source} added={[{ path: "/x/tool", name: "tool" }]} />);
  expect(screen.getByText("Already added: tool")).toBeTruthy();
});

test("while scanning, progress replaces the picker", () => {
  const { fake, source } = setup();
  fake.suggestions.mockRejectedValueOnce(new Error("no home"));
  const { rerender } = render(
    <Harness source={source} progress={{ folder: "/code", folders: 40, repositories: 1 }} />,
  );
  expect(screen.getByRole("status").textContent).toBe("Scanning /code… 40 folders, 1 repository");
  rerender(<Harness source={source} progress={{ folder: null, folders: 2, repositories: 3 }} />);
  expect(screen.getByRole("status").textContent).toBe(
    "Scanning the folder you chose… 2 folders, 3 repositories",
  );
});

test("the list groups recent and older repositories, filters, and selects", () => {
  const found = scan([
    repo("app", 1),
    repo("clients/acme", 3, { name: "acme", relative: "clients/acme" }),
    repo("old", 60, { branch: null }),
  ]);
  const onScan = vi.fn();
  render(<Harness source={setup().source} initial={picked(found)} onScan={onScan} />);
  const recent = screen.getByRole("region", { name: "Recent · last 30 days" });
  const older = screen.getByRole("region", { name: "Older" });
  expect(
    within(recent)
      .getAllByRole("checkbox")
      .every((box) => (box as HTMLInputElement).checked),
  ).toBe(true);
  expect(within(older).getByRole("checkbox")).toHaveProperty("checked", false);
  expect(within(recent).getByText("clients/acme")).toBeTruthy();
  expect(within(older).getByText("detached")).toBeTruthy();
  expect(screen.getByText("2 of 3 selected")).toBeTruthy();
  expect(screen.getByText("Your selection is saved when you leave this step.")).toBeTruthy();

  const filter = screen.getByRole("searchbox", { name: "Filter repositories" });
  fireEvent.change(filter, { target: { value: "OLD" } });
  expect(screen.queryByText("app")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Select all" }));
  expect(screen.getByText("3 of 3 selected")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Select none" }));
  expect(screen.getByText("2 of 3 selected")).toBeTruthy();
  fireEvent.change(filter, { target: { value: "zzz" } });
  expect(screen.getByText("Nothing matches “zzz”.")).toBeTruthy();
  fireEvent.change(filter, { target: { value: "" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /^app/ }));
  expect(screen.getByText("1 of 3 selected")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: /^app/ }));
  expect(screen.getByText("2 of 3 selected")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Scan again" }));
  expect(onScan).toHaveBeenLastCalledWith("/code");
  fireEvent.click(screen.getByRole("button", { name: "Change folder" }));
  expect(onScan).toHaveBeenLastCalledWith(null);
});

test("empty, truncated, outside repositories, and nothing to save", () => {
  const { source } = setup();
  render(
    <Harness
      source={source}
      initial={picked(scan([], true))}
      added={[{ path: "/elsewhere/tool", name: "tool" }]}
    />,
  );
  expect(screen.getByText("No Git repositories in this folder.")).toBeTruthy();
  expect(screen.getByText(/Stopped after 12 folders/)).toBeTruthy();
  expect(screen.getByText("Also added, outside this folder: tool")).toBeTruthy();
  cleanup();
  const found = scan([repo("a", 1, { added: true })]);
  render(
    <Harness source={source} initial={picked(found)} added={[{ path: "/code/a", name: "a" }]} />,
  );
  expect(screen.getByText("1 of 1 selected")).toBeTruthy();
  expect(screen.queryByText(/saved when you leave/)).toBeNull();
});

test("with nothing found, the picker is the main choice", async () => {
  const { fake, source } = setup([]);
  render(<Harness source={source} />);
  const choose = await screen.findByRole("button", { name: "Choose folder…" });
  expect(choose.className).toBe("primary");
  expect(screen.queryByRole("region", { name: "Found on this computer" })).toBeNull();
  // A failed lookup reads the same as finding nothing.
  cleanup();
  fake.suggestions.mockRejectedValueOnce(new Error("no home"));
  render(<Harness source={source} />);
  expect((await screen.findByRole("button", { name: "Choose folder…" })).className).toBe("primary");
});
