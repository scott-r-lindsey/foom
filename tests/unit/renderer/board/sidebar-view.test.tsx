// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { launcherActions } from "../../../../src/renderer/board/sidebar-view";
import { Board } from "../../../../src/renderer/board/board-view";
import { createSampleSource } from "../../../../src/renderer/board/sample-board-source";
import { sampleRows } from "../../../../src/renderer/board/sample-rows";
import { installation } from "../../../fixtures/setup";
import type { SidebarRepository } from "../../../../src/renderer/board/sidebar.d";
import type { BoardSource } from "../../../../src/renderer/board/board-source.d";
const repository: SidebarRepository = {
  path: "/foom",
  name: "Foom",
  worktrees: [
    {
      path: "/foom",
      branch: "main",
      managed: false,
      bare: false,
      locked: false,
      prunable: false,
      head: "abc",
    },
    {
      path: "/tree",
      branch: "feature",
      managed: false,
      bare: false,
      locked: false,
      prunable: false,
      head: "abc",
    },
  ],
};
const load = () =>
  Promise.resolve({
    repositories: [repository],
    agents: [
      installation("claude"),
      { ...installation("codex"), path: null },
      { ...installation("agy"), path: "/agy" },
    ],
    enabled: { claude: true, codex: true, agy: false },
    hooks: true,
    acknowledged: true,
  });
