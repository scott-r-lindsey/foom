import { afterEach, expect, test, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launchRemoteChild } from "../../../../src/main/agents/remote-launch";
import type { RemoteHooks } from "../../../../src/main/agents/remote-launch";
import type { TerminalSpec } from "../../../../src/shared/desktop";
import type { RemoteAgentBinding } from "../../../../src/shared/remote-agent";
import type { ControlLaunch } from "../../../../src/main/control/types";
import {
  replaceConfigProviders,
  agentProvider,
} from "../../../../src/main/agents/providers/registry";

const root = join(tmpdir(), "repo");
const mapping = {
  target: { host: "fixture-host", artifact: join(tmpdir(), "foom-host") },
  repository: "/remote/repo",
  worktree: "/remote/worktree",
};
const request = {
  agent: "claude",
  beforeSpawn: () => {},
  repository: root,
  worktree: join(root, "wt"),
  cols: 80,
  rows: 24,
  control: { parentId: "parent-secret-terminal" },
  prompt: "Task",
  terminalId: "child-secret-terminal",
};
afterEach(() => {
  replaceConfigProviders([]);
});
function fixture(hooks = true) {
  const control: ControlLaunch = {
    env: { FOOM_CONTROL_TOKEN: "hub-control-token" },
    bind: vi.fn(),
    dispose: vi.fn(),
    remoteCall: vi.fn(() =>
      Promise.resolve({ type: "error" as const, error: "no_parent" as const }),
    ),
  };
  const observer: RemoteHooks = { bind: vi.fn(), signal: vi.fn(), revoke: vi.fn() };
  let remote: RemoteAgentBinding | undefined;
  const create = vi.fn(async (spec: TerminalSpec) => {
    remote = spec.remote?.agent;
    await remote?.authorize();
    remote?.start();
    remote?.ready({
      hooks,
      mcp: true,
      channels: hooks ? ["lifecycle"] : [],
      conversationId: "conversation",
    });
    return spec.id ?? "unknown";
  });
  const validate = vi.fn(() => Promise.resolve());
  return {
    control,
    observer,
    create,
    validate,
    remote: () => {
      if (!remote) throw new Error("Missing binding");
      return remote;
    },
  };
}
test("remote launch keeps hub identity and credentials out of process data and binds reduced hooks to a separate key", async () => {
  const f = fixture();
  const launched = await launchRemoteChild(
    request,
    mapping,
    [],
    true,
    { create: f.create },
    f.control,
    f.validate,
    f.observer,
  );
  expect(launched.result).toMatchObject({
    id: request.terminalId,
    remote: true,
    placement: { kind: "remote", host: "fixture-host" },
    conversationId: "conversation",
    attention: "hooks",
  });
  const binding = f.remote();
  const processData = JSON.stringify(binding.spec);
  for (const value of [request.terminalId, request.control.parentId, "hub-control-token"])
    expect(processData).not.toContain(value);
  expect(f.control.bind).toHaveBeenCalledWith(request.terminalId, true);
  expect(f.observer.bind).toHaveBeenCalledWith(
    expect.any(String),
    request.terminalId,
    expect.anything(),
  );
  const signal = {
    terminalId: request.terminalId,
    action: "working" as const,
    signal: "plugin:claude:UserPromptSubmit" as const,
    conversationId: "conversation",
    endsTurn: false,
    recoverTurn: false,
    channel: "lifecycle",
    caseId: "UserPromptSubmit",
  };
  await binding.hook(signal);
  expect(vi.mocked(f.observer.signal).mock.calls[0]?.[0].terminalId).not.toBe(request.terminalId);
  expect(vi.mocked(f.observer.signal).mock.calls[0]?.[0].action).toBe("working");
  expect(await binding.call("handoff", { status: "done" })).toEqual({
    type: "error",
    error: "no_parent",
  });
  expect(f.control.remoteCall).toHaveBeenCalledWith("handoff", { status: "done" });
  expect(() => {
    void binding.hook({ ...signal, conversationId: "foreign" });
  }).toThrow("Invalid");
  expect(() => {
    void binding.hook({ ...signal, action: "failed" });
  }).toThrow("Invalid");
  expect(() => {
    binding.ready({ hooks: true, mcp: true, conversationId: "foreign" });
  }).toThrow("changed");
  expect(() => {
    binding.ready({ hooks: true, mcp: true, channels: ["unknown"] });
  }).toThrow("Foreign");
  launched.dispose();
  launched.dispose();
  const calls = vi.mocked(f.observer.signal).mock.calls.length;
  await binding.hook(signal);
  binding.ready({ hooks: true, mcp: true });
  expect(vi.mocked(f.observer.signal).mock.calls).toHaveLength(calls);
  expect(await binding.call("whoami", {})).toEqual({ type: "error", error: "unavailable" });
});
test("launch failures and unsupported authority revoke immediately without local fallback", async () => {
  const f = fixture(false);
  const beforeSpawn = vi.fn();
  const launched = await launchRemoteChild(
    { ...request, beforeSpawn },
    mapping,
    [],
    false,
    { create: f.create },
    f.control,
    f.validate,
    f.observer,
  );
  expect(launched.result.attention).toBe("evaluator");
  expect(beforeSpawn).toHaveBeenCalledOnce();
  expect(f.observer.bind).not.toHaveBeenCalled();
  launched.dispose();
  for (const bad of [
    { ...request, prompt: request.control.parentId },
    { ...request, prompt: request.terminalId },
  ])
    await expect(
      launchRemoteChild(bad, mapping, [], true, { create: f.create }, f.control, f.validate),
    ).rejects.toThrow("identity");
  const parentless = {
    agent: request.agent,
    repository: request.repository,
    worktree: request.worktree,
    cols: 80,
    rows: 24,
  };
  await expect(
    launchRemoteChild(parentless, mapping, [], true, { create: f.create }, f.control, f.validate),
  ).rejects.toThrow("owned child");
  await expect(
    launchRemoteChild(
      { ...request, control: { role: "orchestrator" } },
      mapping,
      [],
      true,
      { create: f.create },
      f.control,
      f.validate,
    ),
  ).rejects.toThrow("owned child");
  await expect(
    launchRemoteChild(request, mapping, [], true, { create: () => "wrong" }, f.control, f.validate),
  ).rejects.toThrow("acknowledged");
  await expect(
    launchRemoteChild(
      request,
      mapping,
      [],
      true,
      {
        create: () => {
          throw new Error("spawn");
        },
      },
      f.control,
      f.validate,
    ),
  ).rejects.toThrow("spawn");
  const provider = agentProvider("claude");
  replaceConfigProviders([
    { ...provider, origin: "config", id: "fixture", model: { ...provider.model, id: "fixture" } },
  ]);
  await expect(
    launchRemoteChild(
      { ...request, agent: "fixture" },
      mapping,
      [],
      true,
      { create: f.create },
      f.control,
      f.validate,
    ),
  ).rejects.toThrow("bundled");
});
test("early hooks are buffered until binding, and delayed delivery is revoked with the launch", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const create = async (spec: TerminalSpec) => {
    const binding = spec.remote?.agent;
    if (!binding) throw new Error("No binding");
    await binding.authorize();
    binding.start();
    binding.ready({ hooks: true, mcp: false, channels: ["lifecycle"] });
    expect(await binding.call("whoami", {})).toEqual({ type: "error", error: "unavailable" });
    await binding.hook({
      terminalId: request.terminalId,
      action: "working",
      signal: "plugin:claude:UserPromptSubmit",
      conversationId: "conversation",
      endsTurn: false,
      recoverTurn: false,
      channel: "lifecycle",
      caseId: "UserPromptSubmit",
    });
    return spec.id ?? "unknown";
  };
  try {
    const launched = await launchRemoteChild(
      request,
      mapping,
      [],
      true,
      { create },
      f.control,
      f.validate,
      f.observer,
    );
    expect(f.observer.signal).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(f.observer.signal).toHaveBeenCalledOnce();
    launched.dispose();
  } finally {
    vi.useRealTimers();
  }
});

