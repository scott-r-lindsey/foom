// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { PanelFacts, PanelTitle } from "../../../../src/renderer/board/panel-facts";
import type { PanelSubject } from "../../../../src/renderer/board/panel-facts";
import type { GitPanelFacts } from "../../../../src/shared/panel";
import { createSampleSource } from "../../../../src/renderer/board/sample-board-source";
import { boardRows } from "../../../fixtures/board";
const source = createSampleSource([]);
const row = boardRows(0)[0];
if (!row) throw Error("fixture");
const tree = {
  path: "/tree",
  head: "123456789",
  branch: null,
  managed: false,
  bare: false,
  locked: false,
  prunable: false,
};
const repository = { path: "/repo", name: "Repo", worktrees: [tree], mergedCount: 2 };
const facts: GitPanelFacts = {
  changes: 0,
  upstream: { ahead: 2, behind: 1 },
  commit: { hash: "123456789", subject: "Last change", timestamp: 1000 },
  remote: "origin",
  defaultBranch: "main",
  lastFetch: 1000,
  fetchFailed: false,
  merged: true,
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
test("renders local facts, unknowns, state chips and copy buttons", async () => {
  const writeText = vi.fn(() => Promise.resolve());
  const live = {
    ...source,
    sidebarCommand: writeText,
    panelFacts: vi.fn(() => Promise.resolve(facts)),
  };
  const view = render(
    <PanelFacts
      subject={{ kind: "repository", repository, rows: [row] }}
      source={live}
      options={undefined}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(view.container.textContent).toContain("main");
  expect(view.container.textContent).toContain("2 eligible");
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "/repo" }));
    await Promise.resolve();
  });
  expect(writeText).toHaveBeenCalledWith({
    kind: "copy-worktree-path",
    repository: "/repo",
    worktree: "/repo",
  });
  expect(view.getByRole("status").textContent).toBe("Copied");
  writeText.mockRejectedValueOnce(Error("denied"));
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "/repo" }));
    await Promise.resolve();
  });
  expect(view.getByRole("status").textContent).toBe("Unable to copy");
  view.rerender(
    <PanelFacts
      subject={{ kind: "worktree", repository, tree }}
      source={live}
      options={undefined}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(view.container.textContent).toContain("Detached at 1234567");
  expect(view.container.textContent).toContain("Clean");
  expect(view.container.textContent).toContain("2 ahead · 1 behind");
  expect(view.container.textContent).toContain("Last change");
  expect(view.container.textContent).toContain("Merged into default branch");
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "/tree" }));
    await Promise.resolve();
  });
  expect(writeText).toHaveBeenLastCalledWith({
    kind: "copy-worktree-path",
    repository: "/repo",
    worktree: "/tree",
  });
  view.rerender(
    <PanelFacts
      subject={{
        kind: "home",
        home: { directory: "/home/me", path: "/bin/bash", version: null },
        rows: [],
      }}
      source={live}
      options={undefined}
    />,
  );
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "/home/me" }));
    await Promise.resolve();
  });
  expect(writeText).toHaveBeenLastCalledWith({ kind: "copy-home-path" });
  view.rerender(
    <PanelFacts
      subject={{
        kind: "session",
        row: { ...row, conversationId: "conversation" },
        tile: undefined,
      }}
      source={live}
      options={undefined}
    />,
  );
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "conversation" }));
    await Promise.resolve();
  });
  expect(writeText).toHaveBeenLastCalledWith({ kind: "copy-session-id", id: row.id });
  view.rerender(
    <PanelFacts
      subject={{ kind: "repository", repository, rows: [] }}
      source={source}
      options={undefined}
    />,
  );
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "/repo" }));
    await Promise.resolve();
  });
  expect(view.getByRole("status").textContent).toBe("Unable to copy");
});
test("all row types remain useful without available facts", async () => {
  const subjects: PanelSubject[] = [
    { kind: "home", home: undefined, rows: [] },
    {
      kind: "home",
      home: { directory: "/home/me", path: "/bin/bash", version: "Bash 5" },
      rows: [row],
    },
    { kind: "repository", repository, rows: [] },
    { kind: "worktree", repository, tree: { ...tree, head: null, path: repository.path } },
    { kind: "worktree", repository, tree: { ...tree, branch: "feature", managed: true } },
    { kind: "session", row, tile: undefined },
    {
      kind: "session",
      row: {
        ...row,
        home: true,
        kind: "shell",
        exited: true,
        conversationId: "session-id",
        exitCode: 0,
      },
      tile: 2,
    },
    {
      kind: "session",
      row: { ...row, state: "working", startedAt: 1000, launchFlags: ["--verbose"], bypass: true },
      tile: 1,
    },
  ];
  for (const subject of subjects) {
    const view = render(<PanelFacts subject={subject} source={source} options={undefined} />);
    expect(view.container.querySelector("dt")).toBeTruthy();
    view.unmount();
  }
  const failed = { ...source, panelFacts: () => Promise.reject(Error("git failed")) };
  const view = render(
    <PanelFacts
      subject={{ kind: "worktree", repository, tree }}
      source={failed}
      options={undefined}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(view.container.textContent).toContain("Unknown");
});
test("title edits commit on blur or Enter and Escape cancels", () => {
  const save = vi.fn();
  const view = render(<PanelTitle name="Helper" save={save} />);
  fireEvent.click(view.getByRole("button"));
  fireEvent.change(view.getByLabelText("Session name"), { target: { value: "Changed" } });
  fireEvent.keyDown(view.getByLabelText("Session name"), { key: "Escape" });
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("button"));
  fireEvent.change(view.getByLabelText("Session name"), { target: { value: "" } });
  fireEvent.blur(view.getByLabelText("Session name"));
  expect(save).toHaveBeenLastCalledWith("");
  fireEvent.click(view.getByRole("button"));
  fireEvent.keyDown(view.getByLabelText("Session name"), { key: "a" });
  fireEvent.keyDown(view.getByLabelText("Session name"), { key: "Enter" });
  expect(save).toHaveBeenLastCalledWith("Helper");
});