function setup(mainCheckout = false) {
  const original = sampleRows(0)[0];
  if (!original) throw Error("fixture");
  const base = createSampleSource([
    {
      ...original,
      id: "a",
      repository: "Foom",
      repositoryPath: "/foom",
      worktree: mainCheckout ? "/foom" : "/tree",
      branch: mainCheckout ? "main" : "feature",
      kind: "agent",
      agent: "claude",
      managed: true,
      bypass: true,
      exited: false,
    },
  ]);
  const command = vi.fn(() => Promise.resolve());
  const add = vi.fn(() => Promise.resolve(null));
  const source: BoardSource = {
    ...base,
    getSidebar: () => [repository],
    shellName: () => "zsh",
    sidebarCommand: command,
    worktrees: {
      load,
      addRepository: add,
      start: () => Promise.resolve(),
      remove: () => Promise.resolve(true),
    },
  };
  const view = render(<Board source={source} />);
  return { ...view, base, source, command, add };
}
beforeEach(() => {
  localStorage.clear();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
});
afterEach(cleanup);
test("filters reasons, highlights, clears hidden attention and pins in persisted order", async () => {
  const view = setup();
  await act(async () => {
    await Promise.resolve();
  });
  const input = view.getByLabelText("Filter repositories and sessions");
  fireEvent.change(input, { target: { value: "missing" } });
  expect(view.getByRole("button", { name: "1 hidden · needs you · Show" })).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "1 hidden · needs you · Show" }));
  fireEvent.change(input, { target: { value: "feature" } });
  expect(view.container.querySelector("mark")?.textContent).toBe("feature");
  fireEvent.click(view.getByRole("button", { name: "Clear filter" }));
  fireEvent.click(view.getByRole("button", { name: "Actions for Foom" }));
  expect(view.queryByRole("menuitem", { name: "Codex" })).toBeNull();
  expect(view.queryByRole("menuitem", { name: "Antigravity" })).toBeNull();
  fireEvent.click(view.getByRole("menuitem", { name: "Pin to top" }));
  expect(view.getByLabelText("Pinned")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Actions for Foom" }));
  fireEvent.click(view.getByRole("menuitem", { name: "Unpin" }));
  expect(view.queryByLabelText("Pinned")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Collapse Foom" }));
  expect(view.queryByRole("button", { name: "Actions for feature" })).toBeNull();
  expect(view.getByLabelText("Needs you")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Expand Foom" }));
  fireEvent.click(view.getByRole("button", { name: "Collapse feature" }));
  expect(view.container.querySelector(".board-row")).toBeNull();
  fireEvent.change(input, { target: { value: "yes" } });
  fireEvent.change(input, { target: { value: "feature" } });
  expect(view.container.querySelector(".board-row")).toBeTruthy();
});
test("location selection shows breadcrumbs and launches there; menus issue location-specific commands", async () => {
  const view = setup();
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.click(view.getByRole("button", { name: "Foom" }));
  const pane = view.getByRole("region", { name: "Terminal pane" });
  expect(pane.textContent).toContain("Foom");
  await act(async () => {
    fireEvent.click(within(pane).getByRole("button", { name: /Shell/ }));
    await Promise.resolve();
  });
  expect(view.command).toHaveBeenLastCalledWith({
    kind: "launch",
    repository: "/foom",
    worktree: "/foom",
    run: "shell",
  });
  const checkout = view.getByRole("button", { name: "Main checkout" });
  expect(checkout.textContent).toContain("Main checkout");
  expect(checkout.textContent).toContain("main");
  fireEvent.click(checkout);
  expect(pane.textContent).toContain("Foom › Main checkout");
  const filter = view.getByLabelText("Filter repositories and sessions");
  fireEvent.change(filter, { target: { value: "Main checkout" } });
  expect(
    view.getByRole("button", { name: "Main checkout" }).querySelector("mark")?.textContent,
  ).toBe("Main checkout");
  expect(view.queryByRole("button", { name: "feature" })).toBeNull();
  fireEvent.change(filter, { target: { value: "" } });
  fireEvent.click(view.getByRole("button", { name: "feature" }));
  expect(pane.textContent).toContain("Foom › feature");
  for (const [label, expected] of [
    ["Claude Code", { kind: "launch", repository: "/foom", worktree: "/tree", run: "claude" }],
    ["Shell (zsh)", { kind: "launch", repository: "/foom", worktree: "/tree", run: "shell" }],
    ["Remove worktree…", { kind: "remove-worktree", repository: "/foom", worktree: "/tree" }],
  ] as const) {
    fireEvent.click(view.getByRole("button", { name: "Actions for feature" }));
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: label }));
      await Promise.resolve();
    });
    expect(view.command).toHaveBeenLastCalledWith(expected);
  }
  fireEvent.click(view.getByRole("button", { name: "Actions for Main checkout" }));
  expect(view.queryByRole("menuitem", { name: "Remove worktree…" })).toBeNull();
  fireEvent.keyDown(view.getByRole("menu"), { key: "Escape" });
  fireEvent.click(view.getByRole("button", { name: "Actions for Foom" }));
  await act(async () => {
    fireEvent.click(view.getByRole("menuitem", { name: "Remove repository…" }));
    await Promise.resolve();
  });
  expect(view.command).toHaveBeenLastCalledWith({ kind: "remove-repository", repository: "/foom" });
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Add repository" }));
    await Promise.resolve();
  });
  expect(view.add).toHaveBeenCalledOnce();
});
test("repository menu starts a scoped worktree dialog; running and exited sessions have distinct actions", async () => {
  const view = setup();
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.click(view.getByRole("button", { name: "Actions for Foom" }));
  await act(async () => {
    fireEvent.click(view.getByRole("menuitem", { name: "New worktree…" }));
    await Promise.resolve();
  });
  expect(view.getByLabelText("Repository")).toHaveProperty("value", "/foom");
  fireEvent.click(view.getByRole("button", { name: "Cancel" }));
  fireEvent.click(view.getByRole("button", { name: "Actions for Claude Code in feature" }));
  await act(async () => {
    fireEvent.click(view.getByRole("menuitem", { name: "Stop Claude Code" }));
    await Promise.resolve();
  });
  expect(view.command).toHaveBeenLastCalledWith({ kind: "stop", id: "a" });
  act(() => {
    view.base.update("a", { kind: "shell", agent: "shell", exited: true, state: "done" });
  });
  fireEvent.click(view.getByRole("button", { name: "Actions for Shell in feature" }));
  await act(async () => {
    fireEvent.click(view.getByRole("menuitem", { name: "Restart shell" }));
    await Promise.resolve();
  });
  expect(view.command).toHaveBeenLastCalledWith({ kind: "restart", id: "a" });
  fireEvent.click(view.getByRole("button", { name: "Actions for Shell in feature" }));
  await act(async () => {
    fireEvent.click(view.getByRole("menuitem", { name: "Close" }));
    await Promise.resolve();
  });
  expect(view.command).toHaveBeenLastCalledWith({ kind: "close", id: "a" });
});
test("tree keyboard traversal, filter typing, narrow mode and persistence failure stay usable", async () => {
  let resize = () => {};
  let narrow = false;
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return narrow;
    },
    addEventListener: (_name: string, listener: () => void) => {
      resize = listener;
    },
    removeEventListener: vi.fn(),
  }));
  const view = setup();
  await act(async () => {
    await Promise.resolve();
  });
  const name = view.getByRole("button", { name: "Foom" });
  fireEvent.keyDown(name, { key: "ArrowLeft" });
  expect(view.queryByRole("button", { name: "Actions for Main checkout" })).toBeNull();
  fireEvent.keyDown(name, { key: "ArrowRight" });
  expect(view.getByRole("button", { name: "Actions for Main checkout" })).toBeTruthy();
  fireEvent.keyDown(name, { key: "Home" });
  expect(document.activeElement).toBe(name);
  fireEvent.keyDown(name, { key: "End" });
  expect(document.activeElement?.className).toBe("board-row");
  fireEvent.keyDown(name, { key: "ArrowUp" });
  expect(document.activeElement?.className).toBe("board-row");
  fireEvent.keyDown(name, { key: "ArrowDown", ctrlKey: true });
  fireEvent.keyDown(view.getByLabelText("Filter repositories and sessions"), { key: "ArrowDown" });
  const fail = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw Error("full");
  });
  fireEvent.click(view.getByRole("button", { name: "Collapse Foom" }));
  expect(view.getByRole("alert").textContent).toContain("Unable to save");
  fail.mockRestore();
  act(() => {
    narrow = true;
    resize();
  });
  expect(view.queryByRole("button", { name: "Actions for Foom" })).toBeNull();
  expect(view.container.querySelectorAll(".board-row")).toHaveLength(1);
  view.unmount();
  vi.unstubAllGlobals();
});

