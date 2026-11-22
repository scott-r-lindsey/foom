// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  DecisionPill,
  DecisionsDialog,
  useDecisionCounts,
} from "../../../../src/renderer/board/message-board-decisions";
import type {
  BoardDecision,
  BoardDecisions,
  MessageBoardApi,
} from "../../../../src/shared/message-board";

const first: BoardDecision = {
  repository: "r",
  post: "one",
  index: 0,
  status: "open",
  checks: "success",
  question: {
    title: "Approve the screenshots?",
    detail: "<b>Both themes</b>",
    options: [
      { id: "yes", label: "Yes", hint: "Proceed" },
      { id: "no", label: "No" },
    ],
    preview: { path: "file.html" },
    subject: { pullRequest: 20, headSha: "abc".repeat(14) },
  },
};
const second: BoardDecision = {
  repository: "r",
  post: "two",
  index: 0,
  status: "open",
  question: { title: "Keep the draft?", options: first.question.options },
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function subscription() {
  let listener = () => {};
  const off = vi.fn();
  return {
    off,
    subscribe: (next: () => void) => {
      listener = next;
      return off;
    },
    refresh: () => {
      act(listener);
    },
  };
}

function setup(preview: MessageBoardApi["preview"] = vi.fn(() => Promise.resolve(null))) {
  vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute("open", "");
  });
  vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.removeAttribute("open");
  });
  const h = subscription();
  let rows = [first, second];
  const answer = vi.fn<NonNullable<MessageBoardApi["answer"]>>(() =>
    Promise.resolve({ thread: "t", post: "answer" }),
  );
  const decisions = vi.fn(() => Promise.resolve({ counts: { r: 2 }, questions: rows }));
  const close = vi.fn();
  const api: MessageBoardApi = {
    decisions,
    answer,
    preview,
    threads: vi.fn(),
    read: vi.fn(),
    post: vi.fn(),
    resolve: vi.fn(),
  };
  const view = render(
    <DecisionsDialog
      api={api}
      session={{ repository: "r", name: "Main", questions: rows }}
      subscribe={h.subscribe}
      close={close}
    />,
  );
  return {
    ...h,
    ...view,
    close,
    answer,
    decisions,
    setRows: (next: BoardDecision[]) => {
      rows = next;
      h.refresh();
    },
  };
}

it("names the count and lets the user act only when the pill is visible", () => {
  const open = vi.fn();
  const { getByRole, queryByRole, rerender } = render(
    <DecisionPill count={1} hidden={false} onOpen={open} />,
  );
  fireEvent.click(getByRole("button", { name: "1 decision needed from you" }));
  expect(open).toHaveBeenCalledOnce();
  rerender(<DecisionPill count={3} hidden={true} onOpen={open} />);
  expect(queryByRole("button")).toBeNull();
});

it("reads coalesced counts, ignores out-of-order reads and disposes its subscription", async () => {
  const h = subscription();
  let finish: ((result: BoardDecisions) => void) | undefined;
  const stale = new Promise<BoardDecisions>((resolve) => {
    finish = resolve;
  });
  const current = { counts: { r: 2 }, questions: [] };
  const query = vi
    .fn<NonNullable<MessageBoardApi["decisions"]>>()
    .mockReturnValueOnce(stale)
    .mockResolvedValue(current);
  const view = renderHook(() => useDecisionCounts(query, h.subscribe));
  expect(view.result.current.counts).toEqual({});
  h.refresh();
  await waitFor(() => {
    expect(view.result.current).toEqual(current);
  });
  await act(async () => {
    finish?.({ counts: { r: 1 }, questions: [] });
    await stale;
  });
  expect(view.result.current).toBe(current);
  h.refresh();
  await waitFor(() => {
    expect(query).toHaveBeenCalledTimes(3);
  });
  view.unmount();
  expect(h.off).toHaveBeenCalledOnce();
});

