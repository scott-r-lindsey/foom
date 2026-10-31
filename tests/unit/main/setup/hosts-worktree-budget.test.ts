import type * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { expect, test, vi } from "vitest";
import { Hosts } from "../../../../src/main/setup/hosts";
import { DEFAULT_SETTINGS } from "../../../../src/main/setup/settings";
import { Operations } from "../../../../src/main/control/operations";
import { ControlService } from "../../../../src/main/control/service";
import { object } from "../../../../src/shared/control-validation";
import type { HostManagement, HostResult } from "../../../../src/shared/registered-hosts.d";
import {
  createWorkspace,
  deps,
  orchestrate,
  repo,
} from "../workspace/orchestration-workspace-fixture";

const origin = "git@fixture.test:team/repo.git";
const mock = vi.hoisted(() => ({ origin: vi.fn() }));
vi.mock("../../../../src/main/agents/agents", () => ({
  loginPath: () => Promise.resolve({ path: "/fixture-login" }),
}));
vi.mock("../../../../src/main/control/forge-process", () => ({
  resolveForgeExecutable: () => Promise.resolve({ executable: "git" }),
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof childProcess>();
  return {
    ...actual,
    execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: mock.origin }),
  };
});

test.each([
  { mode: "branch", uncertain: false },
  { mode: "pullRequest", uncertain: false },
  { mode: "branch", uncertain: true },
  { mode: "pullRequest", uncertain: true },
])(
  "$mode creation charges worktree capacity only when a mutation may have occurred ($uncertain)",
  async ({ mode, uncertain }) => {
    mock.origin.mockResolvedValue({ stdout: origin });
    const codeFolder = "/code";
    const repository = `${codeFolder}/repository-${createHash("sha256").update(origin).digest("hex").slice(0, 24)}`;
    const facts = {
      codeFolder,
      version: "0.1.0",
      sessions: 0,
      cores: 4,
      load: [0, 0, 0],
      memoryTotal: 8000,
      memoryAvailable: 4000,
      agents: [],
    };
    let checkedOut = uncertain;
    const execute = vi.fn<(host: string, request: HostManagement) => Promise<HostResult>>(
      (_host, request) => {
        if (request.operation === "repository")
          return Promise.resolve({
            ok: true,
            facts,
            checkout: { path: repository, state: checkedOut ? "clean" : "absent" },
          });
        if (request.operation === "create-worktree") {
          if (uncertain) return Promise.resolve({ ok: false, reason: "unreachable" });
          return Promise.resolve({
            ok: true,
            facts,
            worktree: {
              path: `${codeFolder}/.foom-worktree-fixture`,
              branch: request.branch,
              identity: "a".repeat(64),
              changes: "",
            },
          });
        }
        throw new Error("Unexpected management operation");
      },
    );
    const settings = {
      ...DEFAULT_SETTINGS,
      registeredHosts: [{ host: "worker", codeFolder }],
    };
    const hosts = new Hosts(
      { get: () => settings, update: vi.fn(() => Promise.resolve(settings)) },
      () => [repo],
      "0.1.0",
      execute,
      "a".repeat(32),
    );
    vi.mocked(deps.worktrees.adoptionBranch).mockResolvedValue("pr-branch");
    const workspace = createWorkspace({ ...deps, hosts });
    await orchestrate(workspace);
    const operations = new Operations(
      () => Promise.resolve(),
      (actor) => {
        service.assertActive(actor);
      },
    );
    const service = new ControlService(
      operations,
      () => workspace.snapshot().terminals,
      workspace.orchestration,
    );
    const grant = service.prepare(repo.path, repo.path, "orchestrator");
    grant.bind("parent");
    const actor = service.authenticate(grant.env["FOOM_CONTROL_TOKEN"] ?? "");
    const create = (idempotencyKey: string, remote = true) =>
      service.call(actor, {
        version: 1,
        instanceId: service.instanceId,
        method: "create_worktree",
        params: {
          idempotencyKey,
          ...(remote ? { host: "worker" } : {}),
          ...(remote && mode === "pullRequest" ? { pullRequest: 756 } : { branch: idempotencyKey }),
        },
      });
    try {
      for (let attempt = 0; attempt < 4; attempt++)
        expect(await create(`attempt-${String(attempt)}`)).toMatchObject({
          status: uncertain ? "indeterminate" : "failed",
        });
      if (uncertain) {
        expect(
          execute.mock.calls
            .filter(([, request]) => request.operation !== "list-worktrees")
            .map(([, request]) => request.operation),
        ).toEqual(Array.from({ length: 4 }, () => ["repository", "create-worktree"]).flat());
        await expect(create("local-after-uncertain", false)).rejects.toMatchObject({
          code: "capacity",
        });
        return;
      }
      expect(
        execute.mock.calls
          .filter(([, request]) => request.operation !== "list-worktrees")
          .map(([, request]) => request.operation),
      ).toEqual(["repository", "repository", "repository", "repository"]);
      expect(await create("local-after-refusals", false)).toMatchObject({ status: "succeeded" });
      checkedOut = true;
      const recovered = object(await create("remote-after-checkout"));
      expect(recovered).toMatchObject({ status: "succeeded" });
      expect(recovered["resultId"]).toMatch(/^[a-f0-9]{64}$/u);
      expect(
        execute.mock.calls.filter(([, request]) => request.operation === "create-worktree"),
      ).toHaveLength(1);
    } finally {
      service.close();
      hosts.dispose();
    }
  },
);
