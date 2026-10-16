// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PullRequestMark } from "../../../../src/renderer/board/pull-request";
import type { BoardPullRequest } from "../../../../src/shared/forge";
afterEach(cleanup);
it("labels every check state and opens only on explicit click", async () => {
  const open = vi.fn(async () => {});
  const pr: BoardPullRequest = {
    number: 12,
    title: "<script>Title</script>",
    url: "https://github.com/o/r/pull/12",
    state: "OPEN",
    checks: null,
  };
  const view = render(<PullRequestMark pr={pr} open={open} />);
  expect(view.getByRole("button", { name: "Pull request #12 · unknown" })).toBeTruthy();
  for (const [counts, status] of [
    [{ pending: 1, failed: 0, passed: 0 }, "running"],
    [{ pending: 0, failed: 1, passed: 0 }, "failed"],
    [{ pending: 0, failed: 0, passed: 1 }, "passed"],
    [{ pending: 0, failed: 0, passed: 0 }, "no checks"],
  ] as const) {
    view.rerender(<PullRequestMark pr={{ ...pr, checks: counts }} open={open} />);
    fireEvent.click(view.getByRole("button", { name: `Pull request #12 · ${status}` }));
  }
  expect(open).toHaveBeenCalledTimes(4);
  for (const state of ["MERGED", "CLOSED"] as const) {
    view.rerender(
      <PullRequestMark pr={{ ...pr, state }} open={() => Promise.reject(new Error("removed"))} />,
    );
    const button = view.getByRole("button", { name: `Pull request #12 · ${state.toLowerCase()}` });
    expect(button.textContent).not.toContain("✓");
    fireEvent.click(button);
  }
  await Promise.resolve();
});
