import { MessageBoard } from "../../../../src/main/control/message-board";
import type { ChildInput } from "../../../../src/shared/child-input";
import { expect, it, vi } from "vitest";
import type { WorkspaceDependencies } from "../../../../src/main/workspace/workspace-types";
import { ControlStore } from "../../../../src/main/control/store";
import { Operations } from "../../../../src/main/control/operations";
import type { Operation } from "../../../../src/main/control/types";
import {
  repo,
  deps,
  launch,
  tail,
  confirm,
  orchestrate,
  principal,
  createWorkspace,
} from "./orchestration-workspace-fixture";

it("sends child input through the workspace path and tracks input/output revisions", async () => {
  const workspace = createWorkspace(deps);
  await orchestrate(workspace);
  const actor = principal();
  const operations = new Operations(
    () => Promise.resolve(),
    () => undefined,
  );
  const tree = (await workspace.orchestration.call(
    actor,
    "create_worktree",
    { idempotencyKey: "a", branch: "feature" },
    operations,
  )) as Operation;
  launch.mockResolvedValueOnce({ id: "child", attention: "evaluator" });
  await workspace.orchestration.call(
    actor,
    "launch",
    { idempotencyKey: "b", worktreeId: tree.resultId, agent: "claude" },
    operations,
  );
  deps.verdicts.classify = vi.fn<WorkspaceDependencies["verdicts"]["classify"]>(() =>
    Promise.resolve({
      id: "question",
      terminalId: "child",
      timestamp: new Date().toISOString(),
      verdict: {
        state: "needs_input",
        signal: "pattern:question",
        reason: "Question",
        attentionKind: "question",
        confidence: 0.9,
      },
    }),
  );
  tail.mockResolvedValue(["Which file should I change?"]);
  const reply = vi.fn(async (_id: string, _data: ChildInput) => {});
  deps.terminals.childInput = reply;
  await workspace.quiet("child");
  const { SessionMetadata } = await import("../../../../src/main/control/metadata");
  const metadata = new SessionMetadata(() => workspace.snapshot().terminals);
  const question = metadata.read(actor, "session_state", { id: "child" }) as {
    revision: string;
    verdictId: string;
    attentionKind: string;
  };
  expect(question.attentionKind).toBe("question");
  const proposed = (await workspace.orchestration.call(
    actor,
    "prompt",
    {
      idempotencyKey: "c",
      id: "child",
      text: "src/app.ts",
    },
    operations,
  )) as Operation;
  await vi.waitFor(() => {
    expect(operations.lookup(actor, { operationId: proposed.operationId }).status).toBe(
      "succeeded",
    );
  });
  expect(reply).toHaveBeenCalledExactlyOnceWith("child", { kind: "prompt", text: "src/app.ts" });
  expect(workspace.snapshot().terminals.find((row) => row.id === "child")?.inputRevision).toBe(1);
  workspace.output("child");
  expect(workspace.snapshot().terminals.find((row) => row.id === "child")?.outputRevision).toBe(1);
  await workspace.sidebarCommand({ kind: "take-over", id: "child" }, confirm);
});

it("exposes durable history and clearing and refuses authority changes when intent cannot persist", async () => {
  const audit = new ControlStore("/unused");
  const human = vi.spyOn(audit, "human").mockResolvedValue();
  const read = vi.spyOn(audit, "read").mockResolvedValue({ entries: [], total: 0 });
  const clear = vi.spyOn(audit, "clearAudit").mockResolvedValue();
  const board = new MessageBoard(
    () => Promise.resolve(),
    () => [{ id: "a", name: "App" }],
  );
  const first = await board.append("orchestrator:a", "a", {
    to: ["a"],
    title: "Topic",
    kind: "fyi",
    text: "Hello",
    idempotencyKey: "open",
  });
  const original = deps.control;
  if (!original) throw new Error("Missing control");
  deps.control = async () => ({ ...(await original()), audit, board });
  const workspace = createWorkspace(deps);
  expect(await workspace.messageBoard("threads", {})).toMatchObject({
    threads: [{ id: first.thread }],
  });
  expect(await workspace.messageBoard("read", { thread: first.thread })).toMatchObject({
    posts: [{ text: "Hello" }],
  });
  await workspace.messageBoard("post", {
    thread: first.thread,
    kind: "answer",
    text: "Human",
    idempotencyKey: "human",
  });
  await workspace.messageBoard("resolve", { thread: first.thread, idempotencyKey: "resolve" });
  await expect(workspace.messageBoard("unknown", {})).rejects.toThrow("Invalid board method");
  const query = { search: "child", action: "reply", status: "", offset: 0 };
  expect(await workspace.actionLog(query)).toEqual({ entries: [], total: 0 });
  expect(read).toHaveBeenCalledWith(query);
  await workspace.clearActionLog();
  expect(clear).toHaveBeenCalledOnce();
  await orchestrate(workspace);
  expect(human).toHaveBeenCalledWith(
    "make_orchestrator",
    "parent",
    repo.path,
    repo.path,
    "parent",
    "pending_confirmation",
    expect.any(String),
  );
  await expect(
    workspace.sidebarCommand({ kind: "take-over", id: "parent" }, confirm),
  ).rejects.toThrow("This session has no orchestrator");
  expect(human).toHaveBeenLastCalledWith(
    "take_over",
    "parent",
    repo.path,
    repo.path,
    "parent",
    "refused",
    expect.any(String),
  );
  human.mockRejectedValueOnce(new Error("disk full"));
  await expect(
    workspace.sidebarCommand({ kind: "revoke-orchestrator", id: "parent" }, confirm),
  ).rejects.toThrow("disk full");
  expect(workspace.snapshot().terminals[0]?.orchestration).toMatchObject({ active: true });
});

it("reports unavailable history when the control service is absent", async () => {
  const unavailable = { ...deps };
  delete unavailable.control;
  const workspace = createWorkspace(unavailable);
  await expect(workspace.messageBoard("threads", {})).rejects.toThrow("Board unavailable");
  await expect(workspace.actionLog({})).rejects.toThrow("Action log unavailable");
  await expect(workspace.clearActionLog()).rejects.toThrow("Action log unavailable");
});
