import { expect, it } from "vitest";
import { WorkspaceContext } from "../../../../src/main/workspace/workspace-context";
import { workspaceFeatureWiring } from "../../../../src/main/workspace/workspace-feature-wiring";
import { deps, scan } from "./workspace-fixture";

it("keeps reservations, queues and cancellation shared across feature views", async () => {
  const owner = new WorkspaceContext(deps);
  try {
    const features = workspaceFeatureWiring(owner);
    const reservations = [
      features.worktreeLaunch.busyWorktrees,
      features.sidebarCommands.busyWorktrees,
      features.repositoryOperations.busyWorktrees,
      features.orchestrationCommands.busyWorktrees,
      features.orchestrationHost.busyWorktrees,
    ];
    for (const reservation of reservations) expect(reservation).toBe(owner.busyWorktrees);
    expect(features.executionEvents.queues).toBe(owner.queues);
    expect(features.configLaunch.queues).toBe(owner.queues);
    expect(features.worktreeLaunch.queues).toBe(owner.queues);
    expect(features.orchestrationCommands.queues).toBe(owner.queues);
    expect(features.agentSetup.launchAbort).toBe(owner.launchAbort);
    expect(Object.keys(features.worktreeLaunch.deps.terminals)).toEqual(["create", "kill"]);
    expect(Object.keys(features.executionEvents.deps)).toEqual(["onChange"]);
  } finally {
    await owner.dispose();
  }
});

it("reflects changed settings and shares scan cache writes with the coordinator", async () => {
  const owner = new WorkspaceContext(deps);
  try {
    const features = workspaceFeatureWiring(owner);
    const pending = Promise.resolve(scan);
    features.agentSetup.scanned = pending;
    expect(owner.scanned).toBe(pending);
    owner.configure({
      hooks: false,
      agents: { claude: false, codex: true, agy: true },
      worktreeLocation: "adjacent",
      showNewChildren: false,
      agentArguments: { claude: ["--verbose"], codex: [], agy: [] },
    });
    expect(features.agentSetup.scanned).toBeUndefined();
    expect(features.agentSetup.hooksEnabled).toBe(false);
    expect(features.worktreeLaunch.enabled["claude"]).toBe(false);
    expect(features.worktreeLaunch.defaultArguments["claude"]).toEqual(["--verbose"]);
    expect(features.worktreeLaunch.location).toBe("adjacent");
    expect(features.orchestrationHost.location).toBe("adjacent");
    expect(features.orchestrationHost.showNewChildren).toBe(false);
    features.agentSetup.scanned = pending;
    expect(owner.scanned).toBe(pending);
  } finally {
    await owner.dispose();
  }
});
