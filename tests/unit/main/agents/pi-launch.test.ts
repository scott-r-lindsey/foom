import {
  agentFixture,
  create,
  prepare,
  request,
  listWorktrees,
  launchIdentity,
} from "./agents-fixture";
import { expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../../../src/main/setup/settings";
import { bypassConsentIdentity } from "../../../../src/main/agents/default-arguments";
import { agentProvider } from "../../../../src/main/agents/providers/registry";
import { AgyPlugin } from "../../../../src/main/agents/agy-plugin";
import { AgentService } from "../../../../src/main/agents/agents";

it("launches and resumes Pi through fixed probes, records its assigned ID, and never prepares hooks", async () => {
  agentFixture.help = "--session --session-id";
  const fresh = await agentFixture.service.launch({ ...request, agent: "pi" });
  expect(fresh).toMatchObject({ attention: "evaluator" });
  expect(fresh.conversationId).toMatch(/^[a-f0-9-]{36}$/u);
  if (!fresh.conversationId) throw new Error("Missing assigned Pi session ID");
  expect(create.mock.calls[0]?.[0].args).toEqual(["--session-id", fresh.conversationId]);
  expect(prepare).not.toHaveBeenCalled();
  agentFixture.service.release(fresh.id);
  const resumed = await agentFixture.service.launch({
    ...request,
    agent: "pi",
    terminalId: "resumed",
    conversationId: fresh.conversationId,
  });
  expect(create.mock.calls.at(-1)?.[0].id).toBe("resumed");
  expect(create.mock.calls.at(-1)?.[0].args).toEqual(["--session", fresh.conversationId]);
  expect(prepare).not.toHaveBeenCalled();
  agentFixture.service.release(resumed.id);
});

it("refuses orchestration restoration for Pi before creating a terminal", async () => {
  const dispose = vi.fn();
  const service = new AgentService({ listWorktrees, launchIdentity }, { create }, prepare, () =>
    Promise.resolve({ env: {}, bind: vi.fn(), dispose }),
  );
  await expect(
    service.launch({
      ...request,
      agent: "pi",
      conversationId: "existing",
      control: { role: "orchestrator" },
    }),
  ).rejects.toThrow("without MCP");
  expect(dispose).toHaveBeenCalledOnce();
  expect(create).not.toHaveBeenCalled();
});

it.each(["--approve", "-a"])(
  "Pi %s launch ignores legacy/custom and stale provider consent, including after cancellation",
  async (bypass) => {
    const provider = agentProvider("pi");
    const current = bypassConsentIdentity(provider);
    if (!current) throw Error("Missing Pi identity");
    const identities = [
      undefined,
      bypassConsentIdentity({ ...provider, origin: "config" }),
      bypassConsentIdentity({
        ...provider,
        model: { ...provider.model, executables: ["former-pi"] },
      }),
      bypassConsentIdentity({
        ...provider,
        model: { ...provider.model, bypassArguments: [] },
      }),
    ];
    for (const identity of identities) {
      expect(identity).not.toBe(current);
      const settings = {
        ...DEFAULT_SETTINGS,
        agentBypassAcknowledged: { ...DEFAULT_SETTINGS.agentBypassAcknowledged, pi: true },
        agentBypassIdentities: identity ? { pi: identity } : {},
      };
      const confirm = vi.fn(() => Promise.resolve(false));
      const service = new AgentService(
        { listWorktrees, launchIdentity },
        { create },
        undefined,
        undefined,
        new AgyPlugin(),
        confirm,
      );
      try {
        service.setBypassIdentities(settings.agentBypassIdentities);
        const launch = { ...request, agent: "pi", defaultArguments: [bypass] };
        create.mockClear();
        await expect(service.launch(launch)).rejects.toThrow("cancelled");
        expect(create).not.toHaveBeenCalled();
        expect(confirm).toHaveBeenCalledOnce();
        expect(confirm.mock.calls[0]).toMatchObject([{ title: "Launch Pi with bypass?" }]);
        // The cancelled launch cannot upgrade stale consent.
        await expect(service.launch(launch)).rejects.toThrow("cancelled");
        expect(create).not.toHaveBeenCalled();
        expect(confirm).toHaveBeenCalledTimes(2);
        confirm.mockResolvedValue(true);
        const approved = await service.launch(launch);
        expect(approved).toMatchObject({ bypass: true, providerOrigin: "bundled" });
        service.release(approved.id);
        // An invocation approval is not persisted Settings consent.
        confirm.mockResolvedValue(false);
        await expect(service.launch(launch)).rejects.toThrow("cancelled");
        expect(confirm).toHaveBeenCalledTimes(4);
        service.setBypassIdentities({ pi: current });
        const savedConsent = await service.launch(launch);
        expect(confirm).toHaveBeenCalledTimes(4);
        service.release(savedConsent.id);
        service.setBypassIdentities(settings.agentBypassIdentities);
        await expect(service.launch(launch)).rejects.toThrow("cancelled");
        expect(confirm).toHaveBeenCalledTimes(5);
      } finally {
        service.dispose();
      }
    }
  },
);
