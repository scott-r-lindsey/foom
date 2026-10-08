// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WorktreeDialog } from "../../../../src/renderer/board/worktree-dialog";
import type { WorktreeSource, LaunchOptions } from "../../../../src/renderer/board/board-source.d";
import { installation } from "../../../fixtures/setup";

const options: LaunchOptions = {
  repositories: [{ path: "/repo", name: "Repo" }],
  agents: [installation("claude"), installation("codex"), installation("agy", false)],
  enabled: { claude: true, codex: true, agy: false },
  hooks: true,
  acknowledged: false,
};
let source: WorktreeSource;
const close = vi.fn();
beforeEach(() => {
  close.mockClear();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  source = {
    load: vi.fn(() => Promise.resolve(options)),
    addRepository: vi.fn(() => Promise.resolve({ path: "/other", name: "Other" })),
    start: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve(true)),
  };
});
afterEach(cleanup);
async function mount() {
  const screen = render(<WorktreeDialog source={source} close={close} />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return screen;
}
test("launches a named branch using a selected agent and requires the Codex disclosure", async () => {
  const screen = await mount();
  expect(screen.getByRole("dialog").getAttribute("aria-labelledby")).toBe("worktree-title");
  fireEvent.change(screen.getByLabelText("Branch"), { target: { value: "feature" } });
  fireEvent.change(screen.getByLabelText("Run"), { target: { value: "codex" } });
  expect(screen.getByRole("button", { name: "Create and start" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("checkbox"));
  await act(async () => {
    await Promise.resolve();
    fireEvent.click(screen.getByRole("button", { name: "Create and start" }));
  });
  expect(vi.spyOn(source, "start")).toHaveBeenCalledWith({
    repository: "/repo",
    branch: "feature",
    run: "codex",
    acknowledgeCodexNotifierReplacement: true,
  });
  expect(close).toHaveBeenCalledOnce();
});
test("adds a repository, switches repositories and launches a shell", async () => {
  const screen = await mount();
  await act(async () => {
    await Promise.resolve();
    fireEvent.click(screen.getByRole("button", { name: "Add repository…" }));
  });
  expect(screen.getByLabelText("Repository")).toHaveProperty("value", "/other");
  fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "/repo" } });
  fireEvent.change(screen.getByLabelText("Branch"), { target: { value: "my/new-branch" } });
  await act(async () => {
    await Promise.resolve();
    fireEvent.click(screen.getByRole("button", { name: "Create and start" }));
  });
  expect(vi.spyOn(source, "start")).toHaveBeenCalledWith(
    expect.objectContaining({ repository: "/repo", run: "shell" }),
  );
});
test("shows main's branch error as text and keeps the form for correction", async () => {
  vi.spyOn(source, "start").mockRejectedValue(
    new Error("Error invoking remote method 'workspace:start': Error: Invalid branch name"),
  );
  const screen = await mount();
  fireEvent.change(screen.getByLabelText("Branch"), { target: { value: "-bad" } });
  await act(async () => {
    await Promise.resolve();
    fireEvent.click(screen.getByRole("button", { name: "Create and start" }));
  });
  expect(screen.getByRole("alert").textContent).toBe("Invalid branch name");
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Create and start" })).toHaveProperty(
    "disabled",
    false,
  );
});
test("handles picker cancellation and errors without losing existing choices", async () => {
  vi.spyOn(source, "addRepository").mockResolvedValueOnce(null).mockRejectedValueOnce("failure");
  const screen = await mount();
  await act(async () => {
    await Promise.resolve();
    fireEvent.click(screen.getByRole("button", { name: "Add repository…" }));
  });
  expect(screen.getByLabelText("Repository")).toHaveProperty("value", "/repo");
  await act(async () => {
    await Promise.resolve();
    fireEvent.click(screen.getByRole("button", { name: "Add repository…" }));
  });
  expect(screen.getByRole("alert").textContent).toBe("Unable to update worktree.");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(close).toHaveBeenCalledOnce();
});
test("Escape cancels only while idle and focus returns to its opener", async () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const screen = await mount();
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(close).toHaveBeenCalledOnce();
  const pending = Promise.withResolvers<undefined>();
  vi.spyOn(source, "start").mockReturnValueOnce(pending.promise);
  fireEvent.change(screen.getByLabelText("Branch"), { target: { value: "new" } });
  fireEvent.click(screen.getByRole("button", { name: "Create and start" }));
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(close).toHaveBeenCalledOnce();
  await act(async () => {
    await Promise.resolve();
    pending.resolve(undefined);
  });
  screen.unmount();
  expect(document.activeElement).toBe(opener);
  opener.remove();
});
test("loading failures and late results after unmount are handled", async () => {
  vi.spyOn(source, "load").mockRejectedValueOnce(new Error("offline"));
  const screen = await mount();
  expect(screen.getByRole("alert").textContent).toContain("Unable to load");
  screen.unmount();
  for (const reject of [true, false]) {
    const pending = Promise.withResolvers<LaunchOptions>();
    vi.spyOn(source, "load").mockReturnValueOnce(pending.promise);
    const next = render(<WorktreeDialog source={source} close={close} />);
    next.unmount();
    await act(async () => {
      await Promise.resolve();
      if (reject) pending.reject(new Error("late"));
      else pending.resolve(options);
    });
  }
});
test("an empty repo list can be populated and previously acknowledged Codex does not ask again", async () => {
  vi.spyOn(source, "load").mockResolvedValue({
    ...options,
    repositories: [],
    acknowledged: true,
    hooks: false,
  });
  const screen = await mount();
  expect(screen.getByLabelText("Repository")).toHaveProperty("value", "");
  await act(async () => {
    await Promise.resolve();
    fireEvent.click(screen.getByRole("button", { name: "Add repository…" }));
  });
  fireEvent.change(screen.getByLabelText("Run"), { target: { value: "codex" } });
  expect(screen.queryByRole("checkbox")).toBeNull();
});

