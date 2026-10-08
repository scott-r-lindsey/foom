// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  buildSidebar,
  repositoryKey,
  worktreeKey,
  rollup,
  sessionName,
  sidebarRepositories,
} from "../../../../src/renderer/board/sidebar-model";
import {
  emptyPreferences,
  readPreferences,
  writePreferences,
  renameSession,
} from "../../../../src/renderer/board/sidebar-preferences";
import { SessionName } from "../../../../src/renderer/board/session-name";
import { Highlight } from "../../../../src/renderer/board/text-highlight";
import type { SidebarRepository } from "../../../../src/renderer/board/sidebar.d";
import type { BoardRow, BoardState } from "../../../../src/renderer/board/board.d";
export const repo = (path: string, name = path): SidebarRepository => ({
  path,
  name,
  worktrees: [
    {
      path,
      branch: "main",
      bare: false,
      locked: false,
      prunable: false,
      managed: false,
      head: "abc",
    },
  ],
});
export const row = (
  id: string,
  repositoryPath: string,
  state: BoardState = "working",
): BoardRow => ({
  id,
  repository: repositoryPath,
  repositoryPath,
  worktree: repositoryPath,
  branch: "main",
  agent: "claude",
  kind: "agent",
  state,
  reason: "Running tests",
  rate: 0,
  waitingSince: 0,
  seen: false,
  tail: [],
  exited: false,
});
afterEach(cleanup);
test("fifty repositories sort into pin order, active A–Z, and idle A–Z; duplicate names retain identity", () => {
  const repositories = Array.from({ length: 50 }, (_, index) =>
    repo(`/repo/${String(index).padStart(2, "0")}`),
  );
  const rows = [row("a", "/repo/22"), row("b", "/repo/02", "done")];
  const preferences = { ...emptyPreferences(), pins: ["/repo/30", "/repo/10"] };
  const result = buildSidebar(rows, repositories, preferences, "");
  expect(result.tree).toHaveLength(50);
  expect(result.tree.slice(0, 5).map((item) => [item.repository.path, item.section])).toEqual([
    ["/repo/30", 0],
    ["/repo/10", 0],
    ["/repo/02", 1],
    ["/repo/22", 1],
    ["/repo/00", 2],
  ]);
  expect(
    buildSidebar([], [repo("/a", "same"), repo("/b", "same")], emptyPreferences(), "").tree,
  ).toHaveLength(2);
});
test("single repositories and their worktrees start open, while saved expansion wins outside filtering", () => {
  const repository = repo("/repo");
  expect(buildSidebar([], [repository], emptyPreferences(), "").tree[0]).toMatchObject({
    expanded: true,
    section: 0,
    worktrees: [{ expanded: true }],
  });
  const preferences = {
    ...emptyPreferences(),
    expanded: { [repositoryKey("/repo")]: false, [worktreeKey("/repo")]: false },
  };
  expect(buildSidebar([], [repository], preferences, "").tree[0]).toMatchObject({
    expanded: false,
    worktrees: [{ expanded: false }],
  });
  expect(buildSidebar([], [repository], preferences, "MAIN").tree[0]).toMatchObject({
    expanded: true,
    worktrees: [{ expanded: true }],
  });
  expect(
    buildSidebar([], [repository, repo("/other")], emptyPreferences(), "").tree.every(
      (item) => !item.expanded,
    ),
  ).toBe(true);
  expect(
    buildSidebar([row("a", "/repo")], [repository, repo("/other")], emptyPreferences(), "").tree[0]
      ?.expanded,
  ).toBe(true);
});
test("filter matches names, branch and reasons, includes matching descendants and counts only hidden attention", () => {
  const repositories = [repo("/one", "First"), repo("/two", "Second")];
  const rows = [row("a", "/one", "needs_input"), row("b", "/two", "needs_input")];
  const preferences = renameSession(emptyPreferences(), "a", "Review changes");
  for (const query of ["FIRST", "review"]) {
    const result = buildSidebar(rows, repositories, preferences, query);
    expect(result.hiddenNeeds).toBe(1);
    expect(result.tree[0]?.worktrees[0]?.sessions.map((item) => item.id)).toEqual(["a"]);
  }
  for (const query of ["MAIN", "tests", "  "])
    expect(buildSidebar(rows, repositories, preferences, query).hiddenNeeds).toBe(0);
  expect(buildSidebar(rows, repositories, preferences, "absent").tree).toEqual([]);
  expect(buildSidebar(rows, repositories, preferences, "absent").hiddenNeeds).toBe(2);
  const detached = {
    ...repositories[0],
    ...repo("/one"),
    worktrees: [
      {
        ...{
          path: "/one",
          head: null,
          bare: false,
          locked: false,
          prunable: false,
          managed: false,
        },
        branch: null,
      },
    ],
  };
  expect(buildSidebar([], [detached], preferences, "Detached HEAD").tree).toHaveLength(1);
});
test("rollups rank needs you, failed, working/checking, done, quiet and retain the first tied session", () => {
  const states: BoardState[] = ["quiet_ok", "done", "checking", "working", "failed", "needs_input"];
  expect(rollup([])).toBeUndefined();
  const rows = states.map((state) => row(state, "/repo", state));
  expect(rollup(rows)?.state).toBe("needs_input");
  expect(rollup(rows.slice(0, 5))?.state).toBe("failed");
  expect(rollup(rows.slice(0, 4))?.state).toBe("checking");
  expect(rollup(rows.slice(0, 2))?.state).toBe("done");
});
test("sample locations are synthesized without merging real repositories with identical names", () => {
  const local = row("a", "/a");
  delete local.repositoryPath;
  delete local.worktree;
  expect(
    sidebarRepositories([local, local], []).map((item) => [item.path, item.worktrees.length]),
  ).toEqual([["/a", 1]]);
  expect(sidebarRepositories([row("a", "/a")], [repo("/a")])[0]?.worktrees).toHaveLength(1);
  expect(sessionName({ ...row("a", "/a"), agent: "Custom" }, emptyPreferences())).toBe("Custom");
});
test("preferences persist, reject malformed disk data, deduplicate pins and restore default names on empty input", () => {
  localStorage.clear();
  expect(readPreferences(localStorage)).toEqual(emptyPreferences());
  const value = renameSession(
    { ...emptyPreferences(), pins: ["/a"], expanded: { a: true } },
    "one",
    "  Named  ",
  );
  writePreferences(localStorage, value);
  expect(readPreferences(localStorage)).toEqual(value);
  expect(sessionName(row("one", "/a"), value)).toBe("Named");
  expect(sessionName(row("one", "/a"), renameSession(value, "one", "  "))).toBe("Claude Code");
  expect(renameSession(value, "one", "a".repeat(121)).names["one"]).toHaveLength(120);
  for (const raw of ["broken", "[]", "{}"])
    expect(readPreferences({ getItem: () => raw })).toEqual(emptyPreferences());
  expect(
    readPreferences({
      getItem: () => {
        throw Error("denied");
      },
    }),
  ).toEqual(emptyPreferences());
  expect(
    readPreferences({
      getItem: () =>
        JSON.stringify({
          pins: ["/a", "/a", 4],
          expanded: { a: true, bad: "yes" },
          names: { a: "Name", bad: 4 },
        }),
    }),
  ).toEqual({ pins: ["/a"], expanded: { a: true }, names: { a: "Name" } });
  expect(() => {
    writePreferences(
      {
        setItem: () => {
          throw Error("full");
        },
      },
      value,
    );
  }).toThrow("full");
});
test("rename commits on Enter and blur, cancels on Escape, and never commits a cancelled edit twice", () => {
  const save = vi.fn();
  const view = render(<SessionName name="Claude Code" filter="" save={save} />);
  fireEvent.doubleClick(view.getByText("Claude Code"));
  fireEvent.change(view.getByLabelText("Session name"), { target: { value: "Review" } });
  fireEvent.keyDown(view.getByLabelText("Session name"), { key: "Escape" });
  expect(save).not.toHaveBeenCalled();
  fireEvent.doubleClick(view.getByText("Claude Code"));
  fireEvent.change(view.getByLabelText("Session name"), { target: { value: "Review" } });
  fireEvent.click(view.getByLabelText("Session name"));
  fireEvent.keyDown(view.getByLabelText("Session name"), { key: "a" });
  fireEvent.keyDown(view.getByLabelText("Session name"), { key: "Enter" });
  expect(save).toHaveBeenCalledExactlyOnceWith("Review");
  fireEvent.doubleClick(view.getByText("Claude Code"));
  fireEvent.blur(view.getByLabelText("Session name"));
  expect(save).toHaveBeenLastCalledWith("Claude Code");
});
test("highlight is case-insensitive, escapes text, marks all occurrences and handles empty queries", () => {
  const view = render(<Highlight text={"<test> TEST test"} filter="test" />);
  expect(view.container.querySelectorAll("mark")).toHaveLength(3);
  expect(view.container.querySelector("test")).toBeNull();
  view.rerender(<Highlight text="text" filter="" />);
  expect(view.container.textContent).toBe("text");
});

