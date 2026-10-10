// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ConfigControls, shortAgo } from "../../../../src/renderer/preflight/config-controls";
import type { ConfigStatus } from "../../../../src/shared/foom-config";

afterEach(cleanup);

const now = Date.now();
const base: ConfigStatus = {
  folder: "/home/me/.foom/config",
  available: true,
  uncommitted: 0,
  pending: null,
  rejected: 1,
  changes: [
    {
      id: "a",
      time: now - 2 * 60_000,
      summary: "Add Deep Field theme",
      file: "themes/deep-field.json",
      state: "applied",
      commit: "4c1e9a2".padEnd(40, "0"),
      hash: "4c1e9a2",
    },
    {
      id: "b",
      time: now - 6 * 60_000,
      summary: "Rejected terminal-themes/gruvbox.json",
      file: "terminal-themes/gruvbox.json",
      state: "rejected",
      reason: "$.ansi[9]: not-a-color",
    },
  ],
};

function source(status: ConfigStatus) {
  let listener: ((status: ConfigStatus) => void) | undefined;
  return {
    status: vi.fn(() => Promise.resolve(status)),
    decide: vi.fn(() => Promise.resolve({ ...status, pending: null })),
    revert: vi.fn(() => Promise.resolve(status)),
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

test("lists recent changes with state words, hashes and reasons, and reverts by commit", async () => {
  const config = source(base);
  render(<ConfigControls config={config} />);
  expect(await screen.findByText("Add Deep Field theme")).toBeTruthy();
  expect(screen.getByText("/home/me/.foom/config")).toBeTruthy();
  expect(screen.getByText("Applied")).toBeTruthy();
  expect(screen.getByText("Rejected")).toBeTruthy();
  expect(screen.getByText(/themes\/deep-field\.json · 4c1e9a2/)).toBeTruthy();
  expect(screen.getByText(/ansi\[9\]: not-a-color/)).toBeTruthy();
  // Only applied changes can be reverted.
  expect(screen.getAllByRole("button", { name: /^Revert/ })).toHaveLength(1);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Revert Add Deep Field theme" }));
    await Promise.resolve();
  });
  expect(config.revert).toHaveBeenCalledWith(base.changes[0]?.commit);
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
  expect(config.decide).toHaveBeenCalledWith("keep");
  expect(screen.queryByText(/An agent wants to/)).toBeNull();
  act(() => {
    config.push({
      ...base,
      pending: { action: "turn hooks off", file: "settings.json", detail: "hooks: on → off" },
    });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await Promise.resolve();
  });
  expect(config.decide).toHaveBeenLastCalledWith("allow");
});

test("failures are shown, an empty history says so, and unmount unsubscribes", async () => {
  const config = source({ ...base, changes: [], error: "Git is unavailable." });
  config.revert.mockRejectedValue(new Error("changed after this change"));
  const view = render(<ConfigControls config={config} />);
  expect(await screen.findByText("Git is unavailable.")).toBeTruthy();
  expect(screen.getByText("No changes yet.")).toBeTruthy();
  act(() => {
    config.push(base);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Revert Add Deep Field theme" }));
    await Promise.resolve();
  });
  expect(screen.getByRole("alert").textContent).toBe("changed after this change");
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

test("short ages", () => {
  expect(shortAgo(10 * 60_000, 0)).toBe("10m");
  expect(shortAgo(3 * 3_600_000, 0)).toBe("3h");
  expect(shortAgo(72 * 3_600_000, 0)).toBe("3d");
  expect(shortAgo(0, 1000)).toBe("0m");
});