test("F2 renames the focused session without sending keys to its terminal and add failures are visible", async () => {
  const view = setup();
  await act(async () => {
    await Promise.resolve();
  });
  const row = view.container.querySelector(".board-row");
  if (!row) throw Error("Missing session");
  fireEvent.keyDown(row, { key: "F2" });
  fireEvent.change(view.getByLabelText("Session name"), { target: { value: "Build helper" } });
  fireEvent.keyDown(view.getByLabelText("Session name"), { key: "Enter" });
  fireEvent.change(view.getByLabelText("Filter repositories and sessions"), {
    target: { value: "Build helper" },
  });
  expect(row.textContent).toContain("Build helper");
  view.add.mockRejectedValueOnce(Error("denied"));
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Add repository" }));
    await Promise.resolve();
  });
  expect(view.getByRole("alert").textContent).toBe("Unable to add repository.");
});

test("restarting a renamed shell preserves its name and presents the replacement session", async () => {
  const view = setup();
  await act(async () => {
    await Promise.resolve();
  });
  act(() => {
    view.base.update("a", { kind: "shell", agent: "shell", state: "done", exited: true });
  });
  const row = view.container.querySelector(".board-row");
  if (!row) throw Error("Missing row");
  fireEvent.keyDown(row, { key: "F2" });
  fireEvent.change(view.getByLabelText("Session name"), { target: { value: "Tests" } });
  fireEvent.keyDown(view.getByLabelText("Session name"), { key: "Enter" });
  view.command.mockImplementationOnce(() => {
    view.base.update("a", { id: "replacement", exited: false, state: "working" });
    return Promise.resolve();
  });
  fireEvent.click(view.getByRole("button", { name: "Actions for Tests in feature" }));
  await act(async () => {
    fireEvent.click(view.getByRole("menuitem", { name: "Restart shell" }));
    await Promise.resolve();
  });
  expect(view.getByRole("region", { name: "Terminal pane" }).textContent).toContain("Tests");
  expect(view.getByRole("button", { name: "Actions for Tests in feature" })).toBeTruthy();
});