test("single-click opens the name after the double-click interval, while rename cancels pending terminal focus", () => {
  vi.useFakeTimers();
  const open = vi.fn();
  const view = render(<SessionName name="Shell" filter="" save={vi.fn()} open={open} />);
  fireEvent.click(view.getByText("Shell"), { detail: 1 });
  vi.advanceTimersByTime(250);
  expect(open).toHaveBeenCalledOnce();
  fireEvent.click(view.getByText("Shell"), { detail: 1 });
  fireEvent.click(view.getByText("Shell"), { detail: 2 });
  fireEvent.doubleClick(view.getByText("Shell"));
  vi.advanceTimersByTime(500);
  expect(open).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(view.getByLabelText("Session name"));
  view.unmount();
  vi.useRealTimers();
});

test("retains missing checkout rows as removed only while sessions remain", () => {
  const session = { ...row("orphan", "/repo"), worktree: "/deleted", worktreeRemoved: true };
  const repositories = sidebarRepositories([session], [repo("/repo")]);
  expect(repositories[0]?.worktrees[1]).toMatchObject({ path: "/deleted", removed: true });
  expect(
    buildSidebar([session], repositories, emptyPreferences(), "").tree[0]?.worktrees[1]?.sessions,
  ).toEqual([session]);
  expect(sidebarRepositories([], [repo("/repo")])[0]?.worktrees).toHaveLength(1);
});
