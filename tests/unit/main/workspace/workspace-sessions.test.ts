import { expect, test, vi } from "vitest";
import { Workspace } from "../../../../src/main/workspace/workspace";
import type { Launched } from "./workspace-fixture";
import {
  agents,
  bound,
  deps,
  evaluated,
  held,
  launched,
  pastedResume,
  repo,
  tree,
} from "./workspace-fixture";

test("missing IDs cannot resume or copy; failed launch keeps the saved row for retry", async () => {
  const workspace = await launched();
  await workspace.exited("t1", 0);
  await expect(
    workspace.sidebarCommand({ kind: "resume", id: "missing" }, () => Promise.resolve(true)),
  ).rejects.toThrow("Unknown");
  await expect(
    workspace.sidebarCommand({ kind: "resume", id: "t1" }, () => Promise.resolve(true)),
  ).rejects.toThrow("Invalid conversation");
  await expect(
    workspace.sidebarCommand({ kind: "copy-session-id", id: "t1" }, () => Promise.resolve(true)),
  ).rejects.toThrow("No conversation");
  agents.launch.mockRejectedValueOnce(new Error("not installed"));
  await expect(
    workspace.sidebarCommand({ kind: "new-conversation", id: "t1" }, () => Promise.resolve(true)),
  ).rejects.toThrow("not installed");
  expect(workspace.snapshot().terminals[0]).toMatchObject({
    id: "t1",
    exited: true,
    dormant: true,
  });
  await workspace.sidebarCommand({ kind: "new-conversation", id: "t1" }, () =>
    Promise.resolve(true),
  );
  expect(vi.mocked(deps.terminals, true).kill.mock.calls).toHaveLength(1);
  expect(workspace.snapshot().terminals[0]?.exited).toBe(false);
  await workspace.dispose();
});

test("restores metadata without PTYs, allows Resume and Close, and drains persistence", async () => {
  const stored = {
    id: "t1",
    kind: "agent" as const,
    agent: "claude" as const,
    repository: repo.path,
    worktree: tree.path,
    branch: tree.branch,
    attention: "evaluator" as const,
    state: null,
    dormant: true,
    exited: true,
    conversationId: "saved-123",
  };
  const save = vi.fn(() => Promise.resolve());
  const flush = vi.fn(() => Promise.resolve());
  deps.sessions = {
    load: () => Promise.resolve([stored, { ...stored, id: "foreign", repository: "/unknown" }]),
    save,
    flush,
  };
  const workspace = new Workspace(deps);
  await workspace.restore();
  expect(workspace.ownsSession("t1")).toBe(true);
  expect(workspace.ownsSession("foreign")).toBe(true);
  expect(workspace.snapshot().terminals).toHaveLength(2);
  expect(agents.launch).not.toHaveBeenCalled();
  await workspace.sidebarCommand({ kind: "resume", id: "t1" }, () => Promise.resolve(true));
  expect(vi.mocked(deps.terminals, true).kill.mock.calls).toHaveLength(0);
  expect(save).toHaveBeenLastCalledWith([
    expect.objectContaining({ id: "t1", conversationId: "saved-123" }),
    expect.objectContaining({ id: "foreign", exited: true }),
  ]);
  await workspace.exited("t1", 0);
  await workspace.sidebarCommand({ kind: "close", id: "t1" }, () => Promise.resolve(true));
  expect(save).toHaveBeenLastCalledWith([expect.objectContaining({ id: "foreign", exited: true })]);
  await workspace.dispose();
  expect(flush).toHaveBeenCalledOnce();
  const restored = new Workspace(deps);
  await restored.restore();
  vi.mocked(deps.terminals).kill.mockClear();
  await restored.sidebarCommand({ kind: "close", id: "t1" }, () => Promise.resolve(true));
  expect(vi.mocked(deps.terminals, true).kill.mock.calls).toHaveLength(0);
  await restored.dispose();
});

test("captures only valid IDs, persists changes once, and keeps IDs out of evaluation", async () => {
  const save = vi.fn(() => Promise.resolve());
  deps.sessions = { load: () => Promise.resolve([]), save, flush: () => Promise.resolve() };
  const workspace = await launched();
  const key = await bound();
  const signal = {
    terminalId: key,
    action: "needs_input" as const,
    signal: "plugin:claude:PermissionRequest" as const,
    conversationId: "saved-123",
  };
  await workspace.hook({ ...signal, conversationId: "--unsafe" });
  expect(workspace.snapshot().terminals[0]?.conversationId).toBeUndefined();
  await workspace.hook(signal);
  await workspace.hook(signal);
  expect(save).toHaveBeenCalledTimes(2);
  expect(evaluated.at(-1)?.hook).toEqual({
    terminalId: "t1",
    action: "needs_input",
    signal: "plugin:claude:PermissionRequest",
  });
  await workspace.dispose();
});

test("reports persistence failures without interrupting a terminal", async () => {
  const error = new Error("disk unavailable");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  deps.sessions = {
    load: () => Promise.resolve([]),
    save: () => Promise.reject(error),
    flush: () => Promise.resolve(),
  };
  const workspace = await launched();
  expect(log).toHaveBeenCalledWith("Unable to save sessions:", error);
  expect(workspace.snapshot().terminals).toHaveLength(1);
  await workspace.dispose();
});

