import {
  cleanup,
  create,
  launchIdentity,
  listWorktrees,
  prepare,
  request,
  agentFixture,
  versions,
} from "./agents-fixture";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { AgentService } from "../../../../src/main/agents/agents";
import { AgyPlugin } from "../../../../src/main/agents/agy-plugin";
import { bundledProvider } from "../../../../src/main/agents/providers/bundled";
import type { AgentProvider } from "../../../../src/main/agents/providers/provider";
import { replaceConfigProviders } from "../../../../src/main/agents/providers/registry";
import codexManifest from "../../../../src/shared/bundled-agents/codex.json";
import { hostRequest } from "../../../../src/shared/terminal-host-protocol";

it("v2 checks final environment bypass on every launch, redacts values, and rejects unattended bypass", async () => {
  const { parseAgentManifest } = await import("../../../../src/shared/agent-plugin-parser");
  const { v2Provider } = await import("../../../../src/main/agents/providers/v2");
  const fixture = await import("../../../fixtures/agent-plugin-v2.json");
  const parsed = parseAgentManifest(
    JSON.stringify({
      ...fixture.default,
      files: [],
      launch: { ...fixture.default.launch, mcp: undefined, toolPermissions: undefined },
    }),
  );
  const validate = vi.fn(() => Promise.resolve());
  replaceConfigProviders([v2Provider(parsed.model, validate)]);
  versions[parsed.model.id] = "fixture 1.2.3";
  agentFixture.help = "--inline --prompt --mcp";
  vi.stubEnv("FIXTURE_BYPASS", "private-bypass-value");
  vi.stubEnv("ProgramFiles(x86)", "C:\\Program Files (x86)");
  const approve = vi.fn(() => Promise.resolve(false));
  const revoke = vi.fn();
  const grant = vi.fn(() => Promise.resolve({ env: {}, bind: vi.fn(), dispose: revoke }));
  agentFixture.service = new AgentService(
    { listWorktrees, launchIdentity },
    { create },
    prepare,
    grant,
    new AgyPlugin(),
    approve,
  );
  const v2Request = { ...request, agent: parsed.model.id };
  const scan = await agentFixture.service.scan();
  expect(scan.agents.find((agent) => agent.id === parsed.model.id)).toMatchObject({
    resume: true,
    restoreControl: false,
    source: "agents/fixture-v2.json",
    resumePaste: [{ command: "fixture-v2", selector: "--resume" }],
  });
  await expect(agentFixture.service.launch(v2Request)).rejects.toThrow("cancelled");
  expect(create).not.toHaveBeenCalled();
  expect(revoke).toHaveBeenCalledOnce();
  expect(JSON.stringify(approve.mock.calls)).toContain("FIXTURE_BYPASS: present-nonempty");
  expect(JSON.stringify(approve.mock.calls)).not.toContain("private-bypass-value");
  approve.mockResolvedValue(true);
  const result = await agentFixture.service.launch(v2Request);
  expect(result).toMatchObject({
    bypass: true,
    providerOrigin: "config",
  });
  const spec = create.mock.calls.at(-1)?.[0];
  expect(spec?.env).not.toHaveProperty("ProgramFiles(x86)");
  expect(hostRequest({ type: "create", request: 1, id: "terminal-id", spec })).toBe(true);
  expect(result.conversationId).toMatch(/^[a-f0-9-]{36}$/u);
  expect(create.mock.calls.at(-1)?.[0].env?.["FIXTURE_BYPASS"]).toBe("private-bypass-value");
  agentFixture.service.release(result.id);
  await agentFixture.service.launch(v2Request);
  expect(approve).toHaveBeenCalledTimes(3);
  agentFixture.service.release(result.id);
  await expect(
    agentFixture.service.launch({ ...v2Request, control: { parentId: "parent" }, prompt: "task" }),
  ).rejects.toThrow("Unattended child");
  expect(approve).toHaveBeenCalledTimes(3);
  vi.stubEnv("FIXTURE_BYPASS", "");
  await expect(
    agentFixture.service.launch({ ...v2Request, defaultArguments: ["--resume=abc"] }),
  ).rejects.toThrow("reserved");
  await expect(
    agentFixture.service.launch({
      ...v2Request,
      defaultArguments: ["--yolo"],
      control: { parentId: "parent" },
    }),
  ).rejects.toThrow("Unattended child");
  await expect(
    agentFixture.service.launch({
      ...v2Request,
      conversationId: "saved",
      control: { role: "orchestrator" },
    }),
  ).rejects.toThrow("without MCP");
  validate.mockRejectedValue(Error("Agent plugin changed"));
  await expect(agentFixture.service.launch(v2Request)).rejects.toThrow("changed");
});

