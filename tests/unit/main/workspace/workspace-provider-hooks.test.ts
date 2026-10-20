import { expect, test } from "vitest";
import { installedHealth } from "../../../../src/main/agents/providers/installed-observers";
import {
  agentProvider,
  replaceConfigProviders,
} from "../../../../src/main/agents/providers/registry";
import { Workspace } from "../../../../src/main/workspace/workspace";
import type { HookSignal } from "../../../../src/shared/hooks";
import {
  agents,
  classify,
  codexSignal,
  codexWorkspace,
  deps,
  evaluated,
  launched,
  prepare,
  receiver,
  repo,
  scan,
  states,
  tails,
  tree,
} from "./workspace-fixture";

test("Codex observations drive execution and preserve the user's notifier only after a confirmed turn", async () => {
  const { workspace, hooks, key } = await codexWorkspace();
  try {
    expect(hooks.v2?.runtime?.health.get()).toBe("not-reviewed");
    const report = () => workspace.scanAgents(false);
    expect((await report()).agents[0]?.hookState).toBe("not-reviewed");
    tails.set("t1", ["All done."]);
    const send = (signal: HookSignal["signal"], action: HookSignal["action"]) =>
      workspace.hook(codexSignal(signal, action, key));
    await send("codex:SessionStart", "ready");
    expect(workspace.snapshot().terminals[0]?.execution?.phase).toBe("starting");
    await send("codex:UserPromptSubmit", "working");
    await send("codex:PreToolUse", "working");
    expect(workspace.snapshot().terminals[0]?.execution?.phase).toBe("working");
    await send("codex:PermissionRequest", "needs_input");
    expect(states.at(-1)?.state).toBe("needs_input");
    await workspace.evidence("t1", { title: "⠋ Working", progress: null });
    expect(workspace.snapshot().terminals[0]?.execution?.phase).toBe("blocked");
    await send("codex:PostToolUse", "working");
    expect(workspace.snapshot().terminals[0]?.execution?.phase).toBe("working");
    await workspace.evidence("t1", { title: "Ready", progress: null });
    expect(states.at(-1)?.state).toBe("quiet_ok"); // Esc-like idle without Stop.
    await send("codex:Stop", "classify");
    expect(states.at(-1)?.state).toBe("done");
    expect((await report()).agents[0]?.hookState).toBe("trusted");
    const count = classify.mock.calls.length;
    await send("codex:agent-turn-complete", "classify");
    expect(classify).toHaveBeenCalledTimes(count);
    const later = await prepare?.("codex");
    expect(later?.v2?.runtime?.health.get()).toBe("trusted");
    expect(later?.v2?.values["observerCommand:lifecycle"]).toBe(
      hooks.v2?.values["observerCommand:lifecycle"],
    );
    later?.dispose();
  } finally {
    hooks.dispose();
    await workspace.dispose();
  }
});

test("Codex review and absent hooks retain the notifier and explain the fallback", async () => {
  const { workspace, hooks, key } = await codexWorkspace();
  try {
    tails.set("t1", ["Hooks need review"]);
    await workspace.quiet("t1");
    expect((await workspace.scanAgents(false)).agents[0]?.hookState).toBe("not-reviewed");
    tails.set("t1", ["All done."]);
    await workspace.evidence("t1", { title: "⠋ Working", progress: null });
    await workspace.hook(codexSignal("codex:agent-turn-complete", "classify", key));
    expect((await workspace.scanAgents(false)).agents[0]?.hookState).toBe("declined");
    expect(states.at(-1)?.state).toBe("done");
    const next = await prepare?.("codex");
    expect(next?.v2?.runtime?.health.get()).not.toBe("trusted");
    next?.dispose();
    // One isolated Stop cannot establish working lifecycle hooks.
    await workspace.hook(codexSignal("codex:Stop", "classify", key));
    expect((await workspace.scanAgents(false)).agents[0]?.hookState).toBe("declined");
  } finally {
    hooks.dispose();
    await workspace.dispose();
  }
});

test.each([true, false])(
  "previously trusted Codex hooks fall back when review is %s",
  async (review) => {
    const model = agentProvider("codex").model;

    const health = await installedHealth(model, deps.agentPluginDirectory);
    health.set("trusted");
    const { workspace, hooks } = await codexWorkspace();
    try {
      expect(hooks.v2?.runtime?.health.get()).toBe("trusted");
      if (review) {
        tails.set("t1", ["Hooks need review"]);
        await workspace.quiet("t1");
        await workspace.quiet("t1");
        expect(health.get()).toBe("outdated");
      } else {
        tails.set("t1", ["Complete."]);
        await workspace.evidence("t1", { title: "⠋ Working", progress: null });
        await workspace.evidence("t1", { title: "Ready", progress: null });
        expect(health.get()).toBe("declined");
      }
      const next = await prepare?.("codex");
      expect(next?.v2?.runtime?.health.get()).not.toBe("trusted");
      next?.dispose();
    } finally {
      hooks.dispose();
      await workspace.dispose();
    }
  },
);