test("remote lifecycle health remains invocation-local and cannot update hub/local observer stores", async () => {
  const f = fixture();
  const launched = await launchRemoteChild(
    { ...request, agent: "codex" },
    mapping,
    [],
    true,
    { create: f.create },
    f.control,
    f.validate,
    f.observer,
  );
  const runtime = vi.mocked(f.observer.bind).mock.calls[0]?.[2];
  if (!runtime) throw new Error("Missing hook runtime");
  expect(runtime.health.get()).toBe("not-reviewed");
  for (const [caseId, action, endsTurn] of [
    ["SessionStart", "ready", false],
    ["UserPromptSubmit", "working", false],
    ["Stop", "classify", true],
  ] as const)
    runtime.accept(
      {
        terminalId: "local-only",
        signal: `plugin:codex:${caseId}`,
        channel: "lifecycle",
        caseId,
        action,
        endsTurn,
      },
      1,
    );
  expect(runtime.health.get()).toBe("trusted");
  await runtime.health.flush();
  launched.dispose();
});

test("remote binding cannot start before preparation or without captured parent authority", async () => {
  const f = fixture(false);
  const unguarded = {
    agent: request.agent,
    repository: request.repository,
    worktree: request.worktree,
    cols: 80,
    rows: 24,
    control: request.control,
  };
  await expect(
    launchRemoteChild(unguarded, mapping, [], false, { create: f.create }, f.control, f.validate),
  ).rejects.toThrow("parent authority");
  f.create.mockImplementationOnce(async (spec) => {
    const binding = spec.remote?.agent;
    if (!binding) throw new Error("Missing binding");
    expect(() => {
      binding.start();
    }).toThrow("unavailable");
    await binding.authorize();
    binding.start();
    expect(() => {
      binding.start();
    }).toThrow("unavailable");
    binding.ready({ hooks: false, mcp: false });
    return spec.id ?? "missing";
  });
  const launched = await launchRemoteChild(
    request,
    mapping,
    [],
    false,
    { create: f.create },
    f.control,
    f.validate,
  );
  launched.dispose();
});
