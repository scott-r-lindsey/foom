import { expect, it, vi } from "vitest";
import { harness } from "./orchestration-helpers";
import { launchRemoteChild } from "../../../../src/main/agents/remote-launch";
import type { TerminalSpec } from "../../../../src/shared/desktop";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["exit", "revoke", "replace", "grant", "operation"])(
  "ordinary remote launch refuses stale parent/operation after %s during preparation",
  async (event) => {
    const h = harness();
    const tree = await h.mutate("create_worktree", { branch: "remote" });
    const prepared = deferred();
    const discovery = deferred();
    const spawn = vi.fn();
    const dispose = vi.fn();
    const bind = vi.fn();
    const create = async (spec: TerminalSpec) => {
      const binding = spec.remote?.agent;
      if (!binding) throw new Error("Missing remote binding");
      prepared.resolve();
      await discovery.promise;
      await binding.authorize();
      binding.start();
      spawn();
      binding.ready({ hooks: false, mcp: true });
      return spec.id ?? "missing";
    };
    h.host.launch.mockImplementationOnce(
      async (parentId, repository, worktree, _identity, agent, prompt, step) => {
        if (!step) throw new Error("Missing captured launch authority");
        const launched = await launchRemoteChild(
          {
            agent,
            repository,
            worktree,
            cols: 80,
            rows: 24,
            control: { parentId },
            beforeSpawn: () => {
              step.validate();
            },
            ...(prompt === undefined ? {} : { prompt }),
          },
          {
            target: { host: "fixture", artifact: "/artifact" },
            repository: "/remote/repo",
            worktree: "/remote/tree",
          },
          [],
          false,
          { create },
          {
            env: {},
            bind,
            dispose,
            remoteCall: () => Promise.resolve({ type: "error", error: "unavailable" }),
          },
          () => Promise.resolve(),
        );
        return launched.result.id;
      },
    );
    let replacement: ReturnType<typeof h.launchParent> | undefined;
    const pending = h.call("launch", {
      idempotencyKey: "delayed",
      worktreeId: tree.resultId,
      agent: "claude",
    });
    // Attach rejection before revoking so it cannot become an unhandled rejection.
    const rejected = expect(pending).rejects.toThrow(
      event === "grant" ? "unauthorized" : "forbidden",
    );
    await prepared.promise;
    if (event === "exit") h.exit("parent");
    if (event === "revoke") h.orchestration.revoke("parent");
    if (event === "replace") {
      h.orchestration.revoke("parent");
      replacement = h.launchParent("parent");
    }
    if (event === "grant") h.grant.dispose();
    if (event === "operation") {
      const operation = h.operations.lookup(h.actor, { idempotencyKey: "delayed" });
      await h.operations.finish(h.actor, operation.operationId, "cancelled", "revoked");
    }
    discovery.resolve();
    await rejected;
    expect(spawn).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    if (replacement)
      expect(await replacement.mutate("create_worktree", { branch: "replacement" })).toMatchObject({
        status: "succeeded",
      });
    h.orchestration.disposeUnreadChildren();
    h.service.close();
  },
);
