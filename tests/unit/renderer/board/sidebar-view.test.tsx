import type { SidebarPreferences } from "../../../../src/renderer/board/sidebar.d";
import { emptyPreferences } from "../../../../src/renderer/board/sidebar-preferences";
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Sidebar, launcherActions } from "../../../../src/renderer/board/sidebar-view";
import { Board } from "../../../../src/renderer/board/board-view";
import { createSampleSource } from "../../../../src/renderer/board/sample-board-source";
import { boardRows as sampleRows } from "../../../fixtures/board";
import { installation } from "../../../fixtures/setup";
import type { SidebarRepository } from "../../../../src/renderer/board/sidebar.d";
import type { BoardRow } from "../../../../src/renderer/board/board.d";
import type { ConfigStatus } from "../../../../src/shared/foom-config";
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
  let listed: SidebarRepository[] = [repository];
  const branches = vi.fn((_repository: string) =>
    Promise.resolve({
      head: "main",
      local: [
        { name: "main", worktree: "/foom" },
        { name: "feature", worktree: "/tree" },
        { name: "codex/old", worktree: null },
      ],
      remote: "origin",
      remoteBranches: ["codex/remote"],
    }),
  );
  const create = vi.fn(async (_repository: string, branch: string) => {
    await Promise.resolve();
    const existing = repository.worktrees.find((tree) => tree.branch === branch);
    if (existing) return { ...existing, outcome: "open" as const };
    const tree = {
      path: `/trees/${branch}`,
      branch,
      managed: true,
      bare: false,
      locked: false,
      prunable: false,
      head: "abc",
    };
    listed = [{ ...repository, worktrees: [...repository.worktrees, tree] }];
    return { ...tree, outcome: "new" as const };
  });
  const source: BoardSource = {
    ...base,
    getSidebar: () => listed,
    shellName: () => "zsh",
    sidebarCommand: command,
    worktrees: {
      load,
      addRepository: add,
      branches,
      create,
      remove: () => Promise.resolve(true),
    },
  };
  const view = render(<Board source={source} />);
  return { ...view, base, source, command, add, branches, create };
}
beforeEach(() => {
  localStorage.clear();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
});
afterEach(cleanup);
async function emptySections(rows: readonly BoardRow[] = []) {
  const source: BoardSource = {
    ...createSampleSource(rows),
    getSidebar: () => [repository, { name: "Empty repo", path: "/empty", worktrees: [] }],
    config: {
      status: () =>
        Promise.resolve({
          folder: "/config",
          available: true,
          uncommitted: 0,
          pending: null,
          changes: [],
          rejected: 0,
        }),
      subscribe: () => () => {},
      openFolder: () => Promise.resolve(),
    },
  };
  const view = render(<Board source={source} />);
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

test("expanded empty Home, repository and worktrees explain that they are empty", async () => {
  const view = await emptySections();
  fireEvent.click(view.getByRole("button", { name: "Expand Empty repo" }));
  fireEvent.click(view.getByRole("button", { name: "Expand Foom" }));
  for (const name of ["Home shell", "Empty repo", "Main checkout", "feature"]) {
    const section = within(view.getByRole("treeitem", { name }));
    expect(section.getByText("Nothing here yet")).toBeTruthy();
    expect(section.queryByText("No matches")).toBeNull();
  }
  for (const name of ["Toggle home shells", "Collapse Empty repo", "Collapse Foom"])
    fireEvent.click(view.getByRole("button", { name }));
  expect(view.queryByText("Nothing here yet")).toBeNull();
});

test.each(["empty", "home", "config"] as const)(
  "unmatched filters show one tree-wide message with %s sessions",
  async (location) => {
    const row = sampleRows(0)[0];
    if (!row) throw Error("fixture");
    const view = await emptySections(
      location === "empty"
        ? []
        : [
            {
              ...row,
              home: location === "home",
              config: location === "config",
              reason: "Unique session reason",
            },
          ],
    );
    const input = view.getByLabelText("Filter repositories and sessions");
    fireEvent.change(input, { target: { value: "no-such-session" } });
    expect(view.getAllByText("No matches")).toHaveLength(1);
    expect(view.queryByText("Nothing here yet")).toBeNull();
    expect(view.container.querySelector(".board-list .board-row")).toBeNull();
    if (location === "home") {
      fireEvent.change(input, { target: { value: "Unique session reason" } });
      expect(view.queryByText("No matches")).toBeNull();
      expect(view.queryByText("Nothing here yet")).toBeNull();
      expect(view.container.querySelectorAll(".board-row")).toHaveLength(1);
    }
    fireEvent.click(view.getByRole("button", { name: "Clear filter" }));
    expect(view.queryByText("No matches")).toBeNull();
    if (location !== "home")
      expect(view.getAllByText("Nothing here yet").length).toBeGreaterThan(0);
  },
);

test("filtering to empty repository or worktree names does not show unfiltered empty hints", async () => {
  const view = await emptySections();
  for (const name of ["Empty repo", "feature"]) {
    fireEvent.change(view.getByLabelText("Filter repositories and sessions"), {
      target: { value: name },
    });
    expect(view.getByRole("treeitem", { name })).toBeTruthy();
    expect(view.queryByText("Nothing here yet")).toBeNull();
    expect(view.queryByText("No matches")).toBeNull();
  }
});

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
  expect(view.container.querySelector(".board-list .board-row")).toBeNull();
  fireEvent.change(input, { target: { value: "yes" } });
  fireEvent.change(input, { target: { value: "feature" } });
  expect(view.container.querySelector(".board-row")).toBeTruthy();
});
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
test("New worktree opens a branch field beside it and returns to the item", async () => {
  const view = setup();
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.click(view.getByRole("button", { name: "Actions for Foom" }));
  const item = view.getByRole("menuitem", { name: "New worktree" });
  expect(item.getAttribute("aria-expanded")).toBe("false");
  await act(async () => {
    fireEvent.click(item);
    await Promise.resolve();
  });
  // The panel stays open, the facts are covered, and the field has focus.
  const field = view.getByLabelText("Branch for the new worktree");
  expect(document.activeElement).toBe(field);
  expect(item.getAttribute("aria-expanded")).toBe("true");
  expect(view.branches).toHaveBeenCalledWith("/foom");
  expect(field.closest(".panel-side")?.hasAttribute("data-field")).toBe(true);
  fireEvent.keyDown(field, { key: "Escape" });
  expect(view.queryByLabelText("Branch for the new worktree")).toBeNull();
  expect(document.activeElement).toBe(item);
  // Right Arrow on the item opens the field; Left Arrow on an empty field returns.
  fireEvent.keyDown(item, { key: "ArrowRight" });
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.keyDown(view.getByLabelText("Branch for the new worktree"), { key: "ArrowLeft" });
  expect(document.activeElement).toBe(item);
  // Escape again closes the panel.
  fireEvent.keyDown(item, { key: "Escape" });
  expect(view.queryByRole("menuitem", { name: "New worktree" })).toBeNull();
});