test.each(["notify", "idle-then-notify", "idle-only"])(
  "Codex restores fallback after a verified turn when later callbacks disappear: %s",
  async (completion) => {
    const { workspace, hooks, key } = await codexWorkspace();
    const send = (signal: HookSignal["signal"], action: HookSignal["action"]) =>
      workspace.hook(codexSignal(signal, action, key));
    try {
      tails.set("t1", ["Complete."]);
      await send("codex:SessionStart", "ready");
      await send("codex:UserPromptSubmit", "working");
      await send("codex:Stop", "classify");
      expect((await workspace.scanAgents(false)).agents[0]?.hookState).toBe("trusted");
      const count = classify.mock.calls.length;
      await send("codex:agent-turn-complete", "classify");
      expect(classify).toHaveBeenCalledTimes(count);

      await workspace.evidence("t1", { title: "⠋ Working", progress: null });
      expect(workspace.snapshot().terminals[0]?.execution?.turn).toBe(2);
      if (completion !== "notify") {
        await workspace.evidence("t1", { title: "Ready", progress: null });
        expect(states.at(-1)?.state).toBe("quiet_ok");
      }
      if (completion !== "idle-only") {
        await send("codex:agent-turn-complete", "classify");
        expect(states.at(-1)?.state).toBe("done");
      }
      expect((await workspace.scanAgents(false)).agents[0]?.hookState).toBe("declined");
      const next = await prepare?.("codex");
      expect(next?.v2?.runtime?.health.get()).not.toBe("trusted");
      next?.dispose();
    } finally {
      hooks.dispose();
      await workspace.dispose();
    }
  },
);

test("Antigravity completion and failure evidence survives quiet output, clears on progress and is revoked on disposal", async () => {
  agents.scan.mockResolvedValue({
    ...scan,
    agents: [{ id: "agy", path: "/bin/agy", version: "1.3.1", hooks: true, reason: "installed" }],
  });
  const workspace = new Workspace(deps);
  await workspace.launch({
    agent: "agy",
    repository: repo.path,
    worktree: tree.path,
    cols: 80,
    rows: 24,
  });
  const hooks = await prepare?.("agy");
  hooks?.bind?.("t1");
  const key = receiver.register.mock.calls.at(-1)?.[0];
  if (!key) throw new Error("No hook key");
  tails.set("t1", ["plain text"]);
  await workspace.hook({ terminalId: key, action: "working", signal: "agy:PreInvocation" });
  await workspace.hook({
    terminalId: key,
    action: "classify",
    signal: "agy:Stop",
    terminationReason: "model_stop",
    fullyIdle: true,
  });
  expect(states.at(-1)?.state).toBe("done");
  await workspace.hook({ terminalId: key, action: "working", signal: "agy:PostToolUse" });
  await workspace.hook({
    terminalId: key,
    action: "failed",
    signal: "agy:Stop",
    terminationReason: "error",
    fullyIdle: false,
  });
  expect(states.at(-1)?.state).toBe("failed");
  await workspace.quiet("t1");
  expect(states.at(-1)?.state).toBe("failed");
  await workspace.hook({ terminalId: key, action: "working", signal: "agy:PreInvocation" });
  await workspace.quiet("t1");
  expect(states.at(-1)?.state).toBe("working");
  hooks?.dispose();
  const count = states.length;
  await workspace.hook({ terminalId: key, action: "failed", signal: "agy:Stop" });
  expect(states).toHaveLength(count);
  await workspace.dispose();
});

test("fully idle Antigravity Stop recovers a turn whose working report was overtaken", async () => {
  agents.scan.mockResolvedValue({
    ...scan,
    agents: [{ id: "agy", path: "/bin/agy", version: "1.3.1", hooks: true, reason: "installed" }],
  });
  const workspace = new Workspace(deps);
  await workspace.launch({
    agent: "agy",
    repository: repo.path,
    worktree: tree.path,
    cols: 80,
    rows: 24,
  });
  const hooks = await prepare?.("agy");
  hooks?.bind?.("t1");
  const key = receiver.register.mock.calls.at(-1)?.[0];
  if (!key) throw new Error("No key");
  const stop = {
    terminalId: key,
    action: "classify",
    signal: "agy:Stop",
    terminationReason: "model_stop",
    fullyIdle: true,
  } as const;
  try {
    tails.set("t1", ["plain answer"]);
    await workspace.hook(stop);
    expect(states.at(-1)?.state).toBe("done");
    expect(workspace.snapshot().terminals[0]?.execution).toMatchObject({ phase: "idle", turn: 1 });
    await workspace.hook(stop);
    expect(workspace.snapshot().terminals[0]?.execution).toMatchObject({ phase: "idle", turn: 2 });
    tails.set("t1", ["Continue? (y/n)"]);
    await workspace.hook(stop);
    expect(states.at(-1)?.state).toBe("needs_input");
  } finally {
    hooks?.dispose();
    await workspace.dispose();
  }
});

