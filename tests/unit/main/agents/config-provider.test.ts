import { afterEach, expect, it } from "vitest";
import fixture from "../../../fixtures/agent-plugin.json";
import { parseAgentManifest } from "../../../../src/shared/agent-plugin-parser";
import { v2Provider } from "../../../../src/main/agents/providers/v2";
import {
  knownAgentId,
  replaceConfigProviders,
  providerRevision,
} from "../../../../src/main/agents/providers/registry";
import { hasBypassArgument } from "../../../../src/main/agents/default-arguments";
import { detectAgent } from "../../../../src/main/evaluator/agent-rules";
import { agentChoices, readyAgents } from "../../../../src/renderer/preflight/preflight";
import { setupState } from "../../../fixtures/setup";
import { launcherActions } from "../../../../src/renderer/board/sidebar-view";

const manifest = parseAgentManifest(JSON.stringify(fixture)).model;
afterEach(() => {
  replaceConfigProviders([]);
});
it("registers a v2 config provider without granting reserved or duplicate identities", () => {
  const provider = v2Provider(manifest, () => Promise.resolve());
  replaceConfigProviders([provider]);
  const revision = providerRevision();
  replaceConfigProviders([provider]);
  expect(providerRevision()).toBe(revision);
  expect(knownAgentId({ id: manifest.id })).toBe(false);
  expect(hasBypassArgument(manifest.id, ["--yolo"])).toBe(true);
  expect(hasBypassArgument(manifest.id, [])).toBe(false);
  expect(hasBypassArgument("unavailable-provider", ["--yolo"])).toBe(false);
  expect(detectAgent(manifest.id, { title: "Fixture working", progress: null }, [])).toMatchObject({
    id: "working",
  });
  expect(() => {
    replaceConfigProviders([provider, provider]);
  }).toThrow("duplicate");
  expect(() => {
    replaceConfigProviders([{ ...provider, id: "claude" }]);
  }).toThrow("Reserved");
});
it("exposes config providers to discovery choices and checkout launchers", () => {
  const provider = v2Provider(manifest, () => Promise.resolve());
  const installation = {
    ...provider.discover("/fixture/agent", "1.0", "--observer"),
    name: manifest.name,
    mark: manifest.badge,
    command: "foom-test-agent",
  };
  const report = { warning: null, agents: [installation] };
  expect(agentChoices(report)).toContainEqual({
    id: manifest.id,
    name: manifest.name,
    command: "foom-test-agent",
  });
  expect(readyAgents(report, setupState())).toEqual([installation]);
  expect(
    launcherActions(
      {
        agents: [installation],
        repositories: [],
        enabled: setupState().settings.agents,
        hooks: true,
      },
      "sh",
    )[0],
  ).toMatchObject({ label: manifest.name, badge: manifest.badge, run: manifest.id });
});
