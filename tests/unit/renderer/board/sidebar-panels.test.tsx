// @vitest-environment jsdom
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Board } from "../../../../src/renderer/board/board-view";
import type { SidebarRepository } from "../../../../src/renderer/board/sidebar.d";
import { repository, setup } from "./sidebar-view-fixtures";
beforeEach(() => {
  localStorage.clear();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
});
afterEach(cleanup);

test("location labels open their panels and leave terminal tiles unchanged; menus issue location-specific commands", async () => {
  const view = setup();
  await act(async () => {
    await Promise.resolve();
  });
  const pane = view.getByRole("region", { name: "Terminal pane" });
  const content = pane.innerHTML;
  const name = view.getByRole("button", { name: "Foom" });
  fireEvent.click(name);
  expect(pane.innerHTML).toBe(content);
  expect(name.getAttribute("aria-expanded")).toBe("true");
  expect(view.getByRole("menuitem", { name: "Pin to top" })).toBeTruthy();
  fireEvent.click(name);
  expect(name.getAttribute("aria-expanded")).toBe("false");
  const checkout = view.getByRole("button", { name: "Main checkout" });
  expect(checkout.textContent).toContain("Main checkout");
  expect(checkout.textContent).toContain("main");
  fireEvent.click(checkout);
  expect(pane.innerHTML).toBe(content);
  expect(checkout.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(checkout);
  const filter = view.getByLabelText("Filter repositories and sessions");
  fireEvent.change(filter, { target: { value: "Main checkout" } });
  expect(
    view.getByRole("button", { name: "Main checkout" }).querySelector("mark")?.textContent,
  ).toBe("Main checkout");
  expect(view.queryByRole("button", { name: "feature" })).toBeNull();
  fireEvent.change(filter, { target: { value: "" } });
  const feature = view.getByRole("button", { name: "feature" });
  fireEvent.click(feature);
  expect(pane.innerHTML).toBe(content);
  expect(feature.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(feature);
  expect(view.command).not.toHaveBeenCalled();
  act(() => {
    view.base.update("a", { exited: true });
  });
  for (const [label, expected] of [
    ["Claude Code", { kind: "launch", repository: "/foom", worktree: "/tree", run: "claude" }],
    ["Shell (zsh)", { kind: "launch", repository: "/foom", worktree: "/tree", run: "shell" }],
    ["Delete worktree…", { kind: "remove-worktree", repository: "/foom", worktree: "/tree" }],
  ] as const) {
    fireEvent.click(view.getByRole("button", { name: "Actions for feature" }));
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: label }));
      await Promise.resolve();
    });
    expect(view.command).toHaveBeenLastCalledWith(expected);
  }
  fireEvent.click(view.getByRole("button", { name: "Actions for Main checkout" }));
  expect(view.queryByRole("menuitem", { name: "Delete worktree…" })).toBeNull();
  fireEvent.keyDown(view.getByRole("menu"), { key: "Escape" });
  fireEvent.click(view.getByRole("button", { name: "Actions for Foom" }));
  await act(async () => {
    fireEvent.click(view.getByRole("menuitem", { name: /Remove from Foom…/ }));
    await Promise.resolve();
  });
  expect(view.command).toHaveBeenLastCalledWith({ kind: "remove-repository", repository: "/foom" });
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Add repository" }));
    await Promise.resolve();
  });
  expect(view.add).toHaveBeenCalledOnce();
});

test.each([
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["agy", "Antigravity"],
] as const)("exited %s menus expose only recorded conversations", async (agent, name) => {
  const view = setup();
  await act(async () => {
    await Promise.resolve();
  });
  act(() => {
    view.base.update("a", {
      agent,
      exited: true,
      state: "done",
      conversationId: "conversation-123",
    });
  });
  for (const [label, kind] of [
    [/^Resume conversation/, "resume"],
    ["Copy session ID", "copy-session-id"],
    ["New conversation here", "new-conversation"],
  ] as const) {
    fireEvent.click(view.getByRole("button", { name: `Actions for ${name} in feature` }));
    expect(view.getByText("conversa…")).toBeTruthy();
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: label }));
      await Promise.resolve();
    });
    expect(view.command).toHaveBeenLastCalledWith({ kind, id: "a" });
  }
  act(() => {
    view.base.update("a", { conversationId: undefined, agent: "agy" });
  });
  fireEvent.click(view.getByRole("button", { name: "Actions for Antigravity in feature" }));
  expect(view.queryByRole("menuitem", { name: /^Resume/ })).toBeNull();
  expect(view.queryByRole("menuitem", { name: "Copy session ID" })).toBeNull();
  expect(view.getByRole("menuitem", { name: "New conversation here" })).toBeTruthy();
});

