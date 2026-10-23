import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { PullRequest } from "../../../../src/main/control/forge.d";
import { Operations } from "../../../../src/main/control/operations";
import { Orchestration } from "../../../../src/main/control/orchestration";
import type { OrchestrationHost } from "../../../../src/main/control/orchestration.d";
import { ControlService } from "../../../../src/main/control/service";
import type { Operation, StoredOperation } from "../../../../src/main/control/types";
import type { ChildInput } from "../../../../src/shared/child-input";
import type { DialogContent } from "../../../../src/shared/confirmation";
import type { OrchestrationView, WorkspaceTerminal } from "../../../../src/shared/workspace";

export const repo = join(tmpdir(), "orchestrated");
export const history = (view: OrchestrationView | undefined) =>
  view?.role === "orchestrator" ? view.history : [];
export const other = join(tmpdir(), "elsewhere");

export function harness(overrides: Pick<OrchestrationHost, "reviewSnapshot"> = {}) {
  let limit = 4;
  const rows = new Map<string, WorkspaceTerminal>();
  let next = 0;
  let now = 1_000_000;
  const row = (id: string, worktree: string, branch: string): WorkspaceTerminal => ({
    id,
    kind: "agent",
    agent: "claude",
    repository: repo,
    worktree,
    branch,
    attention: "evaluator",
    state: null,
  });
  rows.set("parent", row("parent", repo, "main"));
  const host = {
    forge: {
      track: vi.fn(),
      readSettled: vi.fn((repository: string, path: string): PullRequest | undefined =>
        host.forge.read(repository, path),
      ),
      read: vi.fn((_repository: string, _path: string): PullRequest | undefined => undefined),
    },
    terminals: () => [...rows.values()],
    adoptWorktree: vi.fn(
      (
        _repository: string,
        _number: number,
        _unused: readonly { path: string; identity: string }[],
        revalidate: (path?: string) => void,
      ) => {
        revalidate();
        return Promise.resolve({
          path: join(repo, "trees", "adopted"),
          branch: "adopted",
          identity: "id-adopted",
        });
      },
    ),
    createWorktree: vi.fn((_repository: string, branch: string) =>
      Promise.resolve({ path: join(repo, "trees", branch), branch, identity: `id-${branch}` }),
    ),
    launch: vi.fn(
      (
        _parent: string,
        _repository: string,
        worktree: string,
        _identity: string,
        _agent: string,
        _prompt: string | undefined,
        step?: { resume?: { id: string; conversationId: string }; validate(): void },
      ) => {
        step?.validate();
        const id = step?.resume?.id ?? `child-${String(++next)}`;
        rows.set(id, row(id, worktree, worktree.split("/").at(-1) ?? ""));
        return Promise.resolve(id);
      },
    ),
    restoreWorktree: vi.fn((_repository: string, path: string) =>
      Promise.resolve({
        branch: path.split("/").at(-1) ?? "child",
        identity: `id-${path.split("/").at(-1) ?? "child"}`,
      }),
    ),
    stop: vi.fn((_id: string) => Promise.resolve(true)),
    close: vi.fn((_id: string) => Promise.resolve()),
    place: vi.fn(),
    reply: vi.fn((_id: string, _input: ChildInput) => Promise.resolve()),
    tail: vi.fn((_id: string, _lines: number) => Promise.resolve(["ready"])),
    remove: vi.fn(
      (
        _repository: string,
        _worktree: string,
        _identity: string,
        confirm: (branch: string, changes: string) => Promise<boolean>,
      ) => confirm("feature", ""),
    ),
    dialog: vi.fn((_content: DialogContent, _signal: AbortSignal) => Promise.resolve(true)),
    changed: vi.fn(),
    ...overrides,
  } satisfies OrchestrationHost;
  const persist = vi.fn((_record: StoredOperation) => Promise.resolve());
  const operations = new Operations(persist, (actor) => {
    service.assertActive(actor);
  });
  const orchestration = new Orchestration(
    host,
    () => now,
    () => limit,
  );
  const service = new ControlService(operations, host.terminals, orchestration);
  const launchParent = (terminalId: string, repository = repo) => {
    const slot = orchestration.reserve(repository);
    if ("existing" in slot) throw new Error("slot taken");
    const grant = service.prepare(repository, repository, "orchestrator");
    grant.bind(terminalId);
    slot.bind(terminalId);
    const actor = service.authenticate(grant.env["FOOM_CONTROL_TOKEN"] ?? "");
    let key = 0;
    const call = (method: string, params: Record<string, unknown> = {}) =>
      service.call(actor, { version: 1, instanceId: service.instanceId, method, params });
    const mutate = (method: string, params: Record<string, unknown>) =>
      call(method, { idempotencyKey: `key-${String(++key)}`, ...params }) as Promise<Operation>;
    return { actor, grant, call, mutate };
  };
  const parent = launchParent("parent");
  const exit = (id: string) => {
    rows.set(id, { ...(rows.get(id) ?? row(id, repo, "")), exited: true });
    orchestration.exited(id);
  };
  const child = async (branch: string, mutate = parent.mutate) => {
    const tree = await mutate("create_worktree", { branch });
    const launched = await mutate("launch", { worktreeId: tree.resultId, agent: "claude" });
    return { worktreeId: tree.resultId ?? "", id: launched.resultId ?? "" };
  };
  return {
    setLimit: (value: number) => {
      limit = value;
    },
    host,
    rows,
    service,
    operations,
    orchestration,
    persist,
    launchParent,
    exit,
    child,
    ...parent,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