test("a shared-agent launch stays armed in the form and pointer exit or Escape cancels it", async () => {
  let receive: (
    arm: { nonce: string; target: string; label: string } | null,
    accepted?: boolean,
  ) => void = () => undefined;
  const operation = Promise.withResolvers<undefined>();
  const cancel = vi.fn(() => Promise.resolve());
  const confirm = vi.fn(() => Promise.resolve());
  source.confirmations = {
    subscribe(callback) {
      receive = callback;
      return () => undefined;
    },
    confirm,
    cancel,
  };
  source.start = () => operation.promise;
  const screen = await mount();
  fireEvent.change(screen.getByLabelText("Branch"), { target: { value: "feature" } });
  const button = screen.getByRole("button", { name: "Create and start" });
  fireEvent.pointerLeave(button);
  fireEvent.blur(button);
  fireEvent.click(button);
  const arm = { nonce: "n", target: "feature", label: "Click again for two agents here" };
  act(() => {
    receive(arm);
  });
  fireEvent.click(button);
  expect(confirm).toHaveBeenCalledWith(arm);
  fireEvent.pointerLeave(button);
  expect(cancel).toHaveBeenCalledOnce();
  act(() => {
    receive(arm);
  });
  fireEvent.blur(button);
  expect(cancel).toHaveBeenCalledTimes(2);
  act(() => {
    receive(arm);
  });
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(close).toHaveBeenCalledOnce();
  await act(async () => {
    operation.resolve(undefined);
    await operation.promise;
  });
  expect(close).toHaveBeenCalledOnce();
});

test("a trusted Codex observer removes the notifier disclosure from new worktrees", async () => {
  vi.spyOn(source, "load").mockResolvedValue({
    ...options,
    agents: [{ ...installation("codex"), codexLifecycle: true, codexHookState: "trusted" }],
  });
  const screen = await mount();
  fireEvent.change(screen.getByLabelText("Branch"), { target: { value: "trusted" } });
  fireEvent.change(screen.getByLabelText("Run"), { target: { value: "codex" } });
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.getByRole("button", { name: "Create and start" })).toHaveProperty(
    "disabled",
    false,
  );
});
