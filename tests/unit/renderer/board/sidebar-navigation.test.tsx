// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BoardSource } from "../../../../src/renderer/board/board-source.d";
import { Board } from "../../../../src/renderer/board/board-view";
import { createSampleSource } from "../../../../src/renderer/board/sample-board-source";
import { repository, setup, sidebarWithSessions } from "./sidebar-view-fixtures";
beforeEach(() => {
  localStorage.clear();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
});
afterEach(cleanup);

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

test("PR notification focus reveals a filtered collapsed checkout and disposes its subscription", async () => {
  let focus: ((path: string) => void) | undefined;
  const off = vi.fn();
  const command = vi.fn(() => Promise.resolve());
  const pr = {
    number: 12,
    title: "PR",
    url: "https://github.com/o/r/pull/12",
    state: "OPEN" as const,
    checks: { passed: 0, failed: 1, pending: 0 },
  };
  const source: BoardSource = {
    ...createSampleSource([]),
    getSidebar: () => [
      {
        ...repository,
        worktrees: repository.worktrees.map((tree) =>
          tree.path === "/tree" ? { ...tree, pullRequest: pr } : tree,
        ),
      },
    ],
    sidebarCommand: command,
    onFocusWorktree: (listener) => {
      focus = listener;
      return off;
    },
  };
  const view = render(<Board source={source} />);
  fireEvent.change(view.getByLabelText("Filter repositories and sessions"), {
    target: { value: "absent" },
  });
  fireEvent.click(view.getByRole("button", { name: "Collapse sidebar" }));
  act(() => {
    focus?.("/gone");
    focus?.("/tree");
  });
  expect(view.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy();
  expect(document.activeElement?.textContent).toContain("feature");
  fireEvent.click(view.getByRole("button", { name: "Pull request #12 · failed" }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(command).toHaveBeenCalledWith({
    kind: "open-pull-request",
    repository: "/foom",
    worktree: "/tree",
  });
  view.unmount();
  expect(off).toHaveBeenCalled();
});