it("v2 revokes launch on approval races, disposal and failed version/help probes", async () => {
  const { parseAgentManifest } = await import("../../../../src/shared/agent-plugin-parser");
  const { v2Provider } = await import("../../../../src/main/agents/providers/v2");
  const fixture = await import("../../../fixtures/agent-plugin-v2.json");
  const parsed = parseAgentManifest(
    JSON.stringify({
      ...fixture.default,
      files: [],
      launch: { ...fixture.default.launch, mcp: undefined, toolPermissions: undefined },
    }),
  );
  let changed = false;
  const validate = () =>
    changed ? Promise.reject(Error("Agent plugin changed")) : Promise.resolve();
  replaceConfigProviders([v2Provider(parsed.model, validate)]);
  versions[parsed.model.id] = "fixture 1.2.3";
  agentFixture.help = "--inline --prompt";
  const approve = vi.fn(() => {
    changed = true;
    return Promise.resolve(true);
  });
  agentFixture.service = new AgentService(
    { listWorktrees, launchIdentity },
    { create },
    undefined,
    undefined,
    new AgyPlugin(),
    approve,
  );
  await agentFixture.service.scan();
  const v2Request = { ...request, agent: parsed.model.id, defaultArguments: ["--yolo"] };
  await expect(agentFixture.service.launch(v2Request)).rejects.toThrow("changed");
  expect(create).not.toHaveBeenCalled();
  changed = false;
  approve.mockImplementation(() => {
    agentFixture.service.dispose();
    return Promise.resolve(true);
  });
  await expect(agentFixture.service.launch(v2Request)).rejects.toThrow("disposed");
  agentFixture.service = new AgentService({ listWorktrees, launchIdentity }, { create });
  agentFixture.failed = "--help";
  const scan = await agentFixture.service.scan();
  expect(scan.agents.find((agent) => agent.id === parsed.model.id)).toMatchObject({
    hooks: false,
    mcp: false,
    version: "fixture 1.2.3",
  });
  await expect(
    agentFixture.service.launch({ ...request, agent: parsed.model.id, prompt: "task" }),
  ).rejects.toThrow("cannot take");
});

it("v2 revokes control credentials before removing launch resources on release, early exit and spawn failure", async () => {
  const { parseAgentManifest } = await import("../../../../src/shared/agent-plugin-parser");
  const { v2Provider } = await import("../../../../src/main/agents/providers/v2");
  const fixture = await import("../../../fixtures/agent-plugin-v2.json");
  const parsed = parseAgentManifest(
    JSON.stringify({
      ...fixture.default,
      files: [],
      launch: { ...fixture.default.launch, mcp: undefined, toolPermissions: undefined },
    }),
  );
  const provider = v2Provider(parsed.model, () => Promise.resolve());
  let revoked = false;
  const dispose = vi.fn(() => {
    expect(revoked).toBe(true);
  });
  const guarded: AgentProvider = {
    ...provider,
    prepareLaunch: async (...args) => {
      const prepared = await provider.prepareLaunch(...args);

      return {
        ...prepared,
        dispose: () => {
          dispose();
          prepared.dispose();
        },
      };
    },
  };
  replaceConfigProviders([guarded]);
  versions[parsed.model.id] = "fixture 1.2.3";
  agentFixture.help = "--inline --prompt";
  const grant = () =>
    Promise.resolve({
      env: {},
      bind: () => undefined,
      dispose: () => {
        revoked = true;
      },
    });
  agentFixture.service = new AgentService(
    { listWorktrees, launchIdentity },
    { create },
    undefined,
    grant,
  );
  const v2Request = { ...request, agent: parsed.model.id };
  for (const mode of ["release", "early", "failure"]) {
    revoked = false;
    create.mockImplementation(() => {
      if (mode === "failure") throw Error("spawn failed");
      if (mode === "early") agentFixture.service.release("terminal-id");
      return "terminal-id";
    });
    if (mode === "failure")
      await expect(agentFixture.service.launch(v2Request)).rejects.toThrow("spawn failed");
    else {
      const result = await agentFixture.service.launch(v2Request);
      if (mode === "release") agentFixture.service.release(result.id);
    }
  }
  expect(dispose).toHaveBeenCalledTimes(3);
});

