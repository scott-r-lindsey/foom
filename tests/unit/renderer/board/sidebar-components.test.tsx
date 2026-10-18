import { SidebarPanel } from "../../../../src/renderer/board/sidebar-panel";
import { createSampleSource } from "../../../../src/renderer/board/sample-board-source";
// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SidebarSessionRow } from "../../../../src/renderer/board/sidebar-session-row";
import type { SidebarSessionRowProps } from "../../../../src/renderer/board/sidebar-session-row";
import { SidebarPreviewRow } from "../../../../src/renderer/board/sidebar-preview-row";
import { SidebarRepositorySection } from "../../../../src/renderer/board/sidebar-repository-section";
import { SidebarWorktreeSection } from "../../../../src/renderer/board/sidebar-worktree-section";
import { boardRows } from "../../../fixtures/board";

const events = () => ({
  onPointerEnter: vi.fn(),
  onPointerLeave: vi.fn(),
  onContextMenu: vi.fn(),
  onKeyDownCapture: vi.fn(),
});
afterEach(cleanup);

test("session presentation reports focus and intent independently of opening, and releases its anchor", () => {
  const row = boardRows(0)[0];
  if (!row) throw Error("fixture");
  const props: SidebarSessionRowProps = {
    row: { ...row, orchestration: { role: "child", parentId: "parent", takenOver: false } },
    name: "Helper",
    identity: "Claude Code",
    parentName: "Planner",
    related: true,
    compact: false,
    docked: false,
    now: 0,
    filter: "Help",
    tile: undefined,
    otherView: false,
    selected: row.id,
    events: events(),
    actions: <button type="button">Actions</button>,
    register: vi.fn(),
    focus: vi.fn(),
    open: vi.fn(),
    rename: vi.fn(),
    onHover: vi.fn(),
    onFocusSession: vi.fn(),
  };
  const view = render(<SidebarSessionRow {...props} />);
  const item = view.getByRole("treeitem", { name: /Helper.*Child of Planner/ });
  expect(item.getAttribute("aria-selected")).toBe("true");
  expect(view.container.querySelector("mark")?.textContent).toBe("Help");
  fireEvent.focus(item);
  fireEvent.pointerEnter(item.parentElement ?? item);
  expect(props.focus).toHaveBeenCalledWith(row.id);
  expect(props.onFocusSession).toHaveBeenCalledWith(row.id);
  expect(props.onHover).toHaveBeenCalledWith(row.id);
  expect(props.events.onPointerEnter).toHaveBeenCalledOnce();
  expect(props.open).not.toHaveBeenCalled();
  fireEvent.keyDown(item, { key: "Enter" });
  fireEvent.keyDown(item, { key: " " });
  expect(props.open).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(view.getByRole("button", { name: "Actions" }), { key: "Enter" });
  expect(props.open).toHaveBeenCalledTimes(2);
  fireEvent.pointerLeave(item.parentElement ?? item);
  fireEvent.blur(item);
  expect(props.onHover).toHaveBeenLastCalledWith(undefined);
  expect(props.onFocusSession).toHaveBeenLastCalledWith(undefined);
  view.rerender(<SidebarSessionRow {...props} docked compact />);
  expect(view.queryByRole("treeitem")).toBeNull();
  expect(view.getByRole("button", { name: /Helper.*Child of Planner/ }).tabIndex).toBe(0);
  view.unmount();
  expect(props.register).toHaveBeenLastCalledWith(row.id, null);
});