test("wait labels follow attention and unnamed shells have a plain launcher label", async () => {
  const view = setup();
  await act(async () => {
    await Promise.resolve();
  });
  expect(view.container.querySelector(".board-wait")).not.toBeNull();
  act(() => {
    view.base.update("a", { state: "working" });
  });
  expect(view.container.querySelector(".board-wait")).toBeNull();
  act(() => {
    view.base.update("a", { state: "needs_input", waitingSince: Date.now() });
  });
  expect(view.container.querySelector(".board-wait")?.textContent).toBe("0s");
  expect(launcherActions(undefined, undefined)).toEqual([
    { label: "Shell", badge: ">_", run: "shell" },
  ]);
});

test("main-checkout session breadcrumbs identify the checkout rather than its branch", async () => {
  const view = setup(true);
  await act(async () => {
    await Promise.resolve();
  });
  const checkout = view.getByRole("treeitem", { name: "Main checkout" });
  const session = checkout.querySelector(".board-row");
  if (!session) throw new Error("Missing main-checkout session");
  fireEvent.click(session);
  expect(view.getByRole("heading", { name: "Foom › Main checkout › Claude Code" })).toBeTruthy();
});

test("bypass launches have a neutral glyph and text in the session row", () => {
  const view = setup();
  const badge = view.getByText("Bypass");
  expect(badge.className).toBe("session-bypass");
  expect(badge.closest(".board-row")?.getAttribute("aria-label")).toContain("Bypass");
  expect(badge.querySelector('[aria-hidden="true"]')?.textContent).toBe("◇");
});

test.each([false, true])(
  "marks development builds with neutral sidebar text (%s)",
  (isDevelopment) => {
    const source = { ...createSampleSource([]), isDevelopment };
    const view = render(<Board source={source} />);
    expect(view.queryByText("Dev") !== null).toBe(isDevelopment);
    expect(view.getByRole("heading", { name: isDevelopment ? "foom dev" : "foom" })).toBeTruthy();
  },
);

test("removed checkouts keep neutral labelled sessions and close while hiding launch and restart actions", async () => {
  const view = setup();
  await act(async () => {
    await Promise.resolve();
  });
  const rows = view.source.getSnapshot().map((row) => ({
    ...row,
    kind: "shell" as const,
    agent: "shell",
    exited: true,
    worktreeRemoved: true,
  }));
  const source = {
    ...view.source,
    getSnapshot: () => rows,
    getSidebar: () => [
      { ...repository, worktrees: repository.worktrees.filter((tree) => tree.path === "/foom") },
    ],
  };
  view.rerender(<Board source={source} />);
  expect(view.getAllByText("Worktree removed").length).toBeGreaterThan(0);
  expect(view.queryByRole("button", { name: "Actions for feature" })).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "feature" }));
  expect(view.container.querySelector(".location-launchers")?.textContent).toContain(
    "Worktree removed",
  );
  fireEvent.click(view.getByRole("button", { name: "Actions for Shell in feature" }));
  expect(view.queryByRole("menuitem", { name: "Restart shell" })).toBeNull();
  fireEvent.click(view.getByRole("menuitem", { name: "Close" }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(view.command).toHaveBeenCalledWith({ kind: "close", id: "a" });
});