test("reserving an exited row prevents Close or a second launch racing Resume", async () => {
  const workspace = await launched();
  await workspace.exited("t1", 0);
  const pending = held<Launched>();
  agents.launch.mockReturnValueOnce(pending.promise);
  const restart = workspace.sidebarCommand({ kind: "new-conversation", id: "t1" }, () =>
    Promise.resolve(true),
  );
  await vi.waitFor(() => {
    expect(agents.launch).toHaveBeenCalledTimes(2);
  });
  await expect(
    workspace.sidebarCommand({ kind: "close", id: "t1" }, () => Promise.resolve(true)),
  ).rejects.toThrow("Session is busy");
  await expect(
    workspace.sidebarCommand({ kind: "new-conversation", id: "t1" }, () => Promise.resolve(true)),
  ).rejects.toThrow("Session is busy");
  pending.resolve({ id: "t1", attention: "hooks" });
  await restart;
  expect(workspace.snapshot().terminals[0]?.exited).toBe(false);
  await workspace.dispose();
});

test("pasted resumes retain IDs on exit and reuse the resume path with current defaults", async () => {
  const copy = vi.fn(async () => {});
  deps.copyText = copy;
  const workspace = new Workspace(deps);
  await workspace.sidebarCommand(pastedResume, () => Promise.resolve(true));
  expect(agents.launch).toHaveBeenCalledWith(
    expect.objectContaining({
      agent: "claude",
      conversationId: "external-123",
      worktree: tree.path,
      checkoutIdentity: "identity",
    }),
  );
  expect(workspace.snapshot().terminals[0]).toMatchObject({ conversationId: "external-123" });
  await workspace.exited("t1", 1);
  await workspace.sidebarCommand({ kind: "copy-session-id", id: "t1" }, () =>
    Promise.resolve(true),
  );
  expect(copy).toHaveBeenCalledWith("external-123");
  await workspace.sidebarCommand({ kind: "resume", id: "t1" }, () => Promise.resolve(true));
  expect(agents.launch).toHaveBeenLastCalledWith(
    expect.objectContaining({ conversationId: "external-123", terminalId: "t1" }),
  );
  await workspace.dispose();
});

test("concurrent pasted resumes focus one live conversation, including from another checkout", async () => {
  deps.reveal = vi.fn();
  const workspace = new Workspace(deps);
  await Promise.all([
    workspace.sidebarCommand(pastedResume, () => Promise.resolve(true)),
    workspace.sidebarCommand(
      { ...pastedResume, checkout: { repository: repo.path, worktree: "/other" } },
      () => Promise.resolve(true),
    ),
  ]);
  expect(agents.launch).toHaveBeenCalledOnce();
  expect(deps.reveal).toHaveBeenCalledWith("t1");
  await workspace.dispose();
});

test("pasted resumes reject unavailable agents, invalid IDs and stale checkouts", async () => {
  const workspace = new Workspace(deps);
  await expect(
    workspace.sidebarCommand({ ...pastedResume, id: "--last" }, () => Promise.resolve(true)),
  ).rejects.toThrow();
  await expect(
    workspace.sidebarCommand({ ...pastedResume, agent: "agy" }, () => Promise.resolve(true)),
  ).rejects.toThrow("unavailable");
  vi.mocked(deps.worktrees.launchIdentity).mockRejectedValueOnce(new Error("stale checkout"));
  await expect(workspace.sidebarCommand(pastedResume, () => Promise.resolve(true))).rejects.toThrow(
    "stale checkout",
  );
  expect(agents.launch).not.toHaveBeenCalled();
  await workspace.dispose();
});

test("pasted resumes honor shared-checkout cancellation and release failed launch locks", async () => {
  const workspace = new Workspace(deps);
  await workspace.sidebarCommand(pastedResume, () => Promise.resolve(true));
  const confirm = vi.fn(() => Promise.resolve(false));
  await workspace.sidebarCommand({ ...pastedResume, id: "another" }, confirm);
  expect(confirm).toHaveBeenCalledWith({ kind: "shared-agent" });
  expect(agents.launch).toHaveBeenCalledOnce();
  agents.launch.mockRejectedValueOnce(new Error("spawn failed"));
  await expect(
    workspace.sidebarCommand({ ...pastedResume, id: "another" }, () => Promise.resolve(true)),
  ).rejects.toThrow("spawn failed");
  await workspace.sidebarCommand({ ...pastedResume, id: "another" }, () => Promise.resolve(true));
  expect(agents.launch).toHaveBeenCalledTimes(3);
  await workspace.dispose();
});

test("explicit remote spike routes only home shells and sends no local environment values", async () => {
  const original = process.argv;
  process.argv = [
    ...original,
    "--remote-shell-spike=fixture-cloud",
    "--remote-host-artifact=/fixture/foom-host",
  ];
  const workspace = new Workspace(deps);
  try {
    await workspace.sidebarCommand({ kind: "home-shell" }, () => Promise.resolve(true));
    expect(vi.mocked(deps.terminals, true).create.mock.calls[0]?.[0]).toMatchObject({
      remote: { host: "fixture-cloud", artifact: "/fixture/foom-host" },
      command: "ssh fixture-cloud",
      env: {},
    });
    expect(workspace.snapshot().terminals[0]?.home).toBe(true);
  } finally {
    process.argv = original;
    await workspace.dispose();
  }
});