test.each([undefined, "Fetch failed"])(
  "merged cleanup stays available before a successful scan (%s)",
  async (mergedError) => {
    const view = setup();
    await act(async () => {
      await Promise.resolve();
    });
    view.source.getSidebar = () => [
      { ...repository, canDeleteMerged: false, ...(mergedError ? { mergedError } : {}) },
    ];
    view.rerender(<Board source={view.source} />);
    fireEvent.click(view.getByRole("button", { name: "Actions for Foom" }));
    const items = view.getAllByRole("menuitem");
    const removal = items.findIndex((item) => item.textContent.includes("Remove from Foom…"));
    expect(items[removal + 1]?.textContent).toContain("Delete merged worktrees…");
    if (mergedError) {
      expect(view.getByRole("menuitem", { name: mergedError }).hasAttribute("disabled")).toBe(true);
    }
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Delete merged worktrees…" }));
      await Promise.resolve();
    });
    expect(view.command).toHaveBeenCalledWith({
      kind: "delete-merged-worktrees",
      repository: "/foom",
    });
  },
);

test("merged cleanup is absent with only a main checkout", async () => {
  const view = setup(true);
  view.source.getSidebar = () => [
    {
      ...repository,
      worktrees: repository.worktrees.filter((tree) => tree.path === repository.path),
    },
  ];
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.click(view.getByRole("button", { name: "Actions for Foom" }));
  expect(view.queryByRole("menuitem", { name: "Delete merged worktrees…" })).toBeNull();
});

test("an open repository menu hides merged cleanup at zero and restores it when eligibility refreshes", async () => {
  const view = setup();
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.click(view.getByRole("button", { name: "Actions for Foom" }));
  const cleanupAction = view.getByRole("menuitem", { name: "Delete merged worktrees…" });
  fireEvent.keyDown(document.activeElement ?? view.getByRole("menu"), { key: "End" });
  expect(document.activeElement).toBe(cleanupAction);
  view.source.getSidebar = () => [{ ...repository, canDeleteMerged: false, mergedCount: 0 }];
  act(() => {
    view.base.update("a", { state: "quiet_ok" });
  });
  expect(view.queryByRole("menuitem", { name: "Delete merged worktrees…" })).toBeNull();
  expect(document.activeElement).toBe(view.getByRole("menuitem", { name: "New worktree" }));
  fireEvent.keyDown(view.getByRole("menuitem", { name: "New worktree" }), { key: "End" });
  expect(document.activeElement).toBe(view.getByRole("menuitem", { name: /Remove from Foom/ }));
  expect(view.getByText("0 eligible to delete")).toBeTruthy();
  expect(view.getByRole("menu").lastElementChild?.textContent).toContain("Remove from Foom…");
  expect(
    view.getAllByRole("separator").filter((item) => item.closest('[role="menu"]')),
  ).toHaveLength(1);
  const review = view.getByRole("button", { name: "0 eligible to delete" });
  review.focus();
  expect(document.activeElement).toBe(review);
  view.source.getSidebar = () => [{ ...repository, canDeleteMerged: true, mergedCount: 2 }];
  act(() => {
    view.base.update("a", { state: "working" });
  });
  expect(view.getByRole("menuitem", { name: /Delete merged worktrees…/ }).textContent).toBe(
    "Delete merged worktrees…2",
  );
  expect(document.activeElement).toBe(view.getByRole("menuitem", { name: "New worktree" }));
  fireEvent.keyDown(view.getByRole("menuitem", { name: "New worktree" }), { key: "End" });
  expect(document.activeElement).toBe(view.getByRole("menuitem", { name: /Delete merged/ }));
});

test("the zero eligibility fact and cleanup command share the active review", async () => {
  const view = setup();
  const review = Promise.withResolvers<undefined>();
  view.command.mockReturnValueOnce(review.promise);
  let mergedCount = 0;
  view.source.getSidebar = () => [{ ...repository, mergedCount }];
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.click(view.getByRole("button", { name: "Actions for Foom" }));
  const reviewButton = view.getByRole("button", { name: "0 eligible to delete" });
  fireEvent.click(reviewButton);
  fireEvent.click(reviewButton);
  expect(view.command).toHaveBeenCalledWith({
    kind: "delete-merged-worktrees",
    repository: "/foom",
  });
  act(() => {
    mergedCount = 1;
    view.base.update("a", { state: "working" });
  });
  const cleanup = view.getByRole("menuitem", { name: /Delete merged worktrees…/ });
  fireEvent.click(cleanup);
  expect(view.command).toHaveBeenCalledTimes(1);

  await act(async () => {
    review.resolve(undefined);
    await review.promise;
  });
  await act(async () => {
    fireEvent.click(cleanup);
    await Promise.resolve();
  });
  expect(view.command).toHaveBeenCalledTimes(2);
});