it("rejects context-selected bundled disclosures without a consent mechanism", async () => {
  const data = structuredClone(codexManifest);
  data.id = "codex-revised";
  const notify = data.hooks.channels.find((channel) => channel.id === "notify");
  if (!notify) throw new Error("Missing notify channel");
  Object.assign(notify, {
    disclosure: {
      id: "replacement",
      text: "Channel replacement disclosure",
      acknowledgement: "profile",
    },
  });
  notify.when.all.push({ field: "control", op: "eq", value: true });
  const digest = createHash("sha256").update(JSON.stringify(data)).digest("hex");
  replaceConfigProviders([bundledProvider(data, data.id, digest)]);
  const dispose = vi.fn();
  agentFixture.service = new AgentService(
    { listWorktrees, launchIdentity },
    { create },
    prepare,
    () =>
      Promise.resolve({
        env: { FOOM_CONTROL_URL: "http://127.0.0.1:1234/control/v1" },
        bind: vi.fn(),
        dispose,
      }),
  );
  await expect(agentFixture.service.launch({ ...request, agent: data.id })).rejects.toThrow(
    "Channel replacement disclosure",
  );
  expect(create).not.toHaveBeenCalled();
  expect(dispose).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledOnce();
});

it("checks manifest environment after layering and rejects its bypass for children", async () => {
  const { parseAgentManifest } = await import("../../../../src/shared/agent-plugin-parser");
  const { v2Provider } = await import("../../../../src/main/agents/providers/v2");
  const fixture = await import("../../../fixtures/agent-plugin-v2.json");
  const parsed = parseAgentManifest(
    JSON.stringify({
      ...fixture.default,
      files: [],
      launch: {
        ...fixture.default.launch,
        mcp: undefined,
        toolPermissions: undefined,
        environment: [{ name: "FIXTURE_BYPASS", value: "manifest-value" }],
      },
    }),
  );
  replaceConfigProviders([v2Provider(parsed.model, () => Promise.resolve())]);
  versions[parsed.model.id] = "fixture 1.2.3";
  agentFixture.help = "--inline --prompt";
  vi.stubEnv("FIXTURE_BYPASS", "");
  const approve = vi.fn(() => Promise.resolve(true));
  agentFixture.service = new AgentService(
    { listWorktrees, launchIdentity },
    { create },
    prepare,
    undefined,
    new AgyPlugin(),
    approve,
  );
  const result = await agentFixture.service.launch({
    ...request,
    agent: parsed.model.id,
    environment: [[{ name: "FIXTURE_BYPASS", value: "user-value" }]],
  });
  expect(result.bypass).toBe(true);
  expect(result.environment).toContain("FIXTURE_BYPASS");
  expect(create.mock.calls.at(-1)?.[0].env?.["FIXTURE_BYPASS"]).toBe("manifest-value");
  expect(JSON.stringify(approve.mock.calls)).toContain("FIXTURE_BYPASS: present-nonempty");
  expect(JSON.stringify(approve.mock.calls)).not.toContain("manifest-value");
  agentFixture.service.release(result.id);
  await expect(
    agentFixture.service.launch({
      ...request,
      agent: parsed.model.id,
      control: { parentId: "parent" },
      prompt: "task",
    }),
  ).rejects.toThrow("Unattended child");
});