test("creating moves focus to the arriving row, which settles on hover and on blur", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const scroll = vi.fn();
  Element.prototype.scrollIntoView = scroll;
  try {
    const view = setup();
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(view.getByRole("button", { name: "Actions for Foom" }));
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "New worktree" }));
      await Promise.resolve();
    });
    const field = view.getByLabelText("Branch for the new worktree");
    fireEvent.change(field, { target: { value: "codex/fresh" } });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
      await Promise.resolve();
    });
    expect(view.create).toHaveBeenCalledWith("/foom", "codex/fresh");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // The panel closes and nothing launches; the new row is focused and arriving.
    expect(view.queryByLabelText("Branch for the new worktree")).toBeNull();
    expect(view.command).not.toHaveBeenCalled();
    const row = view.getByRole("button", { name: "codex/fresh" });
    expect(document.activeElement).toBe(row);
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
    const tree = row.closest(".tree-row");
    expect(tree?.classList.contains("arriving")).toBe(true);
    fireEvent.pointerEnter(tree ?? row);
    expect(tree?.classList.contains("arriving")).toBe(true);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(tree?.classList.contains("arriving")).toBe(false);

    // An already checked-out branch creates nothing; its own row arrives instead.
    fireEvent.click(view.getByRole("button", { name: "Actions for Foom" }));
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "New worktree" }));
      await Promise.resolve();
    });
    const again = view.getByLabelText("Branch for the new worktree");
    fireEvent.change(again, { target: { value: "feature" } });
    expect(again.closest(".branch-field")?.querySelector("[role=status]")?.textContent).toBe(
      "open in tree",
    );
    await act(async () => {
      fireEvent.keyDown(again, { key: "Enter" });
      await Promise.resolve();
      await Promise.resolve();
    });
    const existing = view.getByRole("button", { name: "feature" });
    expect(document.activeElement).toBe(existing);
    expect(existing.closest(".tree-row")?.classList.contains("arriving")).toBe(true);
    act(() => {
      existing.blur();
      vi.advanceTimersByTime(0);
    });
    expect(existing.closest(".tree-row")?.classList.contains("arriving")).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("worktree deletion remains disabled when filtering hides its running session", async () => {
  const original = sampleRows(0)[0];
  if (!original) throw new Error("Missing fixture");
  const row = {
    ...original,
    repository: "Foom",
    repositoryPath: "/foom",
    worktree: "/tree",
    branch: "feature",
  };
  const base = createSampleSource([
    { ...row, id: "exited", exited: true, reason: "Visible session" },
    {
      ...row,
      id: "running",
      exited: false,
      kind: "shell",
      agent: "shell",
      reason: "Hidden session",
    },
  ]);
  const source: BoardSource = { ...base, getSidebar: () => [repository] };
  const view = render(<Board source={source} />);
  fireEvent.change(view.getByLabelText("Filter repositories and sessions"), {
    target: { value: "Visible session" },
  });
  expect(view.container.querySelectorAll(".board-row")).toHaveLength(1);
  fireEvent.click(view.getByRole("button", { name: "Actions for feature" }));
  const item = () => view.getByRole("menuitem", { name: "Delete worktree…" });
  expect(item().hasAttribute("disabled")).toBe(true);
  await act(async () => {
    base.update("running", { exited: true });
    await Promise.resolve();
  });
  expect(item().hasAttribute("disabled")).toBe(false);
});

