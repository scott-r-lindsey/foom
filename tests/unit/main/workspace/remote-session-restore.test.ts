import { expect, test, vi } from "vitest";
import {
  discoverRemoteSessions,
  reattachRemoteSession,
} from "../../../../src/main/workspace/remote-session-restore";
import { homeDirectory } from "../../../../src/main/workspace/home-shell";
import type { Hosts } from "../../../../src/main/setup/hosts";
import type { StoredSession } from "../../../../src/main/workspace/session-restore.d";
import type { AgentLaunch, AgentLaunched } from "../../../../src/shared/agents";
import type { TerminalSpec } from "../../../../src/shared/desktop";
const entry: StoredSession = {
  id: "one",
  agent: "claude",
  kind: "agent",
  repository: "/repo",
  worktree: "/foom-remote/tree",
  branch: "topic",
  attention: "evaluator",
  state: null,
  remote: true,
  placement: { kind: "remote", host: "worker" },
  conversationId: "conversation",
};
const checkout = {
  host: "worker",
  codeFolder: "/code",
  localRepository: "/repo",
  repository: "/code/repo",
  path: "/code/.foom-worktree-topic",
  branch: "topic",
  identity: "a".repeat(64),
};
const hosts = {
  registered: vi.fn(() => ({ host: "worker", codeFolder: "/code" })),
  placement: vi.fn(() => checkout),
  sessions: vi.fn<Hosts["sessions"]>(),
};
test("profile discovery creates ordinary human rows without inheriting any parent or grants", async () => {
  hosts.sessions.mockResolvedValue([
    {
      host: "worker",
      session: {
        id: "one",
        context: {
          repository: "/repo",
          worktree: entry.worktree,
          branch: "topic",
          agent: "claude",
        },
      },
    },
    { host: "worker", session: { id: "shell" } },
  ]);
  const rows = await discoverRemoteSessions(hosts);
  expect(rows[0]).toMatchObject({
    id: "one",
    agent: "claude",
    running: true,
    exited: true,
    dormant: true,
    remote: true,
    placement: entry.placement,
  });
  expect(rows[0]).not.toHaveProperty("parentId");
  expect(rows[0]).not.toHaveProperty("orchestrator");
  expect(rows[1]).toMatchObject({ agent: "shell", home: true, repository: homeDirectory });
  expect(await discoverRemoteSessions({ registered: hosts.registered })).toEqual([]);
  hosts.sessions.mockResolvedValue([
    {
      host: "worker",
      session: {
        id: "custom",
        context: { repository: "/repo", worktree: entry.worktree, branch: null, agent: "custom" },
      },
    },
  ]);
  expect((await discoverRemoteSessions(hosts))[0]?.agent).toBe("shell");
});
test("saved owned children reconnect without new agent-open or transcript access, and retain a live-parent guard", async () => {
  const create = vi.fn<(spec: TerminalSpec) => Promise<string>>();
  const launch = vi
    .fn<(request: AgentLaunch) => Promise<AgentLaunched>>()
    .mockResolvedValue({ id: "one", attention: "hooks" });
  const guard = vi.fn();
  await reattachRemoteSession(entry, hosts, { create }, launch, { parentId: "parent" }, guard);
  const request = launch.mock.calls[0]?.[0];
  expect(request).toMatchObject({
    reattach: true,
    terminalId: "one",
    control: { parentId: "parent" },
    remoteCheckout: { worktree: checkout.path },
    conversationId: "conversation",
  });
  expect(create).not.toHaveBeenCalled();
  request?.beforeSpawn?.();
  expect(guard).toHaveBeenCalledOnce();
  await request?.remoteCheckout?.validate();
  guard.mockImplementationOnce(() => {
    throw new Error("revoked");
  });
  expect(() => request?.beforeSpawn?.()).toThrow("revoked");
});
test("missing parents reconnect only as human terminals and missing placement fails closed", async () => {
  const create = vi.fn<(spec: TerminalSpec) => Promise<string>>().mockResolvedValue("one");
  const launch = vi.fn<(request: AgentLaunch) => Promise<AgentLaunched>>();
  expect(await reattachRemoteSession(entry, hosts, { create }, launch)).toMatchObject({
    id: "one",
    attention: "evaluator",
  });
  expect(create).toHaveBeenCalledOnce();
  expect(create.mock.calls[0]?.[0].remote).toMatchObject({
    host: "worker",
    reattach: true,
    human: true,
  });
  expect(launch).not.toHaveBeenCalled();
  const withoutConversation = { ...entry };
  delete withoutConversation.conversationId;
  await reattachRemoteSession(
    withoutConversation,
    { registered: hosts.registered },
    { create },
    launch,
    { parentId: "parent" },
  );
  await expect(
    reattachRemoteSession({ ...entry, placement: { kind: "local" } }, hosts, { create }, launch),
  ).rejects.toThrow("placement");
  create.mockRejectedValueOnce(new Error("gone"));
  await expect(reattachRemoteSession(entry, hosts, { create }, launch)).rejects.toThrow("gone");
});

test("exits observed while the hub was away retain their real code, with no blank restored tile", async () => {
  const create = vi.fn<(spec: TerminalSpec) => Promise<string>>().mockImplementation((spec) => {
    spec.remote?.unavailable?.(7);
    return Promise.reject(new Error("create refused"));
  });
  const launch = vi
    .fn<(request: AgentLaunch) => Promise<AgentLaunched>>()
    .mockImplementation((request) => {
      request.remoteCheckout?.target.unavailable?.(3);
      return Promise.reject(new Error("reconnect refused"));
    });
  await expect(reattachRemoteSession(entry, hosts, { create }, launch)).rejects.toMatchObject({
    code: 7,
  });
  await expect(
    reattachRemoteSession(entry, hosts, { create }, launch, { parentId: "parent" }),
  ).rejects.toMatchObject({ code: 3 });
});

test("reattachment rechecks registration even without a conversation ID or optional parent guard", async () => {
  const withoutConversation = { ...entry };
  delete withoutConversation.conversationId;
  const create = vi.fn<(spec: TerminalSpec) => Promise<string>>();
  const launch = vi
    .fn<(request: AgentLaunch) => Promise<AgentLaunched>>()
    .mockResolvedValue({ id: entry.id, attention: "hooks" });
  await reattachRemoteSession(withoutConversation, hosts, { create }, launch, {
    parentId: "parent",
  });
  const request = launch.mock.calls[0]?.[0];
  expect(request).not.toHaveProperty("conversationId");
  request?.beforeSpawn?.();
  hosts.registered.mockImplementationOnce(() => {
    throw new Error("registration removed");
  });
  expect(() => request?.beforeSpawn?.()).toThrow("registration removed");
  launch.mockRejectedValueOnce(new Error("connection unavailable"));
  await expect(
    reattachRemoteSession(entry, hosts, { create }, launch, { parentId: "parent" }),
  ).rejects.toThrow("connection unavailable");
  expect(create).not.toHaveBeenCalled();
});
