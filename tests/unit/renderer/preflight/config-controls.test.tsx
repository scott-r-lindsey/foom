// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ConfigControls } from "../../../../src/renderer/preflight/config-controls";
import type { ConfigStatus } from "../../../../src/shared/foom-config";

afterEach(cleanup);

const base: ConfigStatus = {
  folder: "/home/me/.foom/config",
  available: true,
  pending: null,
  rejected: [{ file: "terminal-themes/gruvbox.json", reason: "$.ansi[9]: not-a-color" }],
};

function source(status: ConfigStatus) {
  let listener: ((status: ConfigStatus) => void) | undefined;
  return {
    status: vi.fn(() => Promise.resolve(status)),
    decide: vi.fn(() => Promise.resolve({ ...status, pending: null })),
    openFolder: vi.fn(() => Promise.resolve()),
    subscribe: vi.fn((next: (status: ConfigStatus) => void) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    }),
    push: (next: ConfigStatus) => listener?.(next),
    listening: () => listener !== undefined,
  };
}

test("lists rejected files with their reasons and opens the folder", async () => {
  const config = source(base);
  render(<ConfigControls config={config} />);
  expect(await screen.findByText("terminal-themes/gruvbox.json")).toBeTruthy();
  expect(screen.getByText("/home/me/.foom/config")).toBeTruthy();
  expect(screen.getByText("Rejected")).toBeTruthy();
  expect(screen.getByText("$.ansi[9]: not-a-color")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Revert/ })).toBeNull();
  expect(screen.queryByText("Recent changes")).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Open folder" }));
    await Promise.resolve();
  });
  expect(config.openFolder).toHaveBeenCalled();
});

test("a held change shows the amber banner with Allow and Keep it on", async () => {
  const config = source({
    ...base,
    pending: {
      id: "a".repeat(64),
      action: "turn off the needs-you sound",
      file: "settings.json",
      detail: "sound.alerts: on → off",
    },
  });
  render(<ConfigControls config={config} />);
  expect(await screen.findByText("An agent wants to turn off the needs-you sound")).toBeTruthy();
  expect(screen.getByText("settings.json · sound.alerts: on → off")).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Keep it on" }));
    await Promise.resolve();
  });
  expect(config.decide).toHaveBeenCalledWith("keep", "a".repeat(64));
  expect(screen.queryByText(/An agent wants to/)).toBeNull();
  act(() => {
    config.push({
      ...base,
      pending: {
        id: "b".repeat(64),
        action: "turn hooks off",
        file: "settings.json",
        detail: "hooks: on → off",
      },
    });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await Promise.resolve();
  });
  // Each click names the proposal on screen when it was made.
  expect(config.decide).toHaveBeenLastCalledWith("allow", "b".repeat(64));
});

test("failures are shown, nothing is listed when all is well, and unmount unsubscribes", async () => {
  const config = source({ ...base, rejected: [], error: "The Foom config folder is unavailable." });
  const view = render(<ConfigControls config={config} />);
  expect(await screen.findByText("The Foom config folder is unavailable.")).toBeTruthy();
  expect(screen.queryByRole("list", { name: "Rejected files" })).toBeNull();
  act(() => {
    config.push(base);
  });
  expect(screen.getByRole("list", { name: "Rejected files" })).toBeTruthy();
  config.decide.mockRejectedValue(new Error("The file changed. Review the new change."));
  act(() => {
    config.push({
      ...base,
      pending: { id: "c".repeat(64), action: "turn hooks off", file: "settings.json", detail: "x" },
    });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await Promise.resolve();
  });
  expect(screen.getByRole("alert").textContent).toBe("The file changed. Review the new change.");
  config.openFolder.mockRejectedValue("nope");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Open folder" }));
    await Promise.resolve();
  });
  expect(screen.getByRole("alert").textContent).toBe("Unable to update Foom config.");
  view.unmount();
  expect(config.listening()).toBe(false);
});

test("an unavailable folder reports it", async () => {
  const config = source(base);
  config.status.mockRejectedValue(new Error("no"));
  render(<ConfigControls config={config} />);
  expect((await screen.findByRole("alert")).textContent).toBe("Foom config is unavailable.");
});