test("v2 workspace treats startup as metadata, suppresses duplicate completion and recovers an overtaken turn", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { parseAgentManifest } = await import("../../../../src/shared/agent-plugin-parser");
  const { v2Provider } = await import("../../../../src/main/agents/providers/v2");
  const fixture = await import("../../../fixtures/agent-plugins-v2/codex.json");
  const model = parseAgentManifest(
    JSON.stringify({ ...fixture.default, id: "fixture-workspace", setup: undefined }),
  ).model;
  const provider = v2Provider(model, () => Promise.resolve());
  replaceConfigProviders([provider]);
  const profile = await mkdtemp(path.join(tmpdir(), "v2-workspace-"));
  deps.agentPluginDirectory = profile;
  const workspace = await launched(model.id);
  const hooks = await prepare?.(model.id);
  if (!hooks?.v2) throw Error("Missing hooks");
  const installation = provider.discover("/fixture", "codex-cli 0.161.0", "-c");
  const prepared = await provider.prepareLaunch(
    installation,
    { agent: model.id, repository: repo.path, worktree: tree.path, cols: 80, rows: 24 },
    [],
    undefined,
    false,
    true,
    hooks,
  );
  try {
    hooks.bind?.("t1");
    const key = receiver.register.mock.calls.at(-1)?.[0];
    if (!key) throw Error("Missing key");
    const signal = (
      caseId: string,
      action: HookSignal["action"],
      channel = "lifecycle",
      recoverTurn = false,
    ) =>
      workspace.hook({
        terminalId: key,
        signal: `plugin:${model.id}:${caseId}`,
        caseId,
        channel,
        action,
        endsTurn: action === "classify",
        recoverTurn,
        ...(recoverTurn ? { terminationReason: "model_stop", fullyIdle: true } : {}),
      });
    await signal("SessionStart", "ready");
    expect(workspace.snapshot().terminals[0]?.execution?.phase).toBe("starting");
    await signal("UserPromptSubmit", "working");
    expect(workspace.snapshot().terminals[0]?.execution?.turn).toBe(1);
    tails.set("t1", []);
    await signal("Stop", "classify");
    expect(hooks.v2.runtime?.health.get()).toBe("trusted");
    const count = evaluated.length;
    await signal("agent-turn-complete", "classify", "notify");
    expect(evaluated).toHaveLength(count);
    await signal("Stop", "classify", "lifecycle", true);
    expect(workspace.snapshot().terminals[0]?.execution?.turn).toBe(2);
    expect(hooks.v2.runtime?.health.get()).toBe("declined");
    await signal("UserPromptSubmit", "working");
    await workspace.hook({
      terminalId: key,
      signal: `plugin:${model.id}:background-error`,
      action: "failed",
      endsTurn: false,
    });
    expect(workspace.snapshot().terminals[0]?.execution?.phase).toBe("working");
    await workspace.evidence("t1", { title: "codex", progress: null });
    await workspace.quiet("t1");
    const { V2ExecutionHooks } = await import("../../../../src/main/agents/providers/v2-health");
    if (!(hooks.v2.runtime instanceof V2ExecutionHooks)) throw Error("Missing runtime");
    hooks.v2.runtime = new V2ExecutionHooks(
      {
        ...structuredClone(model),
        health: undefined,
        execution: { ...model.execution, completion: "attached" },
      },
      hooks.v2.channels,
      hooks.v2.runtime.health,
    );
    hooks.bind?.("t1");
    await signal("UserPromptSubmit", "working");
    await signal("SessionStart", "ready");
    await signal("SessionStart", "ready");
    await workspace.quiet("t1");
    expect(workspace.snapshot().terminals[0]?.state?.state).not.toBe("done");
    await signal("UserPromptSubmit", "working");
    await signal("PermissionRequest", "needs_input");
    await signal("SessionStart", "ready");
    expect(workspace.snapshot().terminals[0]?.execution?.phase).toBe("blocked");
    workspace.removed("t1");
  } finally {
    prepared.dispose();
    await workspace.dispose();
    await rm(profile, { recursive: true, force: true });
  }
});
