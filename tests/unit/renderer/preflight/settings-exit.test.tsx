// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useSettingsExit } from "../../../../src/renderer/preflight/use-settings-exit";
import type { SetupSource } from "../../../../src/renderer/preflight/setup-source.d";
afterEach(cleanup);
function Fixture({
  installs,
  proceed,
}: {
  installs?: SetupSource["installs"];
  proceed: () => void;
}) {
  const exit = useSettingsExit(installs);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          exit.leave(proceed);
        }}
      >
        Leave
      </button>
      {exit.dialog}
    </>
  );
}
function installs(running = true) {
  return {
    dispose: vi.fn(),
    sessions: () => new Map(),
    hasSessions: () => true,
    running: vi.fn(() => Promise.resolve(running)),
    close: vi.fn(() => Promise.resolve()),
  };
}
test.each([undefined, { ...installs(), hasSessions: () => false }])(
  "no install closes immediately",
  (source) => {
    const proceed = vi.fn();
    render(<Fixture installs={source} proceed={proceed} />);
    fireEvent.click(screen.getByText("Leave"));
    expect(proceed).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  },
);
test("exited installs are disposed before leaving without a dialog", async () => {
  const source = installs(false);
  let finish = () => {};
  source.close.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const proceed = vi.fn();
  render(<Fixture installs={source} proceed={proceed} />);
  fireEvent.click(screen.getByText("Leave"));
  await waitFor(() => {
    expect(source.close).toHaveBeenCalledOnce();
  });
  expect(proceed).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
  await act(async () => {
    finish();
    await Promise.resolve();
  });
  expect(proceed).toHaveBeenCalledOnce();
});
test("Keep open and Escape preserve the install; Stop waits for disposal before navigation", async () => {
  const source = installs();
  const proceed = vi.fn();
  const view = render(<Fixture installs={source} proceed={proceed} />);
  const leave = screen.getByText("Leave");
  leave.focus();
  fireEvent.click(leave);
  const dialog = await screen.findByRole("dialog", { name: "Stop the install?" });
  expect(document.activeElement).toBe(screen.getByText("Keep open"));
  fireEvent.click(leave);
  expect(source.running).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByText("Keep open"));
  expect(proceed).not.toHaveBeenCalled();
  expect(source.close).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(leave);
  fireEvent.click(leave);
  await screen.findByRole("dialog");
  fireEvent.keyDown(screen.getByText("Keep open"), { key: "Escape" });
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(source.close).not.toHaveBeenCalled();
  fireEvent.click(leave);
  await screen.findByRole("dialog");
  let finish = () => {};
  source.close.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(screen.getByText("Stop"));
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(screen.getByText("Keep open").hasAttribute("disabled")).toBe(true);
  expect(proceed).not.toHaveBeenCalled();
  await act(async () => {
    finish();
    await Promise.resolve();
  });
  expect(proceed).toHaveBeenCalledOnce();
  expect(source.close).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog")).toBeNull();
  view.unmount();
  expect(dialog.isConnected).toBe(false);
});
test.each(["read", "close"])("a failed %s leaves Settings open for retry", async (failure) => {
  const source = installs(false);
  if (failure === "read") source.running.mockRejectedValueOnce(new Error("read failed"));
  else source.close.mockRejectedValueOnce(new Error("close failed"));
  const proceed = vi.fn();
  render(<Fixture installs={source} proceed={proceed} />);
  fireEvent.click(screen.getByText("Leave"));
  await screen.findByRole("dialog", { name: "Action failed" });
  expect(proceed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Dismiss"));
  fireEvent.click(screen.getByText("Leave"));
  await waitFor(() => {
    expect(proceed).toHaveBeenCalledOnce();
  });
});
test("unmounting for native window shutdown does not open a second gate or stop an install", () => {
  const source = installs();
  const view = render(<Fixture installs={source} proceed={() => {}} />);
  view.unmount();
  expect(source.running).not.toHaveBeenCalled();
  expect(source.close).not.toHaveBeenCalled();
});
