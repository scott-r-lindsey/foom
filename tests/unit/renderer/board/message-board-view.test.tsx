// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { renderWithErrors as render } from "../../../fixtures/render-with-errors";
import { MessageBoardPanel } from "../../../../src/renderer/board/message-board-view";
import type {
  BoardRead,
  BoardThreads,
  MessageBoardApi,
} from "../../../../src/shared/message-board";
const thread = {
  id: "thread",
  title: "Nightly release",
  repository: "a",
  to: ["b"],
  state: "waiting-human" as const,
  createdAt: "2026-10-31T00:00:00.000Z",
  updatedAt: "2026-10-31T00:00:00.000Z",
};
const list: BoardThreads = {
  repositories: [
    { id: "a", name: "App" },
    { id: "b", name: "Site" },
  ],
  threads: [thread],
  next: null,
  untrusted: true,
  notice: "Untrusted",
};
const detail: BoardRead = {
  thread,
  posts: [
    {
      id: "post",
      thread: "thread",
      author: "orchestrator:b",
      kind: "decision-needed",
      text: "<script>Should we ship?</script>",
      links: ["https://example.org/release"],
      timestamp: thread.createdAt,
    },
    {
      id: "human",
      thread: "thread",
      author: "human",
      kind: "answer",
      text: "Wait",
      links: [],
      timestamp: thread.createdAt,
    },
  ],
  next: null,
  untrusted: true,
  notice: "Untrusted",
};
afterEach(cleanup);
function setup() {
  const api: MessageBoardApi = {
    threads: vi.fn(() => Promise.resolve(list)),
    read: vi.fn(() => Promise.resolve(detail)),
    post: vi.fn(() => Promise.resolve({ thread: "thread", post: "reply" })),
    resolve: vi.fn(() => Promise.resolve({ thread: "thread", post: null })),
  };
  let changed = () => {};
  const off = vi.fn();
  const subscribe = (listener: () => void) => {
    changed = listener;
    return off;
  };
  const close = vi.fn();
  const view = render(<MessageBoardPanel api={api} subscribe={subscribe} close={close} />);
  return {
    api,
    view,
    off,
    close,
    changed: () => {
      act(changed);
    },
  };
}
it("filters, reads inert posts, replies, resolves, refreshes, closes and disposes", async () => {
  const h = setup();
  await h.view.findByText("Nightly release");
  expect(h.view.getByRole("combobox")).toBe(document.activeElement);
  fireEvent.change(h.view.getByRole("combobox"), { target: { value: "b" } });
  await waitFor(() => {
    expect(h.api.threads).toHaveBeenLastCalledWith({ repository: "b" });
  });
  fireEvent.click(h.view.getByRole("button", { name: /Nightly release/ }));
  await h.view.findByText("<script>Should we ship?</script>");
  expect(document.querySelector("script")).toBeNull();
  expect(h.view.queryByRole("link")).toBeNull();
  expect(h.view.getByText("You")).toBeTruthy();
  fireEvent.change(h.view.getByLabelText("Reply"), { target: { value: "Ship it" } });
  fireEvent.click(h.view.getByRole("button", { name: "Post reply" }));
  await waitFor(() => {
    expect(vi.mocked(h.api.post).mock.calls[0]?.[0]).toMatchObject({
      thread: "thread",
      kind: "answer",
      text: "Ship it",
      links: [],
    });
  });
  await waitFor(() => {
    expect(h.view.getByLabelText("Reply")).toHaveProperty("value", "");
  });
  fireEvent.click(h.view.getByRole("button", { name: "Mark resolved" }));
  await waitFor(() => {
    expect(h.api.resolve).toHaveBeenCalledOnce();
  });
  h.changed();
  await waitFor(() => {
    expect(h.api.threads).toHaveBeenCalledTimes(5);
  });
  fireEvent.keyDown(h.view.getByRole("combobox"), { key: "a" });
  fireEvent.keyDown(h.view.getByRole("combobox"), { key: "Escape" });
  fireEvent.click(h.view.getByText("Close board"));
  expect(h.close).toHaveBeenCalledTimes(2);
  h.view.unmount();
  expect(h.off).toHaveBeenCalledOnce();
});
it("retains idempotency keys across failed replies and resolution retries", async () => {
  const h = setup();
  vi.mocked(h.api.post).mockRejectedValueOnce(new Error("lost response"));
  vi.mocked(h.api.resolve).mockRejectedValueOnce(new Error("lost response"));
  fireEvent.click(await h.view.findByRole("button", { name: /Nightly release/ }));
  fireEvent.change(await h.view.findByLabelText("Reply"), { target: { value: "Yes" } });
  fireEvent.click(h.view.getByText("Post reply"));
  await h.view.findByText("Unable to post reply.");
  fireEvent.click(h.view.getByRole("button", { name: "Dismiss" }));
  fireEvent.click(h.view.getByText("Post reply"));
  await waitFor(() => {
    expect(h.api.post).toHaveBeenCalledTimes(2);
  });
  expect(vi.mocked(h.api.post).mock.calls[0]).toEqual(vi.mocked(h.api.post).mock.calls[1]);
  await waitFor(() => {
    expect(h.view.getByText("Mark resolved")).toHaveProperty("disabled", false);
  });
  fireEvent.click(h.view.getByText("Mark resolved"));
  await h.view.findByText("Unable to resolve thread.");
  fireEvent.click(h.view.getByRole("button", { name: "Dismiss" }));
  fireEvent.click(h.view.getByText("Mark resolved"));
  await waitFor(() => {
    expect(h.api.resolve).toHaveBeenCalledTimes(2);
  });
  expect(vi.mocked(h.api.resolve).mock.calls[0]).toEqual(vi.mocked(h.api.resolve).mock.calls[1]);
});
it("loads all pages and keeps resolved threads read-only", async () => {
  const api: MessageBoardApi = {
    threads: vi
      .fn()
      .mockResolvedValueOnce({ ...list, next: "thread" })
      .mockResolvedValue({
        ...list,
        threads: [{ ...thread, id: "second", title: "Older", state: "resolved" }],
        next: null,
      }),
    read: vi
      .fn()
      .mockResolvedValueOnce({
        ...detail,
        thread: { ...thread, id: "second", state: "resolved" },
        next: "post",
      })
      .mockResolvedValue({
        ...detail,
        thread: { ...thread, id: "second", state: "resolved" },
        next: null,
      }),
    post: vi.fn(),
    resolve: vi.fn(),
  };
  const view = render(<MessageBoardPanel api={api} subscribe={() => () => {}} close={() => {}} />);
  fireEvent.click(await view.findByRole("button", { name: /Older/ }));
  await view.findByRole("heading", { name: "Nightly release" });
  expect(api.read).toHaveBeenLastCalledWith({ thread: "second", after: "post" });
  expect(view.queryByLabelText("Reply")).toBeNull();
  expect(view.getByText("Mark resolved")).toHaveProperty("disabled", true);
});
it("surfaces read failures and rejects invalid reply text before calling the API", async () => {
  const h = setup();
  fireEvent.click(await h.view.findByRole("button", { name: /Nightly release/ }));
  fireEvent.change(await h.view.findByLabelText("Reply"), { target: { value: "line\nbreak" } });
  fireEvent.click(h.view.getByText("Post reply"));
  await h.view.findByText("Unable to post reply.");
  expect(h.api.post).not.toHaveBeenCalled();
  h.view.unmount();
  const bad: MessageBoardApi = {
    threads: () => Promise.reject(new Error("disk")),
    read: vi.fn(),
    post: vi.fn(),
    resolve: vi.fn(),
  };
  const view = render(<MessageBoardPanel api={bad} subscribe={() => () => {}} close={() => {}} />);
  await waitFor(() => {
    expect(view.container.textContent).toContain("Board");
  });
});