it("reviews choices, keeps Skip pending and retries the same atomic submission", async () => {
  const h = setup();
  h.answer.mockRejectedValueOnce(new Error("lost response"));
  expect(h.getByText("<b>Both themes</b>")).toBeTruthy();
  expect(h.container.querySelector("b")).toBeNull();
  expect(h.getByText("Checks passed")).toBeTruthy();
  await h.findByText("Preview unavailable");
  expect(h.getByText("Next")).toHaveProperty("disabled", true);
  fireEvent.click(h.getByRole("radio", { name: /Yes/ }));
  fireEvent.click(h.getByText("Next"));
  fireEvent.click(h.getByText("Skip"));
  expect(h.getByText("Skipped · stays open")).toBeTruthy();
  fireEvent.click(h.getByRole("button", { name: "Change Keep the draft?" }));
  fireEvent.change(h.getByLabelText("Other answer"), { target: { value: " " } });
  expect(h.getByText("Next")).toHaveProperty("disabled", true);
  fireEvent.change(h.getByLabelText("Other answer"), { target: { value: "Keep in draft" } });
  fireEvent.click(h.getByText("Next"));
  fireEvent.click(h.getByText("Back"));
  expect(h.getByLabelText("Other answer")).toHaveProperty("value", "Keep in draft");
  fireEvent.click(h.getByText("Next"));
  expect(h.getByText("Keep in draft")).toBeTruthy();
  fireEvent.click(h.getByText("Submit 2 answers"));
  await h.findByRole("alert");
  fireEvent.click(h.getByText("Submit 2 answers"));
  await waitFor(() => {
    expect(h.close).toHaveBeenCalledOnce();
  });
  expect(h.answer.mock.calls[1]).toEqual(h.answer.mock.calls[0]);
  expect(h.answer.mock.calls[0]?.[0]).toMatchObject({
    answers: [
      { post: "one", index: 0, option: "yes" },
      { post: "two", index: 0, other: "Keep in draft" },
    ],
  });
});

it("updates watched rows in place and disables stale and withdrawn choices", async () => {
  const preview = vi.fn(() => Promise.resolve("data:image/png;base64,AA=="));
  const h = setup(preview);
  await h.findByRole("img", { name: "Preview of file.html" });
  fireEvent.click(h.getByRole("radio", { name: /Yes/ }));
  fireEvent.click(h.getByText("Next"));
  h.setRows([{ ...first, status: "stale", movedHead: "b".repeat(40) }]);
  await h.findByText("Withdrawn");
  expect(h.container.querySelector("s")?.textContent).toBe("Keep the draft?");
  expect(h.getByLabelText("Other answer").closest("fieldset")).toHaveProperty("disabled", true);
  fireEvent.click(h.getByText("Back"));
  expect(h.getByText("Head moved")).toBeTruthy();
  expect(h.getByText("Answers disabled until main re-asks at the new head")).toBeTruthy();
  expect(h.getByText("abcabcab").tagName).toBe("S");
  expect(h.getByText(/→ bbbbbbbb/)).toBeTruthy();
  const option = h.getByRole("radio", { name: /Yes/ });
  expect(option.getAttribute("aria-disabled")).toBe("true");
  expect(option).toHaveProperty("checked", false);
  expect(h.getByText("Next")).toHaveProperty("disabled", true);
  fireEvent.click(h.getByText("Skip"));
  fireEvent.click(h.getByText("Skip"));
  expect(h.getByText("Submit 0 answers")).toHaveProperty("disabled", true);
  fireEvent(h.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(h.close).toHaveBeenCalledOnce();
  h.unmount();
  expect(h.off).toHaveBeenCalledOnce();
});

it("explains an oversized batch before submission and enables Submit after shortening it", async () => {
  const h = setup();
  await h.findByText("Preview unavailable");
  fireEvent.change(h.getByLabelText("Other answer"), { target: { value: "a".repeat(4200) } });
  fireEvent.click(h.getByText("Next"));
  fireEvent.change(h.getByLabelText("Other answer"), { target: { value: "b".repeat(4200) } });
  fireEvent.click(h.getByText("Next"));
  const submit = h.getByText("Submit 2 answers");
  expect(submit).toHaveProperty("disabled", true);
  expect(h.getByRole("alert").textContent).toContain("8,192 bytes");
  expect(h.answer).not.toHaveBeenCalled();
  fireEvent.click(h.getByRole("button", { name: "Change Keep the draft?" }));
  fireEvent.change(h.getByLabelText("Other answer"), { target: { value: "Shortened" } });
  fireEvent.click(h.getByText("Next"));
  fireEvent.click(h.getByText("Submit 2 answers"));
  await waitFor(() => {
    expect(h.answer).toHaveBeenCalledOnce();
  });
});