test.each(["agent", "shell"] as const)(
  "worktree deletion follows %s session exit state in an open panel",
  async (kind) => {
    const view = setup();
    act(() => {
      view.base.update("a", { kind });
    });
    fireEvent.click(view.getByRole("button", { name: "Actions for feature" }));
    const item = () => view.getByRole("menuitem", { name: "Delete worktree…" });
    expect(item().hasAttribute("disabled")).toBe(true);
    fireEvent.click(item());
    expect(view.command).not.toHaveBeenCalled();
    act(() => {
      view.base.update("a", { exited: true });
    });
    expect(item().hasAttribute("disabled")).toBe(false);
    act(() => {
      view.base.update("a", { exited: false });
    });
    expect(item().hasAttribute("disabled")).toBe(true);
    act(() => {
      view.base.update("a", { exited: true });
    });
    await act(async () => {
      fireEvent.click(item());
      await Promise.resolve();
    });
    expect(view.command).toHaveBeenCalledWith({
      kind: "remove-worktree",
      repository: "/foom",
      worktree: "/tree",
    });
  },
);

test("running and exited sessions have distinct actions", async () => {
  const view = setup();
  await act(async () => {
    await Promise.resolve();
  });
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
  expect(document.activeElement?.textContent).toContain("zsh ~");
  fireEvent.keyDown(name, { key: "End" });
  expect(document.activeElement?.className).toBe("board-row");
  fireEvent.keyDown(document.activeElement ?? name, { key: "ArrowUp" });
  expect(document.activeElement?.className).toBe("tree-name");
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

test.each(["shell", "agent"] as const)(
  "removed checkouts retain %s sessions without launch actions",
  async (kind) => {
    const view = setup();
    await act(async () => {
      await Promise.resolve();
    });
    const rows = view.source.getSnapshot().map((row) => ({
      ...row,
      kind,
      agent: kind === "shell" ? "shell" : "claude",
      conversationId: kind === "agent" ? "saved-conversation" : undefined,
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
    expect(view.container.querySelector(".location-launchers")).toBeNull();
    expect(view.queryByLabelText("feature details and commands")).toBeNull();
    fireEvent.click(
      view.getByRole("button", {
        name: `Actions for ${kind === "shell" ? "Shell" : "Claude Code"} in feature`,
      }),
    );
    expect(view.queryByRole("menuitem", { name: "Restart shell" })).toBeNull();
    expect(view.queryByRole("menuitem", { name: /^Resume conversation/ })).toBeNull();
    expect(view.queryByRole("menuitem", { name: "New conversation here" })).toBeNull();
    if (kind === "agent")
      expect(view.getByRole("menuitem", { name: "Copy session ID" })).toBeTruthy();
    fireEvent.click(view.getByRole("menuitem", { name: "Close" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.command).toHaveBeenCalledWith({ kind: "close", id: "a" });
  },
);

test.each([
  ["claude", "CC", "Claude Code"],
  ["codex", "CX", "Codex"],
  ["agy", "AG", "Antigravity"],
  ["Claude Code", "CC", "Claude Code"],
  ["Codex", "CX", "Codex"],
  ["Antigravity", "AG", "Antigravity"],
  ["future-agent", "?", "future-agent"],
  ["constructor", "?", "constructor"],
  ["__proto__", "?", "__proto__"],
  ["", "?", "Unknown agent"],
  ["shell", ">_", "Shell (zsh)"],
  ["Shell", ">_", "Shell (zsh)"],
])("%s retains identity after rename without loading artwork", async (agent, mark, identity) => {
  const view = setup();
  await act(async () => {
    await Promise.resolve();
  });
  act(() => {
    view.base.update("a", { agent });
  });
  const row = view.container.querySelector(".board-row");
  if (!row) throw Error("Missing session");
  fireEvent.keyDown(row, { key: "F2" });
  fireEvent.change(view.getByLabelText("Session name"), { target: { value: "Build helper" } });
  fireEvent.keyDown(view.getByLabelText("Session name"), { key: "Enter" });
  expect(row.getAttribute("aria-label")).toContain(`Build helper · ${identity}`);
  expect(row.querySelector(".board-agent")?.textContent).toBe(mark);
  expect(row.querySelector(".board-agent")?.getAttribute("aria-hidden")).toBe("true");
  expect(row.querySelector(".board-agent img, .board-agent svg")).toBeNull();
  const light = row.querySelector(".board-light");
  fireEvent.focus(row);
  expect(view.queryByRole("complementary", { name: "Terminal peek" })).toBeNull();
  fireEvent.blur(row);
  fireEvent.mouseEnter(row);
  expect(view.queryByRole("complementary", { name: "Terminal peek" })).toBeNull();
  expect(row.querySelector(".board-light")).toBe(light);
  fireEvent.click(row);
  expect(view.container.querySelector(".tile-title .board-agent")?.textContent).toBe(mark);
});

test("shell kind keeps the generic glyph and detected name even with another program identity", async () => {
  const view = setup();
  await act(async () => {
    await Promise.resolve();
  });
  act(() => {
    view.base.update("a", { kind: "shell", agent: "bash" });
  });
  const row = view.container.querySelector(".board-row");
  if (!row) throw Error("Missing session");
  expect(row.querySelector(".board-agent")?.textContent).toBe(">_");
  expect(row.getAttribute("aria-label")).toContain("Shell (zsh)");
  fireEvent.click(row);
  expect(view.container.querySelector(".tile-title .board-agent")?.textContent).toBe(">_");
  view.rerender(<Board source={{ ...view.source, shellName: () => "" }} />);
  expect(row.getAttribute("aria-label")).toContain(" · Shell · ");
});

test("merged cleanup appears only when eligible, below repository removal", async () => {
  repository.canDeleteMerged = true;
  repository.mergedError = "Fetch failed";
  const view = setup();
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.click(view.getByRole("button", { name: "Actions for Foom" }));
  const items = view.getAllByRole("menuitem");
  const removal = items.findIndex((item) => item.textContent.includes("Remove from Foom…"));
  expect(items[removal + 1]?.textContent).toContain("Delete merged worktrees…");
  expect(view.getByRole("menuitem", { name: "Fetch failed" }).hasAttribute("disabled")).toBe(true);
  await act(async () => {
    fireEvent.click(view.getByRole("menuitem", { name: "Delete merged worktrees…" }));
    await Promise.resolve();
  });
  expect(view.command).toHaveBeenCalledWith({
    kind: "delete-merged-worktrees",
    repository: "/foom",
  });
  delete repository.canDeleteMerged;
  delete repository.mergedError;
  view.unmount();
  const hidden = setup();
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.click(hidden.getByRole("button", { name: "Actions for Foom" }));
  expect(hidden.queryByRole("menuitem", { name: "Delete merged worktrees…" })).toBeNull();
});

test("open menus receive eligibility published after opening", async () => {
  const view = setup();
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.click(view.getByRole("button", { name: "Actions for Foom" }));
  expect(view.queryByRole("menuitem", { name: "Delete merged worktrees…" })).toBeNull();
  repository.canDeleteMerged = true;
  act(() => {
    view.base.update("a", { state: "quiet_ok" });
  });
  expect(view.getByRole("menuitem", { name: "Delete merged worktrees…" })).toBeTruthy();
  delete repository.canDeleteMerged;
  act(() => {
    view.base.update("a", { state: "working" });
  });
  expect(view.queryByRole("menuitem", { name: "Delete merged worktrees…" })).toBeNull();
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

function sidebarWithSessions(narrow: boolean) {
  vi.stubGlobal("matchMedia", () => ({
    matches: narrow,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  const original = sampleRows(0)[0];
  if (!original) throw Error("fixture");
  const rows = [
    { ...original, repository: "Zulu", repositoryPath: "/zulu", worktree: "/zulu", branch: "main" },
  ];
  const repositories = ["Alpha", "Zulu"].map((name) => ({
    name,
    path: `/${name.toLowerCase()}`,
    worktrees: [
      {
        path: `/${name.toLowerCase()}`,
        branch: "main",
        head: "abc",
        managed: false,
        bare: false,
        locked: false,
        prunable: false,
      },
    ],
  }));
  const branches = vi.fn(() =>
    Promise.resolve({ head: "main", local: [], remote: null, remoteBranches: [] }),
  );
  const source: BoardSource = {
    ...createSampleSource(rows),
    getSidebar: () => repositories,
    worktrees: {
      load: () => new Promise(() => {}),
      branches,
      create: vi.fn(),
      remove: vi.fn(),
      addRepository: vi.fn(),
    },
  };
  const ref: { current: ((repository?: string) => boolean) | undefined } = { current: undefined };
  const view = render(
    <Sidebar
      source={source}
      inactive={false}
      revealRef={{ current: undefined }}
      rows={rows}
      preferences={{ pins: [], expanded: {}, names: {} }}
      save={() => {}}
      selected={undefined}
      buttons={{ current: new Map() }}
      sidebar={{ current: null }}
      open={() => {}}
      focus={() => {}}
      newWorktreeRef={ref}
      command={() => Promise.resolve()}
      options={undefined}
      footer={null}
    />,
  );
  return { ...view, ref, branches };
}

test("without a focused repository, New worktree opens the sidebar's top repository", async () => {
  const view = sidebarWithSessions(false);
  // Repositories with sessions sort first, so Zulu tops the sidebar.
  expect(view.container.querySelector(".repository-row .tree-label")?.textContent).toBe("Zulu");
  await act(async () => {
    expect(view.ref.current?.()).toBe(true);
    await Promise.resolve();
  });
  expect(view.branches).toHaveBeenCalledWith("/zulu");
  vi.unstubAllGlobals();
});

test("a compact sidebar opens the field beside the sidebar", async () => {
  const view = sidebarWithSessions(true);
  expect(view.container.querySelector(".repository-row")).toBeNull();
  await act(async () => {
    expect(view.ref.current?.("/alpha")).toBe(true);
    await Promise.resolve();
  });
  expect(document.activeElement).toBe(view.getByLabelText("Branch for the new worktree"));
  expect(view.branches).toHaveBeenCalledWith("/alpha");
  vi.unstubAllGlobals();
});
test("sessions offer Make and Revoke orchestrator; children offer Take over and panels show actions", async () => {
  const original = sampleRows(0)[0];
  if (!original) throw Error("fixture");
  const row = {
    ...original,
    repository: "Foom",
    repositoryPath: "/foom",
    kind: "agent" as const,
    agent: "claude",
    managed: true,
    exited: false,
  };
  const base = createSampleSource([
    {
      ...row,
      id: "parent",
      worktree: "/foom",
      branch: "main",
      orchestration: {
        role: "orchestrator",
        active: true,
        children: 1,
        history: [
          { id: "o1", action: "launch", label: "feature", status: "succeeded", at: 1 },
          { id: "o2", action: "remove_worktree", label: "old", status: "failed", at: 2 },
        ],
      },
    },
    {
      ...row,
      id: "child",
      worktree: "/tree",
      branch: "feature",
      orchestration: { role: "child", parentId: "parent", takenOver: false },
    },
  ]);
  const command = vi.fn(() => Promise.resolve());
  const source: BoardSource = {
    ...base,
    getSidebar: () => [repository],
    shellName: () => "zsh",
    sidebarCommand: command,
    worktrees: {
      load: () =>
        Promise.resolve({
          repositories: [repository],
          agents: [
            { ...installation("claude"), mcp: false },
            { ...installation("codex"), mcp: true },
            { ...installation("agy"), path: "/agy", cliGuidance: true },
          ],
          enabled: { claude: true, codex: false, agy: true },
          hooks: true,
          acknowledged: true,
        }),
      addRepository: () => Promise.resolve(null),
      branches: () =>
        Promise.resolve({ head: "main", local: [], remote: null, remoteBranches: [] }),
      create: vi.fn(),
      remove: () => Promise.resolve(true),
    },
  };
  const view = render(<Board source={source} />);
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.click(view.getByRole("button", { name: "Actions for Foom" }));
  expect(view.queryByRole("menuitem", { name: /orchestrator/u })).toBeNull();
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  fireEvent.click(view.getByRole("button", { name: "Actions for Claude Code in feature" }));
  expect(view.getByText(/Can stop and read this session/u)).toBeTruthy();
  await act(async () => {
    fireEvent.click(view.getByRole("menuitem", { name: "Reset reviewed replies" }));
    await Promise.resolve();
  });
  expect(command).toHaveBeenLastCalledWith({ kind: "reset-replies", id: "child" });
  fireEvent.click(view.getByRole("button", { name: "Actions for Claude Code in feature" }));
  await act(async () => {
    fireEvent.click(view.getByRole("menuitem", { name: "Take over" }));
    await Promise.resolve();
  });
  expect(command).toHaveBeenLastCalledWith({ kind: "take-over", id: "child" });
  act(() => {
    base.update("child", { orchestration: { role: "child", parentId: "parent", takenOver: true } });
  });
  fireEvent.click(view.getByRole("button", { name: "Actions for Claude Code in feature" }));
  expect(view.queryByRole("menuitem", { name: "Take over" })).toBeNull();
  expect(view.getByText(/You took over/u)).toBeTruthy();
  await act(async () => {
    fireEvent.click(view.getByRole("menuitem", { name: "Make orchestrator…" }));
    await Promise.resolve();
  });
  expect(command).toHaveBeenLastCalledWith({ kind: "make-orchestrator", id: "child" });
  fireEvent.click(
    view.getByRole("button", { name: /^Actions for Claude Code in (main|Main checkout)$/u }),
  );
  expect(view.queryByRole("menuitem", { name: "Make orchestrator…" })).toBeNull();
  expect(view.getByText("Active")).toBeTruthy();
  expect(view.getByText(/1 child running/u)).toBeTruthy();
  const actions = document.querySelector(".panel-actions");
  expect(actions?.textContent).toContain("Remove worktree old · failed");
  expect(actions?.textContent).toContain("Launch feature · done");
  expect(actions?.querySelector('[data-status="failed"]')).toBeTruthy();
  await act(async () => {
    fireEvent.click(view.getByRole("menuitem", { name: "Revoke orchestrator" }));
    await Promise.resolve();
  });
  expect(command).toHaveBeenLastCalledWith({ kind: "revoke-orchestrator", id: "parent" });
});

test.each([true, false])(
  "checkout resume field parses locally, filters agents and cancels (%s)",
  async (main) => {
    const view = setup(main);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(
      view.getByRole("button", {
        name: main ? "Actions for Main checkout" : "Actions for feature",
      }),
    );
    const item = view.getByRole("menuitem", { name: "Resume conversation…" });
    fireEvent.click(item);
    let input = view.getByLabelText("Conversation ID or resume command");
    fireEvent.change(input, { target: { value: "external-123" } });
    expect(view.getByRole("button", { name: "Claude Code" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Codex" })).toBeNull();
    expect(view.queryByRole("button", { name: "Antigravity" })).toBeNull();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(view.queryByLabelText("Conversation ID or resume command")).toBeNull();
    expect(document.activeElement).toBe(item);
    expect(view.command).not.toHaveBeenCalled();
    fireEvent.click(item);
    input = view.getByLabelText("Conversation ID or resume command");
    fireEvent.change(input, { target: { value: "claude -r external-123" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
    });
    expect(view.command).toHaveBeenCalledWith({
      kind: "resume-id",
      checkout: { repository: "/foom", worktree: main ? "/foom" : "/tree" },
      agent: "claude",
      id: "external-123",
    });
  },
);

test("cleanup progress and finished results remain reachable without folding recreated live rows", async () => {
  const view = setup();
  let progress: NonNullable<SidebarRepository["cleanup"]> = {
    total: 1,
    done: 0,
    phase: "remove",
    stopped: false,
    items: [{ id: "1", path: "/tree", branch: "feature", state: "removing" }],
  };
  view.source.getSidebar = () => [{ ...repository, cleanup: progress }];
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

test.each([
  [false, 0, false],
  [true, 0, false],
  [false, 2, false],
  [true, 2, false],
  [false, 0, true],
  [true, 0, true],
  [false, 2, true],
  [true, 2, true],
] as const)("config dock: held=%s rejected=%s session=%s", async (held, rejected, hasSession) => {
  const original = sampleRows(0)[0];
  if (!original) throw Error("fixture");
  const row = { ...original, id: "config-session", config: true, exited: false };
  const status = {
    folder: "/config",
    available: true,
    uncommitted: 0,
    rejected,
    changes: [],
    pending: held
      ? { id: "held", action: "turn off alerts", file: "settings.json", detail: "alerts" }
      : null,
  };
  const base = createSampleSource(hasSession ? [row] : []);
  const source: BoardSource = {
    ...base,
    config: {
      status: () => Promise.resolve(status),
      subscribe: () => () => {},
      openFolder: () => Promise.resolve(),
    },
  };
  const view = render(<Board source={source} />);
  await act(async () => {
    await Promise.resolve();
  });
  const gear = view.container.querySelector<HTMLButtonElement>(".config-gear");
  if (!gear) throw Error("gear");
  expect(gear.getAttribute("aria-label")).toBe(
    `Foom config${held ? ", needs you" : ""}${rejected ? ", 2 rejected" : ""}`,
  );
  expect(gear.getAttribute("data-tone")).toBe(held ? "needs" : rejected ? "failed" : null);
  expect(gear.title).toBe("Foom config");
  expect(view.queryByRole("treeitem", { name: "Foom config" })).toBeNull();
  const dock = view.container.querySelector(".config-dock");
  expect(Boolean(dock)).toBe(held || rejected > 0 || hasSession);
  expect(dock?.querySelector(".config-dock-head")?.textContent.includes("Needs you") ?? false).toBe(
    held,
  );
  expect(dock?.textContent.includes("2 rejected") ?? false).toBe(rejected > 0);
  expect(view.container.querySelector(".board-summary")?.textContent).toContain(
    `${String((held ? 1 : 0) + (hasSession && row.state === "needs_input" ? 1 : 0))} need you`,
  );
  fireEvent.change(view.getByLabelText("Filter repositories and sessions"), {
    target: { value: "Foom config" },
  });
  expect(view.queryByRole("treeitem", { name: "Foom config" })).toBeNull();
  if (hasSession) {
    const session = view.container.querySelector<HTMLElement>(".config-dock .board-row");
    if (!session) throw Error("session");
    expect(session.tabIndex).toBe(0);
    fireEvent.keyDown(session, { key: "Enter" });
    expect(view.container.querySelector(".terminal-tile[data-empty=false]")).toBeTruthy();
    fireEvent.keyDown(session, { key: "F10", shiftKey: true });
    expect(view.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(view.getByRole("dialog"), { key: "Escape" });
  }
  fireEvent.click(gear);
  expect(gear.getAttribute("aria-expanded")).toBe("true");
  fireEvent.keyDown(view.getByRole("dialog"), { key: "Escape" });
  expect(gear.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(view.getByRole("button", { name: "Collapse sidebar" }));
  const count = (held ? 1 : 0) + (hasSession && row.state === "needs_input" ? 1 : 0);
  expect(view.container.querySelector(".rail-needs")?.textContent ?? "").toBe(
    count ? `${String(count)} need you` : "",
  );
  expect(view.container.querySelector(".config-dock")).toBeNull();
  if (hasSession) expect(view.container.querySelector(".board-list .board-row")).toBeTruthy();
});

test("config panel orders Settings, launchers and folder commands; dock uses the gear anchor", async () => {
  const original = sampleRows(0)[0];
  if (!original) throw Error("fixture");
  const command = vi.fn(() => Promise.resolve());
  const settings = vi.fn();
  const openFolder = vi.fn(() => Promise.resolve());
  const base = createSampleSource([{ ...original, config: true, agent: "claude", exited: false }]);
  const view = render(
    <Board
      source={{
        ...base,
        sidebarCommand: command,
        worktrees: {
          load,
          branches: () =>
            Promise.resolve({ head: "main", local: [], remote: null, remoteBranches: [] }),
          addRepository: () => Promise.resolve(null),
          create: () => Promise.reject(Error("unused")),
          remove: () => Promise.resolve(false),
        },
        config: {
          status: () =>
            Promise.resolve({
              folder: "/config",
              available: true,
              uncommitted: 0,
              pending: null,
              rejected: 0,
              changes: [],
            }),
          subscribe: () => () => {},
          openFolder,
        },
      }}
      onSettings={settings}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  const gear = view.container.querySelector<HTMLButtonElement>(".config-gear");
  const dock = view.container.querySelector<HTMLButtonElement>(".config-dock-head");
  if (!gear || !dock) throw Error("footer");
  fireEvent.click(dock);
  const panel = view.getByRole("dialog");
  const items = within(panel).getAllByRole("menuitem");
  expect(items.map((item) => item.textContent)).toEqual([
    "SettingsCtrl+,",
    "CCClaude Coderunning",
    ">_Shell",
    "Open Foom config settings",
    "Open folder",
  ]);
  expect(items[0]).toBe(document.activeElement);
  fireEvent.click(items[0] ?? panel);
  expect(settings).toHaveBeenLastCalledWith();
  fireEvent.click(gear);
  fireEvent.click(view.getByRole("menuitem", { name: "Open Foom config settings" }));
  expect(settings).toHaveBeenLastCalledWith("config");
  fireEvent.click(gear);
  fireEvent.click(view.getByRole("menuitem", { name: /^Claude Code/ }));
  expect(command).toHaveBeenCalledWith({ kind: "config-launch", run: "claude" });
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.click(gear);
  fireEvent.click(view.getByRole("menuitem", { name: "Open folder" }));
  expect(openFolder).toHaveBeenCalledOnce();
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.click(gear);
  fireEvent.pointerDown(document.body);
  expect(view.queryByRole("dialog")).toBeNull();
});

test("config status changes remove an empty dock, retain an exited session and dispose the subscription", async () => {
  const original = sampleRows(0)[0];
  if (!original) throw Error("fixture");
  const base = createSampleSource([]);
  const off = vi.fn();
  let notify: ((status: ConfigStatus) => void) | undefined;
  const clean = {
    folder: "/config",
    available: true,
    uncommitted: 0,
    pending: null,
    rejected: 0,
    changes: [],
  };
  const source: BoardSource = {
    ...base,
    config: {
      status: () => Promise.reject(Error("unavailable")),
      subscribe: (callback) => {
        notify = callback;
        return off;
      },
      openFolder: () => Promise.resolve(),
    },
  };
  const view = render(<Board source={source} />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(view.container.querySelector(".config-dock")).toBeNull();
  act(() => {
    notify?.({ ...clean, rejected: 1 });
  });
  expect(view.container.querySelector(".config-dock")?.textContent).toContain("1 rejected");
  act(() => {
    notify?.(clean);
  });
  expect(view.container.querySelector(".config-dock")).toBeNull();
  const exited = createSampleSource([{ ...original, config: true, exited: true, state: "done" }]);
  view.rerender(<Board source={{ ...source, getSnapshot: exited.getSnapshot }} />);
  expect(view.container.querySelector(".config-dock .board-row")?.getAttribute("data-exited")).toBe(
    "true",
  );
  expect(view.container.querySelector(".config-dock")?.textContent).toContain("exited");
  view.unmount();
  expect(off).toHaveBeenCalled();
});

test("nests visible children beneath exited and revoked parents, supports keys, and leaves orphans visible", () => {
  const original = sampleRows(0)[0];
  if (!original) throw new Error("Missing sample");
  const parent: BoardRow = {
    ...original,
    id: "parent",
    kind: "agent",
    agent: "claude",
    repository: "Foom",
    repositoryPath: "/foom",
    worktree: "/foom",
    branch: "main",
    exited: true,
    orchestration: { role: "orchestrator", active: false, children: 1, history: [] },
  };
  const child: BoardRow = {
    ...parent,
    id: "child",
    agent: "codex",
    worktree: "/tree",
    branch: "feature",
    exited: false,
    state: "needs_input",
    orchestration: { role: "child", parentId: "parent", takenOver: true },
  };
  const base = createSampleSource([parent, child]);
  const revealRef: { current: ((row: BoardRow) => void) | undefined } = { current: undefined };
  const save = vi.fn<(next: SidebarPreferences) => void>();
  const open = vi.fn();
  const props = {
    source: { ...base, getSidebar: () => [repository] },
    rows: base.getSnapshot(),
    selected: "parent",
    filter: "",
    setFilter: vi.fn(),
    preferences: emptyPreferences(),
    save,
    open,
    focus: vi.fn(),
    buttons: { current: new Map<string, HTMLDivElement>() },
    now: 0,
    inactive: false,
    revealRef,
    sidebar: { current: null },
    command: vi.fn(() => Promise.resolve()),
    options: undefined,
    footer: null,
  };
  const view = render(<Sidebar {...props} />);
  const group = view.getByRole("group", { name: "Children of Claude Code" });
  const item = within(group).getByRole("treeitem");
  expect(within(group).getByText("feature")).toBeTruthy();
  expect(view.getByText("Exited orchestrator")).toBeTruthy();
  expect(within(group).getByText("Taken over")).toBeTruthy();
  fireEvent.keyDown(item, { key: "Enter" });
  expect(open).toHaveBeenCalledWith(child);
  fireEvent.keyDown(item, { key: " " });
  fireEvent.focus(item);
  fireEvent.keyDown(item, { key: "ArrowUp" });
  expect(document.activeElement).not.toBe(item);
  view.rerender(<Sidebar {...props} rows={[{ ...parent, exited: false }, child]} />);
  expect(view.getByText("Revoked orchestrator")).toBeTruthy();
  const collapsed = { ...props.preferences, expanded: { "worktree:/foom": false } };
  view.rerender(<Sidebar {...props} preferences={collapsed} />);
  expect(view.queryByRole("group", { name: "Children of Claude Code" })).toBeNull();
  act(() => {
    revealRef.current?.(child);
  });
  expect(save).toHaveBeenLastCalledWith(
    expect.objectContaining({ expanded: { "repository:/foom": true, "worktree:/foom": true } }),
  );
  view.rerender(<Sidebar {...props} rows={[child]} />);
  expect(view.getByText("Parent unavailable · parent")).toBeTruthy();
  view.unmount();
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const compact = render(<Sidebar {...props} />);
  expect(compact.getAllByRole("treeitem", { name: /feature · Codex/u })).toHaveLength(1);
  expect(compact.queryByRole("group", { name: "Children of Claude Code" })).toBeNull();
  compact.unmount();
  vi.unstubAllGlobals();
});

test("sidebar toggle preserves terminal focus, moves tree focus and restores the narrow choice", async () => {
  let narrow = false;
  let resize = () => {};
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return narrow;
    },
    addEventListener: (_name: string, callback: () => void) => {
      resize = callback;
    },
    removeEventListener: vi.fn(),
  }));
  const view = setup();
  await act(async () => {
    await Promise.resolve();
  });
  const filter = view.getByLabelText("Filter repositories and sessions");
  filter.focus();
  fireEvent.click(view.getByRole("button", { name: "Collapse sidebar" }));
  expect(document.activeElement).toBe(view.getByRole("button", { name: "Expand sidebar" }));
  expect(view.container.querySelector(".board-row")?.querySelectorAll(".board-agent")).toHaveLength(
    1,
  );
  expect(view.container.querySelector(".sidebar-shell")?.getAttribute("data-compact")).toBe("true");
  fireEvent.click(view.getByRole("button", { name: "Expand sidebar" }));
  expect(document.activeElement).toBe(view.getByRole("button", { name: "Collapse sidebar" }));
  const input = document.createElement("textarea");
  document.body.append(input);
  input.focus();
  fireEvent.click(view.getByRole("button", { name: "Collapse sidebar" }));
  expect(document.activeElement).toBe(input);
  act(() => {
    narrow = true;
    resize();
  });
  fireEvent.click(view.getByRole("button", { name: "Open sidebar" }));
  expect(view.container.querySelector(".sidebar-shell")?.getAttribute("data-overlay")).toBe("true");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(view.getByRole("button", { name: "Open sidebar" })).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Open sidebar" }));
  const panel = document.createElement("div");
  panel.className = "sidebar-panel";
  document.body.append(panel);
  fireEvent.click(panel);
  expect(view.getByRole("button", { name: "Close sidebar" })).toBeTruthy();
  panel.remove();
  fireEvent.click(document.body);
  expect(view.getByRole("button", { name: "Open sidebar" })).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Open sidebar" }));
  fireEvent.click(view.getByRole("button", { name: "Close sidebar" }));
  act(() => {
    narrow = false;
    resize();
  });
  expect(view.getByRole("button", { name: "Expand sidebar" })).toBeTruthy();
  input.remove();
  view.unmount();
  vi.unstubAllGlobals();
});