test("worktree menus offer only enabled launchers and deletion with an agent running", async () => {
  const view = setup();
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.click(view.getByRole("button", { name: "Actions for feature" }));
  expect(view.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
    "CCClaude Code",
    ">_Shell (zsh)",
    "Resume conversation…",
    "Delete worktree…",
  ]);
});

test("panels support hover intent, right-click pinning, title rename and home launch", async () => {
  vi.useFakeTimers();
  const view = setup();
  await act(async () => {
    await Promise.resolve();
  });
  const row = view.container.querySelector<HTMLElement>(".board-row");
  if (!row) throw Error("Missing session");
  fireEvent.pointerEnter(row);
  act(() => {
    vi.advanceTimersByTime(399);
  });
  expect(view.queryByRole("dialog")).toBeNull();
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(view.getByRole("dialog").getAttribute("data-pinned")).toBe("false");
  fireEvent.contextMenu(row);
  fireEvent.pointerLeave(row);
  act(() => {
    vi.advanceTimersByTime(500);
  });
  expect(view.getByRole("dialog").getAttribute("data-pinned")).toBe("true");
  fireEvent.click(view.getByRole("button", { name: "Rename Claude Code" }));
  fireEvent.change(view.getByLabelText("Session name"), { target: { value: "Panel helper" } });
  fireEvent.keyDown(view.getByLabelText("Session name"), { key: "Enter" });
  expect(row.textContent).toContain("Panel helper");
  fireEvent.keyDown(view.getByRole("dialog"), { key: "Escape" });
  expect(document.activeElement).toBe(row);
  fireEvent.keyDown(view.getByRole("button", { name: "Foom" }), { key: "F10", shiftKey: true });
  expect(view.getByRole("dialog").textContent).toContain("Repository");
  expect(view.queryByRole("menuitem", { name: "Claude Code" })).toBeNull();
  fireEvent.scroll(view.container.querySelector(".board-list") ?? row);
  expect(view.queryByRole("dialog")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Actions for Home shell" }));
  await act(async () => {
    fireEvent.click(view.getByRole("menuitem", { name: "New shell" }));
    await Promise.resolve();
  });
  expect(view.command).toHaveBeenCalledWith({ kind: "home-shell" });
  view.unmount();
  vi.useRealTimers();
});

test("home grouping, name launch, hover traversal and drag suppression", async () => {
  vi.useFakeTimers();
  const view = setup();
  await act(async () => {
    await Promise.resolve();
  });
  act(() => {
    view.base.update("a", { home: true, kind: "shell", agent: "shell" });
  });
  expect(view.getByRole("treeitem", { name: "Home shell" }).textContent).toContain("Shell");
  fireEvent.click(view.getByRole("button", { name: "Toggle home shells" }));
  expect(view.container.querySelector(".board-list .board-row")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Toggle home shells" }));
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "zsh ~" }));
    await Promise.resolve();
  });
  expect(view.command).toHaveBeenCalledWith({ kind: "home-shell" });
  fireEvent.pointerEnter(view.getByRole("button", { name: "Foom" }));
  act(() => {
    vi.advanceTimersByTime(400);
  });
  fireEvent.pointerEnter(view.getByRole("dialog"));
  fireEvent.pointerLeave(view.getByRole("dialog"));
  act(() => {
    vi.advanceTimersByTime(250);
  });
  expect(view.queryByRole("dialog")).toBeNull();
  fireEvent.pointerEnter(view.getByRole("button", { name: "Foom" }));
  act(() => {
    vi.advanceTimersByTime(400);
  });
  fireEvent.pointerDown(view.getByRole("dialog"));
  expect(view.getByRole("dialog").getAttribute("data-pinned")).toBe("true");
  fireEvent.pointerDown(document.body);
  expect(view.queryByRole("dialog")).toBeNull();
  view.unmount();
  vi.useRealTimers();
});