test("repository presentation delegates expansion and panel opening and reports cleanup accessibly", () => {
  const toggle = vi.fn();
  const openPanel = vi.fn();
  const register = vi.fn();
  const repo = {
    repository: {
      path: "/repo",
      name: "Repo",
      worktrees: [],
      cleanup: { phase: "finished" as const, done: 2, total: 2, stopped: false, items: [] },
    },
    section: 0,
    expanded: false,
    pinned: true,
    rollup: undefined,
    worktrees: [],
  };
  const props = {
    repo,
    separator: true,
    filter: "Repo",
    empty: true,
    panelOpen: true,
    events: events(),
    actions: <button type="button">Actions</button>,
    register,
    toggle,
    openPanel,
  };
  const view = render(
    <SidebarRepositorySection {...props}>
      <span>Session</span>
    </SidebarRepositorySection>,
  );
  expect(view.getByRole("treeitem", { name: "Repo" }).getAttribute("aria-expanded")).toBe("false");
  expect(view.getByRole("status").textContent).toContain("Cleanup finished: 2/2");
  expect(view.queryByText("Session")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Expand Repo" }));
  expect(toggle).toHaveBeenCalledOnce();
  const name = view.getByRole("button", { name: /Repo/, expanded: true });
  fireEvent.click(name);
  expect(openPanel).toHaveBeenCalledWith(name);
  view.rerender(
    <SidebarRepositorySection {...props} repo={{ ...repo, expanded: true }}>
      <span>Session</span>
    </SidebarRepositorySection>,
  );
  expect(view.getByRole("group").textContent).toContain("Session");
  expect(view.getByText("Nothing here yet")).toBeTruthy();
  view.unmount();
  expect(register).toHaveBeenLastCalledWith(null);
});

test("worktree presentation reports cleanup dismissal and arrival settling through parent callbacks", () => {
  const toggle = vi.fn();
  const openPanel = vi.fn();
  const dismissCleanup = vi.fn();
  const settle = vi.fn();
  const register = vi.fn();
  const props = {
    worktree: {
      path: "/tree",
      branch: "feature",
      head: "abc",
      managed: true,
      bare: false,
      locked: false,
      prunable: false,
    },
    name: "feature",
    branch: "feature",
    main: false,
    expanded: true,
    rollup: undefined,
    cleanupItem: {
      id: "item",
      path: "/tree",
      branch: "feature",
      state: "kept" as const,
      reason: "running" as const,
    },
    cleanupDismissed: false,
    arriving: true,
    filter: "",
    panelOpen: false,
    events: events(),
    actions: null,
    register,
    toggle,
    openPanel,
    openPullRequest: vi.fn(() => Promise.resolve()),
    dismissCleanup,
    settle,
  };
  const view = render(<SidebarWorktreeSection {...props}>Session</SidebarWorktreeSection>);
  const name = view.getByRole("button", { name: "feature" });
  fireEvent.pointerEnter(name.parentElement ?? name);
  expect(props.events.onPointerEnter).toHaveBeenCalledOnce();
  expect(dismissCleanup).toHaveBeenCalledOnce();
  expect(settle).toHaveBeenCalledWith(600);
  fireEvent.focus(name);
  expect(dismissCleanup).toHaveBeenCalledTimes(2);
  fireEvent.blur(name);
  expect(settle).toHaveBeenLastCalledWith(0);
  fireEvent.click(name);
  expect(openPanel).toHaveBeenCalledWith(name);
  fireEvent.click(view.getByRole("button", { name: "Collapse feature" }));
  expect(toggle).toHaveBeenCalledOnce();
  view.rerender(
    <SidebarWorktreeSection {...props} cleanupDismissed>
      Session
    </SidebarWorktreeSection>,
  );
  expect(view.queryByText("running")).toBeNull();
  view.unmount();
  expect(register).toHaveBeenLastCalledWith(null);
});

test.each(["markdown", "html"] as const)(
  "%s previews expose opener and tile presence and delegate opening",
  (kind) => {
    const open = vi.fn();
    const preview = {
      id: "preview",
      kind,
      network: false,
      repository: "/repo",
      worktree: "/tree",
      relativePath: "README.md",
    };
    const view = render(
      <SidebarPreviewRow
        preview={{ ...preview, openedBy: { terminalId: "parent", agent: "claude" } }}
        opener="Planner"
        tile={{ number: 2, focused: true }}
        filter="README"
        open={open}
      />,
    );
    expect(view.getByRole("treeitem").getAttribute("aria-label")).toContain("opened by Planner");
    expect(view.getByLabelText("Tile 2").getAttribute("data-focused")).toBe("true");
    fireEvent.click(view.getByRole("button"));
    expect(open).toHaveBeenCalledWith("preview");
    view.rerender(
      <SidebarPreviewRow preview={preview} opener="" tile={undefined} filter="" open={open} />,
    );
    expect(view.getByRole("treeitem").getAttribute("aria-label")).toContain(", not shown");
    expect(view.queryByText(/opened by/)).toBeNull();
  },
);

test("a panel opened before launch options arrive keeps its conversation field usable and intent parent-owned", () => {
  const anchor = document.createElement("button");
  document.body.append(anchor);
  const worktree = {
    path: "/tree",
    branch: "feature",
    head: "abc",
    managed: true,
    bare: false,
    locked: false,
    prunable: false,
  };
  const props = {
    menu: { id: "tree", anchor, pinned: false, field: true },
    subject: {
      kind: "worktree" as const,
      repository: { path: "/repo", name: "Repo", worktrees: [worktree] },
      tree: worktree,
    },
    name: "feature",
    kind: "Worktree",
    mark: "worktree",
    source: createSampleSource([]),
    options: undefined,
    actions: [],
    rename: vi.fn(),
    command: vi.fn(() => Promise.resolve()),
    created: vi.fn(),
    back: vi.fn(),
    close: vi.fn(),
    enter: vi.fn(),
    leave: vi.fn(),
    pin: vi.fn(),
  };
  const view = render(<SidebarPanel {...props} />);
  const dialog = view.getByRole("dialog", { name: "feature details and commands" });
  expect(view.getByRole("textbox")).toBeTruthy();
  fireEvent.change(view.getByRole("textbox"), { target: { value: "claude --resume abc" } });
  expect(view.getByRole("textbox").getAttribute("aria-invalid")).toBe("true");
  fireEvent.pointerEnter(dialog);
  fireEvent.pointerLeave(dialog);
  expect(props.enter).toHaveBeenCalled();
  expect(props.leave).toHaveBeenCalled();
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(props.close).toHaveBeenCalled();
  view.unmount();
  anchor.remove();
});
