import {
  agentFixture,
  create,
  prepare,
  request,
  listWorktrees,
  launchIdentity,
} from "./agents-fixture";
import { expect, it, vi } from "vitest";
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