test("removed subjects release pinned intent; Escape works outside and the opener toggles", async () => {
  vi.useFakeTimers();
  const view = setup();
  await act(async () => {
    await Promise.resolve();
  });
  const opener = view.getByRole("button", { name: "Actions for Foom" });
  fireEvent.pointerDown(opener);
  fireEvent.click(opener);
  expect(view.getByRole("dialog")).toBeTruthy();
  fireEvent.pointerDown(opener);
  fireEvent.click(opener);
  expect(view.queryByRole("dialog")).toBeNull();
  fireEvent.pointerEnter(opener);
  act(() => {
    vi.advanceTimersByTime(400);
  });
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(view.queryByRole("dialog")).toBeNull();
  const row = view.container.querySelector(".board-row");
  if (!row) throw Error("Missing row");
  fireEvent.contextMenu(row);
  act(() => {
    view.base.update("a", { id: "replacement" });
  });
  expect(view.queryByRole("dialog")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Actions for Home shell" }));
  expect(view.getByRole("dialog").textContent).toContain("Home shell");
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(view.queryByRole("dialog")).toBeNull();
  view.unmount();
  vi.useRealTimers();
});

test("cleanup progress and finished results remain reachable without folding recreated live rows", async () => {
  const view = setup();
  let progress: NonNullable<SidebarRepository["cleanup"]> = {
    total: 1,
    done: 0,
    phase: "remove",
    stopped: false,
    items: [{ id: "1", path: "/tree", branch: "feature", state: "removing" }],
  };
  view.source.getSidebar = () => [{ ...repository, mergedCount: 0, cleanup: progress }];
  view.rerender(<Board source={view.source} />);
  expect(view.getByText("deleting 0/1")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Actions for Foom" }));
  await act(async () => {
    fireEvent.click(view.getByRole("menuitem", { name: /Deleting merged worktrees/ }));
    await Promise.resolve();
  });
  expect(view.command).toHaveBeenLastCalledWith({
    kind: "delete-merged-worktrees",
    repository: "/foom",
  });
  progress = {
    ...progress,
    done: 1,
    phase: "finished",
    items: [{ id: "1", path: "/tree", branch: "feature", state: "removed", reason: "branch kept" }],
  };
  view.rerender(<Board source={view.source} />);
  expect(view.getByRole("treeitem", { name: /^feature$/ }).getAttribute("data-cleanup")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Actions for Foom" }));
  expect(view.getByRole("menuitem", { name: /Cleanup results/ })).toBeTruthy();
  progress = {
    ...progress,
    id: "first",
    items: [
      { id: "1", path: "/tree", branch: "feature", state: "kept", reason: "uncommitted changes" },
    ],
  };
  view.rerender(<Board source={view.source} />);
  expect(view.getByText("uncommitted changes")).toBeTruthy();
  const row = view.getByRole("treeitem", { name: /^feature$/ }).querySelector(".worktree-row");
  if (!row) throw new Error("Missing row");
  fireEvent.pointerEnter(row);
  fireEvent.pointerLeave(row);
  fireEvent.pointerEnter(row);
  expect(view.queryByText("uncommitted changes")).toBeNull();
  progress = { ...progress, id: "next" };
  view.rerender(<Board source={view.source} />);
  expect(view.getByText("uncommitted changes")).toBeTruthy();
  fireEvent.focus(view.getByRole("button", { name: /^feature$/ }));
  expect(view.queryByText("uncommitted changes")).toBeNull();
});

test("an exited parent offers Revoke only while automatic recovery is pending", async () => {
  const view = setup();
  await act(async () => {
    await Promise.resolve();
  });
  act(() => {
    view.base.update("a", {
      exited: true,
      conversationId: "saved-123",
      orchestration: {
        role: "orchestrator",
        active: false,
        restoreOnResume: true,
        children: 0,
        history: [],
      },
    });
  });
  fireEvent.click(view.getByRole("button", { name: "Actions for Claude Code in feature" }));
  await act(async () => {
    fireEvent.click(view.getByRole("menuitem", { name: "Revoke orchestrator" }));
    await Promise.resolve();
  });
  expect(view.command).toHaveBeenLastCalledWith({ kind: "revoke-orchestrator", id: "a" });
  act(() => {
    view.base.update("a", {
      orchestration: { role: "orchestrator", active: false, children: 0, history: [] },
    });
  });
  fireEvent.click(view.getByRole("button", { name: "Actions for Claude Code in feature" }));
  expect(view.queryByRole("menuitem", { name: "Revoke orchestrator" })).toBeNull();
  expect(view.getByRole("menuitem", { name: /^Resume conversation/ })).toBeTruthy();
});
