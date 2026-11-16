import { mock, start, invokeWindow } from "./main-fixture";
import { setupState } from "../../fixtures/setup";
import { expect, test, vi } from "vitest";
import type { DataView } from "../../../src/shared/data-views";
vi.mock("../../../src/main/fonts/terminal-fonts", () => ({
  listTerminalFonts: () => Promise.resolve(["Fixture Mono"]),
}));
vi.mock("../../../src/main/sounds/library", () => ({
  SoundLibrary: class {
    list = () => Promise.resolve([]);
  },
}));

test("board wiring connects every subscribed view to its app-owned projection", async () => {
  mock.openWorktrees.mockResolvedValue({
    worktreeRoot: "/trees",
    listRepositories: () => [{ path: "/repo", name: "repo" }],
  });
  mock.setupState.mockResolvedValue(setupState());
  await start();
  const views: DataView[] = [
    "settings",
    "hosts",
    "agents",
    "repositories",
    "worktrees",
    "sessions",
    "environment",
    "config",
    "fonts",
    "sounds",
    "readiness",
  ];
  for (const view of views) {
    await invokeWindow(0, "data:subscribe", {
      id: view,
      view,
      params: view === "worktrees" ? { repository: "/repo" } : {},
    });
    await vi.waitFor(() => {
      expect(mock.window.webContents.send).toHaveBeenCalledWith(
        "data:snapshot",
        expect.objectContaining({ view }),
      );
    });
    expect(mock.window.webContents.send).not.toHaveBeenCalledWith(
      "data:snapshot",
      expect.objectContaining({ view, error: "unavailable" }),
    );
    await invokeWindow(0, "data:unsubscribe", view);
  }
});
