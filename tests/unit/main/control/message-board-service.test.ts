import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBoard } from "../../../../src/main/control/message-board";
import { locationId } from "../../../../src/main/control/metadata";
import type { OrchestrationHost } from "../../../../src/main/control/orchestration.d";
import { harness, repo, other } from "./orchestration-helpers";
const a = locationId(repo),
  b = locationId(other);
const repos = () => [
  { id: a, name: "A" },
  { id: b, name: "B" },
];
const input = {
  title: "Release",
  to: [b],
  text: "Metadata?",
  kind: "request",
  idempotencyKey: "request",
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.useRealTimers();
});
function setup(save = () => Promise.resolve()) {
  const board = new MessageBoard(save, repos, (answers) => {
    h.service.boardChanged(answers);
  });
  const h = harness({}, board);
  cleanups.push(() => {
    h.service.close();
    h.orchestration.disposeUnreadChildren();
  });
  return { ...h, board };
}
describe("board grant authority", () => {
  it("derives author from the current grant and refuses child, ordinary, spoofed and revoked roles", async () => {
    const h = setup();
    const operation = await h.mutate("board_post", input);
    const id = operation.resultId ?? "";
    expect(operation.status).toBe("succeeded");
    expect(h.board.read({ thread: id }).posts[0]?.author).toBe(`orchestrator:${a}`);
    expect(await h.mutate("board_post", input)).toEqual(operation);
    const second = h.launchParent("second", other);
    expect(await second.call("board_read", { thread: id })).toMatchObject({ untrusted: true });
    await second.mutate("board_post", { thread: id, text: "Decision?", kind: "decision-needed" });
    expect(h.board.read({ thread: id }).posts[1]?.author).toBe(`orchestrator:${b}`);
    await expect(h.call("board_post", { ...input, author: "human" })).rejects.toThrow(
      "invalid_request",
    );
    const ordinary = h.service.prepare(repo, repo);
    ordinary.bind("ordinary");
    const child = h.service.prepare(repo, repo, "agent", "parent");
    child.bind("child");
    const unbound = h.service.prepare(repo, repo, "orchestrator");
    unbound.bind("unbound");
    for (const launch of [ordinary, child, unbound]) {
      const actor = h.service.authenticate(launch.env["FOOM_CONTROL_TOKEN"] ?? "");
      for (const method of ["board_threads", "board_read", "board_post", "board_resolve"])
        await expect(
          h.service.call(actor, {
            version: 1,
            instanceId: h.service.instanceId,
            method,
            params: {},
          }),
        ).rejects.toThrow("forbidden");
      launch.dispose();
    }
    h.exit("parent");
    await expect(h.call("board_threads")).rejects.toThrow("forbidden");
    const replacement = h.launchParent("new-parent");
    expect(await replacement.call("board_threads")).toMatchObject({ threads: [{ id }] });
    h.service.setRole("new-parent", "agent");
    await expect(replacement.call("board_threads")).rejects.toThrow("unauthorized");
  });
  it("refuses invalid envelopes, records indeterminate effects and supports operation lookup", async () => {
    const h = setup();
    await expect(
      h.service.call(h.actor, {
        version: 2,
        instanceId: h.service.instanceId,
        method: "board_threads",
        params: {},
      }),
    ).rejects.toThrow("invalid_request");
    const failed = await h.mutate("board_post", { ...input, to: ["missing"] });
    expect(failed.status).toBe("failed");
    expect(
      await h.call("operation_status", { idempotencyKey: input.idempotencyKey }),
    ).toMatchObject({ operationId: failed.operationId });
    const first = await h.mutate("board_post", { ...input, idempotencyKey: "valid" });
    expect(await h.mutate("board_resolve", { thread: first.resultId })).toMatchObject({
      status: "succeeded",
    });
  });
});
describe("one watcher for children and board", () => {
  it("wakes a board-only long wait for an addressed post, but not own or unrelated posts", async () => {
    const h = setup();
    const second = h.launchParent("second", other);
    const before = h.board.event(a);
    const waiting = h.call("wait_for", { untilEvent: true, boardAfter: before });
    await h.mutate("board_post", input);
    const thread = h.board.threads({}).threads[0]?.id ?? "";
    await second.mutate("board_post", { thread, kind: "answer", text: "Available" });
    expect(await waiting).toMatchObject({
      sessions: [],
      changed: [],
      timedOut: false,
      board: { changed: true },
    });
    const event = h.board.event(a);
    expect(await h.call("wait_for", { ids: [], timeoutMs: 0, boardAfter: event })).toMatchObject({
      timedOut: true,
      board: { event, changed: false },
    });
    await h.board.append("human", "human", {
      thread,
      kind: "answer",
      text: "Approved",
      idempotencyKey: "human",
    });
    expect(await h.call("wait_for", { ids: [], boardAfter: event })).toMatchObject({
      timedOut: false,
      board: { changed: true },
    });
  });
  it("releases board-only waits on disconnect and role revocation", async () => {
    const h = setup();
    const abort = new AbortController();
    const wait = h.service.call(
      h.actor,
      {
        version: 1,
        instanceId: h.service.instanceId,
        method: "wait_for",
        params: { untilEvent: true },
      },
      abort.signal,
    );
    abort.abort();
    await expect(wait).rejects.toThrow("unavailable");
    const revoked = h.call("wait_for", { untilEvent: true });
    h.service.setRole("parent", "agent");
    await expect(revoked).rejects.toThrow("unauthorized");
  });
});

