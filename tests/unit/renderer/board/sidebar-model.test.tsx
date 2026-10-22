import { repositoryDisplayName } from "../../../../src/renderer/board/sidebar-model";
// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  buildSidebar,
  previewOpener,
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
test("rollups rank needs you, failed, working, done, quiet and retain the first tied session", () => {
  const states: BoardState[] = ["quiet_ok", "done", "working", "working", "failed", "needs_input"];
  expect(rollup([])).toBeUndefined();
  const rows = states.map((state) => row(state, "/repo", state));
  expect(rollup(rows)?.state).toBe("needs_input");
  expect(rollup(rows.slice(0, 5))?.state).toBe("failed");
  expect(rollup(rows.slice(0, 4))?.state).toBe("working");
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
    expect(readPreferences({ getItem: () => raw, length: 0, key: () => null })).toEqual(
      emptyPreferences(),
    );
  expect(
    readPreferences({
      length: 0,
      key: () => null,
      getItem: () => {
        throw Error("denied");
      },
    }),
  ).toEqual(emptyPreferences());
  expect(
    readPreferences({
      length: 0,
      key: () => null,
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

test("places children in their own checkouts with reciprocal exited/revoked parent filter context", () => {
  const parent: BoardRow = {
    ...row("parent", "/repo"),
    exited: true,
    orchestration: { role: "orchestrator", active: false, children: 1, history: [] },
  };
  const child: BoardRow = {
    ...row("child", "/repo", "needs_input"),
    worktree: "/child",
    branch: "child-branch",
    orchestration: { role: "child", parentId: "parent", takenOver: true },
  };
  const repositories = sidebarRepositories([parent, child], [repo("/repo")]);
  const built = buildSidebar([parent, child], repositories, emptyPreferences(), "child-branch");
  expect(built.tree[0]?.worktrees[0]?.sessions).toEqual([parent]);
  expect(built.tree[0]?.worktrees[1]?.sessions).toEqual([child]);
  expect(built.tree[0]?.worktrees[0]?.rollup).toBe(parent);
  expect(built.tree[0]?.worktrees[1]?.rollup).toBe(child);
  const preferences = renameSession(emptyPreferences(), "parent", "Coordinator");
  const byParent = buildSidebar([parent, child], repositories, preferences, "Coordinator");
  expect(byParent.tree[0]?.worktrees.map((tree) => tree.sessions)).toEqual([[parent], [child]]);
  expect(built.hiddenNeeds).toBe(0);
  const orphans = buildSidebar([child], repositories, emptyPreferences(), "");
  expect(
    orphans.tree[0]?.worktrees.find((tree) => tree.tree.path === "/child")?.sessions[0]?.id,
  ).toBe("child");
  const isolated = buildSidebar(
    [parent, { ...child, repositoryPath: "/other" }],
    sidebarRepositories([parent, { ...child, repositoryPath: "/other" }], repositories),
    emptyPreferences(),
    "",
  );
  expect(
    isolated.tree.find((repo) => repo.repository.path === "/repo")?.worktrees[0]?.sessions,
  ).toEqual([parent]);
});

test("preview-only worktrees participate in filtering and active sections without attention", () => {
  const preview = {
    id: "p",
    repository: "/b",
    worktree: "/b",
    relativePath: "docs/guide.md",
    kind: "markdown" as const,
    network: false,
  };
  const repositories = [repo("/a"), repo("/b")];
  const result = buildSidebar([], repositories, emptyPreferences(), "guide", [preview]);
  expect(result.tree).toHaveLength(1);
  expect(result.tree[0]?.expanded).toBe(true);
  expect(result.tree[0]?.worktrees[0]?.previews).toEqual([preview]);
  expect(result.tree[0]?.rollup).toBeUndefined();
  expect(result.hiddenNeeds).toBe(0);
  const all = buildSidebar([], repositories, emptyPreferences(), "", [preview]);
  expect(all.tree[0]?.repository.path).toBe("/b");
  expect(all.tree[0]?.expanded).toBe(true);
  expect(buildSidebar([], repositories, emptyPreferences(), "missing", [preview]).tree).toEqual([]);
});

test("preview filtering retains the opener, and attribution retains identity after rename or removal", () => {
  const opener = { ...row("agent", "/repo"), agent: "claude" };
  const preview = {
    id: "preview",
    repository: "/repo",
    worktree: "/repo",
    relativePath: "docs/mockup.html",
    kind: "html" as const,
    network: false,
    openedBy: { terminalId: opener.id, agent: "claude" },
  };
  const preferences = renameSession(emptyPreferences(), opener.id, "Designer");
  expect(previewOpener(preview, [opener], preferences)).toBe("Claude Code · Designer");
  expect(previewOpener(preview, [], preferences)).toBe("Claude Code");
  expect(
    previewOpener(
      { ...preview, openedBy: { terminalId: "gone", agent: "Custom" } },
      [],
      preferences,
    ),
  ).toBe("Custom");
  const human = {
    id: "human",
    repository: "/repo",
    worktree: "/repo",
    relativePath: "plan.md",
    kind: "markdown" as const,
    network: false,
  };
  expect(previewOpener(human, [], preferences)).toBe("");
  for (const query of ["mockup", "Designer"]) {
    const worktree = buildSidebar([opener], [repo("/repo")], preferences, query, [preview, human])
      .tree[0]?.worktrees[0];
    expect(worktree?.sessions.map((session) => session.id)).toEqual(["agent"]);
    expect(worktree?.previews.map((item) => item.id)).toEqual(["preview"]);
  }
});

test.each([
  ["/code/work/foom", "/code", true, "work/foom"],
  ["/code/work/foom", "/code/", true, "work/foom"],
  ["/code/foom", "/code", true, "foom"],
  ["/code/work/foom", "/code", false, "foom"],
  ["/outside/foom", "/code", true, "foom"],
  ["/code-other/foom", "/code", true, "foom"],
  ["/code", "/code", true, "foom"],
  ["/code/work/foom", null, true, "foom"],
  ["/work/foom", "/", true, "work/foom"],
  ["C:\\Code\\work\\foom", "c:\\code", true, "work/foom"],
  ["D:/Code/foom", "C:/Code", true, "foom"],
  ["//host/code/work/foom", "\\\\host\\code", true, "work/foom"],
])("repository name %s relative to %s (enabled %s)", (path, root, enabled, expected) => {
  expect(repositoryDisplayName({ path, name: "foom" }, root, enabled)).toBe(expected);
});
