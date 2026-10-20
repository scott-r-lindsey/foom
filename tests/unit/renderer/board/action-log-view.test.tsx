import type { ReactNode } from "react";
import type { RenderOptions } from "@testing-library/react";
import {
  ErrorPresentation,
  BackgroundErrorMark,
} from "../../../../src/renderer/board/error-presentation";
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render as renderView, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ActionLog } from "../../../../src/renderer/board/action-log-view";
import type { ActionLogEntry, ActionLogPage } from "../../../../src/shared/action-log";
const render = (ui: ReactNode, options?: RenderOptions) =>
  renderView(ui, {
    ...options,
    wrapper: ({ children }) => (
      <ErrorPresentation>
        {children}
        <BackgroundErrorMark />
      </ErrorPresentation>
    ),
  });

afterEach(cleanup);
const entry: ActionLogEntry = {
  operationId: "operation",
  timestamp: "2026-10-12T00:00:00Z",
  actorId: "parent",
  parentId: "ancestor",
  repository: "repo",
  worktree: "tree",
  action: "reply",
  targetId: "child",
  resultId: "result",
  status: "indeterminate",
  reason: "uncertain",
  proposal: "[REDACTED TOKEN]",
};
it("searches and filters, pages, refreshes, clears with confirmation and disposes", async () => {
  const metadata = { ...entry };
  delete metadata.proposal;
  const read = vi.fn(() =>
    Promise.resolve({
      entries: [
        entry,
        { ...metadata, targetId: null, parentId: null, resultId: null, inputHash: "a".repeat(64) },
      ],
      total: 201,
    }),
  );
  const clear = vi.fn(() => Promise.resolve());
  const close = vi.fn();
  let changed = () => {};
  const off = vi.fn();
  const subscribe = (callback: () => void) => {
    changed = callback;
    return off;
  };
  const view = render(<ActionLog api={{ read, clear }} subscribe={subscribe} close={close} />);
  await view.findByText("201 matching events");
  expect(view.getByRole("searchbox")).toBe(document.activeElement);
  expect(view.getByText("[REDACTED TOKEN]")).toBeTruthy();
  expect(view.getByText("a".repeat(64))).toBeTruthy();
  fireEvent.click(view.getByText("Older"));
  await waitFor(() => {
    expect(read).toHaveBeenLastCalledWith({ search: "", action: "", status: "", offset: 100 });
  });
  fireEvent.click(view.getByText("Newer"));
  fireEvent.change(view.getByRole("searchbox"), { target: { value: "child" } });
  fireEvent.change(view.getByLabelText("Action"), { target: { value: "reply" } });
  fireEvent.change(view.getByLabelText("Outcome"), { target: { value: "indeterminate" } });
  await waitFor(() => {
    expect(read).toHaveBeenLastCalledWith({
      search: "child",
      action: "reply",
      status: "indeterminate",
      offset: 0,
    });
  });
  const calls = read.mock.calls.length;
  act(changed);
  await waitFor(() => {
    expect(read.mock.calls.length).toBe(calls + 1);
  });
  fireEvent.click(view.getByText("Refresh"));
  fireEvent.click(view.getByText("Clear history…"));
  expect(clear).not.toHaveBeenCalled();
  fireEvent.click(view.getByText("Keep history"));
  fireEvent.click(view.getByText("Clear history…"));
  fireEvent.click(view.getByText("Confirm clear history"));
  await waitFor(() => {
    expect(clear).toHaveBeenCalledOnce();
  });
  fireEvent.keyDown(view.getByRole("searchbox"), { key: "a" });
  fireEvent.keyDown(view.getByRole("searchbox"), { key: "Escape" });
  fireEvent.click(view.getByText("Close action log"));
  expect(close).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(off).toHaveBeenCalledOnce();
});
it("shows failures, empty results, and ignores reads after unmount", async () => {
  const read = vi
    .fn<() => Promise<ActionLogPage>>()
    .mockRejectedValueOnce(new Error("disk"))
    .mockResolvedValue({ entries: [], total: 0 });
  const clear = vi.fn(() => Promise.reject(new Error("disk")));
  const view = render(
    <ActionLog api={{ read, clear }} subscribe={() => () => {}} close={() => {}} />,
  );
  await view.findByText("Unable to read the action log.");
  fireEvent.click(view.getByText("Refresh"));
  await view.findByText("No matching actions.");
  fireEvent.click(view.getByText("Clear history…"));
  fireEvent.click(view.getByText("Confirm clear history"));
  await view.findByText("Unable to clear the action log.");
  let done: ((page: ActionLogPage) => void) | undefined;
  read.mockImplementation(
    () =>
      new Promise((resolve) => {
        done = resolve;
      }),
  );
  fireEvent.click(view.getByText("Refresh"));
  view.unmount();
  await act(async () => {
    done?.({ entries: [], total: 0 });
    await Promise.resolve();
  });
  const failed = render(
    <ActionLog
      api={{ read: () => Promise.reject(new Error("late")), clear }}
      subscribe={() => () => {}}
      close={() => {}}
    />,
  );
  failed.unmount();
  await act(async () => {
    await Promise.resolve();
  });
});

it("shows the worktree-relative path for preview opens and supports preview action filtering", async () => {
  const read = vi.fn(() =>
    Promise.resolve({
      entries: [
        {
          ...entry,
          action: "open_preview",
          path: "docs/mockup.html",
          status: "sidebar",
          reason: "completed",
        },
      ],
      total: 1,
    }),
  );
  const view = render(
    <ActionLog
      api={{ read, clear: () => Promise.resolve() }}
      subscribe={() => () => {}}
      close={() => {}}
    />,
  );
  await view.findByText("Opened preview docs/mockup.html");
  fireEvent.change(view.getByLabelText("Action"), { target: { value: "open_preview" } });
  await waitFor(() => {
    expect(read).toHaveBeenLastCalledWith({
      search: "",
      action: "open_preview",
      status: "",
      offset: 0,
    });
  });
});