it("rechecks the grant after durable intent before any board write", async () => {
  const h = setup();
  h.persist.mockImplementationOnce(() => {
    h.service.setRole("parent", "agent");
    return Promise.resolve();
  });
  await expect(h.mutate("board_post", input)).rejects.toThrow("unauthorized");
  expect(h.board.threads({}).threads).toEqual([]);
});

it("returns an indeterminate operation for an ambiguous save and refuses an unavailable board", async () => {
  const h = setup(() => Promise.reject(new Error("disk")));
  const operation = await h.mutate("board_post", input);
  expect(operation.status).toBe("indeterminate");
  expect(h.board.threads({}).threads).toEqual([]);
  const bare = harness();
  cleanups.push(() => {
    bare.service.close();
    bare.orchestration.disposeUnreadChildren();
  });
  await expect(bare.call("board_threads")).rejects.toThrow("unavailable");
});

it("wakes a wait on a structured human answer while agent transport cannot submit or spoof one", async () => {
  const h = setup();
  const result = await h.mutate("board_post", {
    ...input,
    kind: "question",
    questions: [
      {
        title: "Proceed?",
        options: [
          { id: "go", label: "Go" },
          { id: "hold", label: "Hold" },
        ],
      },
    ],
  });
  const thread = result.resultId ?? "";
  const post = h.board.read({ thread }).posts[0]?.id;
  const answers = [{ post, index: 0, option: "go" }];
  await expect(
    h.call("board_post", { thread, text: "Go", kind: "answer", answers, idempotencyKey: "forge" }),
  ).rejects.toThrow("invalid_request");
  await expect(h.call("board_answer", { answers, idempotencyKey: "forge" })).rejects.toThrow();
  const waiting = h.call("wait_for", { ids: [], boardAfter: h.board.event(a), untilEvent: true });
  await h.board.answer({ answers, idempotencyKey: "human" });
  expect(await waiting).toMatchObject({ timedOut: false, board: { changed: true } });
  expect(h.board.read({ thread }).posts.at(-1)).toMatchObject({
    author: "human",
    kind: "answer",
    answers,
  });
});

it("acknowledges only queued answer posts actually included in a board read", async () => {
  vi.useFakeTimers();
  const h = setup();
  let eligible = false;
  const wake = vi.fn<NonNullable<OrchestrationHost["wake"]>>(async (_id, _line, valid, intent) => {
    if (!eligible || !valid()) return "queued";
    await intent();
    return "sent";
  });
  Reflect.set(h.host, "wake", wake);
  const askAndAnswer = async (key: string) => {
    const result = await h.mutate("board_post", {
      ...input,
      idempotencyKey: key,
      kind: "question",
      questions: [
        {
          title: "Proceed?",
          options: [
            { id: "go", label: "Go" },
            { id: "hold", label: "Hold" },
          ],
        },
      ],
    });
    const thread = result.resultId ?? "";
    const post = h.board.read({ thread }).posts[0]?.id;
    await h.board.answer({ answers: [{ post, index: 0, option: "go" }], idempotencyKey: key });
    return thread;
  };
  const historical = await askAndAnswer("old");
  h.orchestration.configureWake(true, 1);
  await askAndAnswer("new");
  await vi.advanceTimersByTimeAsync(0);
  await h.call("board_read", { thread: historical });
  eligible = true;
  h.advance(2000);
  await vi.advanceTimersByTimeAsync(2000);
  expect(wake.mock.calls.at(-1)?.[1]).toContain("board decisions answered");
  expect(
    h.persist.mock.calls.some(
      ([record]) => record.operation.action === "wake" && record.operation.status === "succeeded",
    ),
  ).toBe(true);
  eligible = false;
  const recent = await askAndAnswer("ack");
  await h.call("board_read", { thread: recent });
  eligible = true;
  const count = wake.mock.calls.length;
  h.advance(60000);
  await vi.advanceTimersByTimeAsync(60000);
  expect(wake).toHaveBeenCalledTimes(count);
});
