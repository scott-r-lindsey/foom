import { agent, mock, settle } from "./app-board-fixture";
// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { expect, test } from "vitest";
import { App } from "../../../../src/renderer/app";
test("the Foom config dock contains its sessions, shows chips, launches there and opens its settings", async () => {
  const configured = {
    ...agent("cfg"),
    config: true,
    repository: "/home/.foom/config",
    worktree: "/home/.foom/config",
    branch: null,
  };
  mock.workspace.mockResolvedValue({ repositories: [], terminals: [configured] });
  const screen = render(<App />);
  await settle();
  const row = screen.container.querySelector(".config-dock");
  if (!row) throw Error("config dock");
  expect(row.querySelector(".board-row")?.textContent).toContain("Claude Code");
  expect(screen.queryByRole("treeitem", { name: "Foom config" })).toBeNull();
  expect(row.textContent).not.toContain("Needs you");
  act(() => {
    mock.configListener?.({
      folder: "/home/.foom/config",
      available: true,
      pending: {
        id: "a".repeat(64),
        action: "turn hooks off",
        file: "settings.json",
        detail: "hooks: on → off",
      },
      rejected: [{ file: "settings.json", reason: "$: malformed-json" }],
    });
  });
  expect(row.textContent).toContain("Needs you");
  expect(row.textContent).toContain("1 rejected");
  fireEvent.click(screen.container.querySelector(".config-gear") ?? document.body);
  const panel = screen.getByRole("dialog", { name: "Foom config details and commands" });
  expect(panel.textContent).toContain("1 rejected");
  expect(panel.textContent).toContain("hooks: on → off");
  fireEvent.click(screen.getByRole("button", { name: "/home/.foom/config" }));
  await settle();
  expect(mock.sidebarCommand).toHaveBeenCalledWith({ kind: "copy-config-path" });
  fireEvent.click(screen.getByRole("menuitem", { name: /^Shell/ }));
  await settle();
  expect(mock.sidebarCommand).toHaveBeenCalledWith({ kind: "config-launch", run: "shell" });
  fireEvent.click(screen.container.querySelector(".config-gear") ?? document.body);
  fireEvent.click(screen.getByRole("menuitem", { name: "Open Foom config settings" }));
  await settle();
  expect(screen.getByRole("heading", { name: "Foom config" })).toBeTruthy();
  const sections = screen.getByRole("navigation", { name: "Settings sections" });
  expect(
    [...sections.querySelectorAll("button")]
      .find((button) => button.textContent === "Foom config")
      ?.getAttribute("aria-current"),
  ).toBe("page");
});

test.each(["via-claude", "via-codex", "via-agy", "via-new-provider"] as const)(
  "%s launches config from Settings and focuses its session",
  async (route) => {
    const screen = render(<App />);
    await settle();
    act(() => {
      mock.command?.("settings");
    });
    await settle();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    const configured = {
      ...agent("cfg"),
      config: true,
      repository: "/home/.foom/config",
      worktree: "/home/.foom/config",
      branch: null,
    };
    // Another launch can appear in the same refresh; select the new config session.
    mock.sidebarCommand.mockImplementationOnce(() => {
      mock.workspace.mockResolvedValue({
        repositories: [],
        terminals: [agent("other"), configured],
      });
      return Promise.resolve();
    });
    act(() => {
      mock.command?.(route);
    });
    await settle();
    expect(mock.sidebarCommand).toHaveBeenLastCalledWith({
      kind: "config-launch",
      run: route.slice(4),
    });
    expect(mock.open).toHaveBeenLastCalledWith("cfg");
    expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();
    mock.open.mockClear();
    mock.sidebarCommand.mockImplementationOnce(() => {
      mock.workspace.mockResolvedValue({
        repositories: [],
        terminals: [agent("other"), configured, { ...configured, id: "cfg-2" }],
      });
      return Promise.resolve();
    });
    act(() => {
      mock.command?.(route);
    });
    await settle();
    expect(mock.open).toHaveBeenLastCalledWith("cfg-2");
    expect(mock.open).not.toHaveBeenCalledWith("cfg");
    expect(screen.container.querySelectorAll(".terminal-tile[data-empty=false]")).toHaveLength(1);
  },
);

test("failed and cancelled menu config launches leave Settings available", async () => {
  const screen = render(<App />);
  await settle();
  act(() => {
    mock.command?.("settings");
  });
  await settle();
  mock.sidebarCommand.mockRejectedValueOnce(new Error("Agent is no longer installed"));
  act(() => {
    mock.command?.("via-claude");
  });
  await settle();
  expect(screen.getByText("Unable to launch Foom config.")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
  act(() => {
    mock.command?.("via-codex");
  });
  await settle();
  expect(mock.open).not.toHaveBeenCalled();
  expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
});
