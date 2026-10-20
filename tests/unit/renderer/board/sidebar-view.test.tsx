// @vitest-environment jsdom
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { emptySections, setup } from "./sidebar-view-fixtures";
beforeEach(() => {
  localStorage.clear();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
});
afterEach(cleanup);

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
