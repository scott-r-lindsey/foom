import { expect, test, vi } from "vitest";
import { Workspace } from "../../../../src/main/workspace/workspace";
import { deps, launched, prepare, receiver, repo, tree } from "./workspace-fixture";

test("board forge inventory validates checkout identity and opens only main-owned PR URLs", async () => {
  const { ForgeTracking } = await import("../../../../src/main/control/forge-tracking");
  const root = deps.agentPluginDirectory;
  if (!root) throw new Error("Missing fixture directory");
  const forge = new ForgeTracking(
    root,
    () => Promise.resolve("https://github.com/o/r"),
    () => {},
  );
  deps.forge = forge;
  const sync = vi.spyOn(forge, "sync").mockImplementation(() => {});
  const board = {
    number: 12,
    title: "Plain <title>",
    url: "https://github.com/o/r/pull/12",
    state: "OPEN" as const,
    checks: null,
  };
  const read = vi.spyOn(forge, "readBoard").mockReturnValue(board);
  const readUrl = vi.spyOn(forge, "readUrl").mockReturnValue(board.url);
  const open = vi.fn(() => Promise.resolve());
  deps.openExternal = open;
  const workspace = new Workspace(deps);
  try {
    vi.mocked(deps.worktrees.launchIdentity).mockClear();
    await workspace.sidebarInventory();
    expect(sync).not.toHaveBeenCalled();
    expect(deps.worktrees.launchIdentity).not.toHaveBeenCalled();
    workspace.configure({
      hooks: true,
      agents: { claude: true, codex: true, agy: true },
      showPullRequests: true,
    });
    expect((await workspace.sidebarInventory()).repositories[0]?.worktrees[0]?.pullRequest).toEqual(
      board,
    );
    expect(sync).toHaveBeenCalledWith(repo.path, [
      { repository: repo.path, path: tree.path, branch: tree.branch, identity: "identity" },
    ]);
    await workspace.sidebarCommand(
      { kind: "open-pull-request", repository: repo.path, worktree: tree.path },
      () => Promise.resolve(false),
    );
    expect(open).toHaveBeenCalledExactlyOnceWith(board.url);
    read.mockReturnValue(undefined);
    readUrl.mockReturnValue(undefined);
    await expect(
      workspace.sidebarCommand(
        { kind: "open-pull-request", repository: repo.path, worktree: tree.path },
        () => Promise.resolve(false),
      ),
    ).rejects.toThrow("Pull request unavailable");
    vi.mocked(deps.worktrees.launchIdentity).mockRejectedValueOnce(new Error("replaced"));
    await workspace.sidebarInventory();
    expect(sync).toHaveBeenLastCalledWith(repo.path, []);
    vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([
      { ...tree, branch: null },
      { ...tree, bare: true },
      { ...tree, prunable: true },
    ]);
    await workspace.sidebarInventory();
    expect(sync).toHaveBeenLastCalledWith(repo.path, []);
  } finally {
    await forge.close();
  }
});

test("agent idle and exit request a forge refresh without reading terminal content", async () => {
  const { ForgeTracking } = await import("../../../../src/main/control/forge-tracking");
  const root = deps.agentPluginDirectory;
  if (!root) throw new Error("Missing fixture directory");
  const forge = new ForgeTracking(
    root,
    () => Promise.resolve(undefined),
    () => {},
  );
  deps.forge = forge;
  const recheck = vi.spyOn(forge, "recheck").mockImplementation(() => {});
  const workspace = await launched();
  try {
    const hooks = await prepare?.("claude");
    hooks?.bind?.("t1");
    const key = receiver.register.mock.calls[0]?.[0] ?? "";
    await workspace.hook({
      terminalId: key,
      action: "working",
      signal: "plugin:claude:PreToolUse",
    });
    await workspace.hook({ terminalId: key, action: "classify", signal: "plugin:claude:Stop" });
    expect(recheck).toHaveBeenCalledWith(tree.path);
    recheck.mockClear();
    await workspace.exited("t1", 0);
    expect(recheck).toHaveBeenCalledWith(tree.path);
  } finally {
    await forge.close();
  }
});
