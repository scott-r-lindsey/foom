// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { GithubSignInState } from "../../../../src/shared/registered-hosts.d";
import type { SetupSource } from "../../../../src/renderer/preflight/setup-source.d";
import { GithubSignInPanel } from "../../../../src/renderer/preflight/github-sign-in";
vi.mock("../../../../src/renderer/preflight/host-terminal", () => ({
  HostTerminal: ({ label, activeLabel }: { label: string; activeLabel: string }) => (
    <div role="region" aria-label={label}>
      {activeLabel}
    </div>
  ),
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const waiting: GithubSignInState = {
  phase: "waiting",
  code: "ABCD-1234",
  copied: true,
  opened: true,
};
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}
function fixture(installing = false) {
  vi.useFakeTimers();
  const api = vi.fn<NonNullable<SetupSource["githubSignIn"]>>().mockResolvedValue(waiting);
  const finished = vi.fn();
  const source: SetupSource["hostTerminal"] = { createView: vi.fn(), observe: vi.fn() };
  const result = render(
    <GithubSignInPanel
      id="gh"
      source={{ githubSignIn: api, hostTerminal: source }}
      finished={finished}
      installing={installing}
    />,
  );
  return { api, finished, result };
}
test("waiting shows the code, independent success markers, fallback actions and collapsed terminal", async () => {
  const { api, result } = fixture();
  expect(screen.getByRole("status").textContent).toBe("Starting…");
  await flush();
  expect(screen.getByRole("status").textContent).toContain("Needs you");
  expect(screen.getByText("ABCD-1234")).toBeTruthy();
  expect(screen.getByText("✓ Copied")).toBeTruthy();
  expect(screen.getByText("✓ Browser opened")).toBeTruthy();
  const toggle = screen.getByRole("button", { name: "▸ Terminal" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(screen.getByRole("region", { name: "Sign-in terminal" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "▾ Terminal" }));
  expect(screen.queryByRole("region", { name: "Sign-in terminal" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
  await flush();
  expect(api).toHaveBeenCalledWith("gh", "copy");
  fireEvent.click(screen.getByRole("button", { name: "Open GitHub" }));
  await flush();
  expect(api).toHaveBeenCalledWith("gh", "open");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await flush();
  expect(api).toHaveBeenCalledWith("gh", "cancel");
  result.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
test("install starts open, then finishing and success close the panel and refresh once", async () => {
  const { api, finished } = fixture(true);
  expect(screen.getByRole("status").textContent).toBe("Installing…");
  await flush();
  api.mockResolvedValue({ phase: "finishing", copied: true, opened: true });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(screen.getByRole("status").textContent).toBe("Finishing…");
  api.mockResolvedValue({ phase: "done", copied: true, opened: true, exitCode: 0 });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(screen.queryByRole("region", { name: "GitHub sign-in" })).toBeNull();
  expect(finished).toHaveBeenCalledExactlyOnceWith("gh", true);
  expect(vi.getTimerCount()).toBe(0);
});
test.each(["failed", "expired"] as const)(
  "%s opens the terminal with the final result",
  async (phase) => {
    const { api, finished } = fixture();
    await flush();
    api.mockResolvedValue({ phase, copied: false, opened: false, exitCode: 7 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(screen.getByRole("status").textContent).toBe(
      phase === "expired" ? "Failed · Code expired" : "Failed · Exit 7",
    );
    expect(screen.getByRole("region", { name: "Sign-in terminal" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(finished).toHaveBeenCalledOnce();
  },
);
test("blocked markers stay visible and action or polling failures retain the terminal", async () => {
  const { api } = fixture();
  await flush();
  api.mockResolvedValue({ ...waiting, copied: false, opened: false });
  fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
  await flush();
  expect(screen.getByText("Not copied")).toBeTruthy();
  expect(screen.getByText("Browser not opened")).toBeTruthy();
  api.mockRejectedValue(new Error("unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "Open GitHub" }));
  await flush();
  expect(screen.getByRole("status").textContent).toBe("Unable to check sign-in");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(screen.getByRole("region", { name: "Sign-in terminal" })).toBeTruthy();
});
test("unmount revokes an in-flight reply", async () => {
  const { api, result, finished } = fixture();
  await flush();
  let resolve = (_state: GithubSignInState) => {};
  api.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  result.unmount();
  resolve({ phase: "done", copied: false, opened: false });
  await flush();
  expect(finished).not.toHaveBeenCalled();
});
