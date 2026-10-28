import {
  agentFixture,
  launchIdentity,
  listWorktrees,
  prepare,
  request as localRequest,
  tree,
} from "./agents-fixture";
import { execFile } from "node:child_process";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AgentService } from "../../../../src/main/agents/agents";
import type { TerminalSpec } from "../../../../src/shared/desktop";
import type { RemoteAgentBinding } from "../../../../src/shared/remote-agent";
const request = { ...localRequest, beforeSpawn: () => {} };
const argv = [...process.argv];
beforeEach(() =>
  process.argv.push(
    "--remote-agent-spike=fixture",
    `--remote-agent-artifact=${request.repository}/host`,
    `--remote-agent-local-checkout=${tree}`,
    "--remote-agent-repository=/remote/repo",
    "--remote-agent-worktree=/remote/tree",
  ),
);
afterEach(() => {
  agentFixture.service.dispose();
  process.argv.splice(0, process.argv.length, ...argv);
});
function fixture() {
  const dispose = vi.fn();
  const bind = vi.fn();
  const remoteCall = vi.fn(() =>
    Promise.resolve({ type: "error" as const, error: "no_parent" as const }),
  );
  const control = vi.fn(() =>
    Promise.resolve({ env: { FOOM_CONTROL_TOKEN: "hub-only-token" }, bind, dispose, remoteCall }),
  );
  let target: RemoteAgentBinding | undefined;
  const create = vi.fn(async (spec: TerminalSpec) => {
    target = spec.remote?.agent;
    await target?.authorize();
    target?.start();
    target?.ready({ hooks: false, mcp: true, channels: [], conversationId: "conversation" });
    return spec.id ?? "missing";
  });
  const service = new AgentService({ listWorktrees, launchIdentity }, { create }, prepare, control);
  agentFixture.service = service;
  return { create, service, control, bind, dispose, target: () => target };
}
test("remote owned children bypass local discovery and hook preparation, retain local checkout validation and revoke on release", async () => {
  const f = fixture();
  const launched = await f.service.launch({
    ...request,
    terminalId: "remote-id",
    control: { parentId: "parent-id" },
    prompt: "Task",
  });
  expect(launched).toMatchObject({ id: "remote-id", remote: true, conversationId: "conversation" });
  expect(execFile).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  expect(f.create.mock.calls[0]?.[0].remote?.agent?.spec).toEqual({
    agent: "claude",
    repository: "/remote/repo",
    worktree: "/remote/tree",
    defaults: [],
    hooks: true,
    prompt: "Task",
  });
  expect(f.bind).toHaveBeenCalledWith("remote-id", true);
  expect(launchIdentity).toHaveBeenCalledTimes(3);
  f.service.release("remote-id");
  expect(f.dispose).toHaveBeenCalledOnce();
  expect(await f.target()?.call("whoami", {})).toEqual({ type: "error", error: "unavailable" });
});
test("remote mapping rejects ordinary sessions, unavailable control and checkout changes without falling back to local", async () => {
  const f = fixture();
  await expect(f.service.launch(request)).rejects.toThrow("owned child");
  await expect(
    f.service.launch({
      ...request,
      control: { parentId: "parent-id" },
      defaultArguments: ["--dangerously-skip-permissions"],
    }),
  ).rejects.toThrow("bypass");
  const unavailable = new AgentService({ listWorktrees, launchIdentity }, { create: f.create });
  await expect(
    unavailable.launch({ ...request, control: { parentId: "parent-id" } }),
  ).rejects.toThrow("unavailable");
  launchIdentity.mockResolvedValueOnce("initial").mockResolvedValueOnce("different");
  await expect(
    f.service.launch({ ...request, control: { parentId: "parent-id" } }),
  ).rejects.toThrow("changed");
  expect(f.dispose).toHaveBeenCalled();
  expect(f.create).not.toHaveBeenCalled();
  expect(execFile).not.toHaveBeenCalled();
});
test("early exit and preparation failure release remote launch resources and leave the worktree usable", async () => {
  const f = fixture();
  f.create.mockImplementationOnce(async (spec) => {
    const target = spec.remote?.agent;
    await target?.authorize();
    target?.start();
    target?.ready({ hooks: false, mcp: false });
    f.service.release(spec.id ?? "early");
    return spec.id ?? "early";
  });
  await f.service.launch({ ...request, terminalId: "early", control: { parentId: "parent-id" } });
  expect(f.dispose).toHaveBeenCalledOnce();
  f.create.mockRejectedValueOnce(new Error("remote creation failed"));
  await expect(
    f.service.launch({ ...request, control: { parentId: "parent-id" } }),
  ).rejects.toThrow("failed");
  const next = await f.service.launch({ ...request, control: { parentId: "parent-id" } });
  f.service.release(next.id);
});

test("remote review loops return a fixed refusal before control, discovery or remote preparation", async () => {
  const f = fixture();
  await expect(
    f.service.launch({
      ...request,
      control: { parentId: "parent-id" },
      loop: { rounds: 1, agent: "codex", postFindings: false },
    }),
  ).rejects.toMatchObject({ code: "remote_review_unsupported" });
  expect(f.control).not.toHaveBeenCalled();
  expect(f.create).not.toHaveBeenCalled();
  expect(execFile).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
});

test("remote launches require a captured final authority guard before allocating control credentials", async () => {
  const f = fixture();
  await expect(
    f.service.launch({ ...localRequest, control: { parentId: "parent-id" } }),
  ).rejects.toThrow("parent authority");
  expect(f.control).not.toHaveBeenCalled();
  expect(f.create).not.toHaveBeenCalled();
});

test("remote selections replace manifest defaults and retain effective local launch metadata", async () => {
  const f = fixture();
  const defaults = ["--model", "old", "--system-prompt", "--model=literal", "--effort", "low"];
  const launched = await f.service.launch({
    ...request,
    control: { parentId: "parent-id" },
    selection: { model: "opus", effort: "high" },
    defaultArguments: defaults,
  });
  const selected = ["--system-prompt", "--model=literal", "--model", "opus", "--effort", "high"];
  expect(f.create.mock.calls[0]?.[0].remote?.agent?.spec.defaults).toEqual(selected);
  expect(launched.launchFlags).toEqual(selected);
  expect(defaults).toEqual([
    "--model",
    "old",
    "--system-prompt",
    "--model=literal",
    "--effort",
    "low",
  ]);
  expect(execFile).not.toHaveBeenCalled();
  f.service.release(launched.id);
});

test.each(["pi", "opencode"])(
  "remote %s attachments refuse before allocating credentials or discovery",
  async (agent) => {
    const f = fixture();
    await expect(
      f.service.launch({ ...request, agent, control: { parentId: "parent-id" } }),
    ).rejects.toThrow("remote_agent_unsupported");
    expect(f.control).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  },
);

test("a saved local launch remains local despite a new matching remote mapping", async () => {
  const f = fixture();
  const result = await f.service.launch({ ...request, localOnly: true });
  expect(result.remote).toBeUndefined();
  expect(f.create.mock.calls.at(-1)?.[0].remote).toBeUndefined();
  expect(execFile).toHaveBeenCalled();
});
