import { afterEach, expect, test, vi } from "vitest";
import type { DialogContent, PluginSetupProgress } from "../../../../src/shared/confirmation";
import { resolveInterfaceTheme } from "../../../../src/shared/interface-themes";
import { Approvals } from "../../../../src/main/confirmations/approvals";
const theme = () => resolveInterfaceTheme("follow", false);
afterEach(() => vi.useRealTimers());
function setup() {
  vi.useFakeTimers();
  const present = vi.fn<(content: DialogContent, signal: AbortSignal) => Promise<boolean>>(
    () => new Promise(() => {}),
  );
  const queue = new Approvals(present, theme, () => Date.now());
  const content = (id: string, changes = "") =>
    ({
      title: "Remove?",
      accept: "Remove",
      approval: { kind: "Worktree removal", origin: "Claude · Tile 1 · repo" },
      removal: { group: "generation", item: { id, branch: id, path: `/repo/${id}`, changes } },
    }) satisfies DialogContent;
  return { queue, present, content };
}
test("one presentation contains ordered independent decisions, including different kinds", async () => {
  const { queue, present, content } = setup();
  const a = queue.request(content("a"));
  const b = queue.request({
    title: "Grant?",
    accept: "Grant",
    approval: { kind: "Authority", origin: "Codex · Tile 2 · other repo" },
  });
  expect(present).toHaveBeenCalledTimes(1);
  const rows = queue.feed.current();
  expect(rows.map((row) => row.kind)).toEqual(["Worktree removal", "Authority"]);
  queue.feed.answer(rows[0]?.request.id ?? "", true);
  expect(queue.feed.current()).toHaveLength(2);
  queue.feed.presented(true);
  await vi.advanceTimersByTimeAsync(899);
  queue.feed.answer(rows[0]?.request.id ?? "", true);
  expect(queue.feed.current()).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  queue.feed.answer(rows[0]?.request.id ?? "", true);
  expect(await a).toBe(true);
  expect(queue.feed.current()).toHaveLength(1);
  queue.feed.answer(rows[1]?.request.id ?? "", false);
  expect(await b).toBe(false);
  expect(present.mock.calls[0]?.[1].aborted).toBe(true);
});
test("bulk consumes only the captured removal IDs and refuses mixed, stale, duplicate or unready IDs", async () => {
  const { queue, content } = setup();
  const a = queue.request(content("a"));
  const b = queue.request(content("b"));
  const trust = queue.request({
    title: "Trust?",
    accept: "Trust",
    approval: { kind: "Host trust", origin: "Foom · background" },
  });
  const snapshot = queue.feed
    .current()
    .slice(0, 2)
    .map((row) => row.request.id);
  queue.feed.presented(true);
  await vi.advanceTimersByTimeAsync(900);
  const c = queue.request(content("c"));
  const cId = queue.feed.current().at(-1)?.request.id ?? "";
  for (const ids of [
    [],
    ["stale"],
    [...snapshot, cId],
    [...snapshot, snapshot[0] ?? ""],
    queue.feed.current().map((row) => row.request.id),
  ])
    queue.feed.answer("queue", ids);
  expect(queue.feed.current()).toHaveLength(4);
  queue.feed.answer("queue", snapshot);
  expect(await a).toBe(true);
  expect(await b).toBe(true);
  expect(queue.feed.current().map((row) => row.kind)).toEqual(["Host trust", "Worktree removal"]);
  queue.feed.presented(false);
  await vi.advanceTimersByTimeAsync(900);
  queue.feed.answer(cId, true);
  expect(queue.feed.current()).toHaveLength(2);
  queue.feed.presented(true);
  queue.feed.answer(cId, true);
  expect(await c).toBe(true);
  const row = queue.feed.current()[0];
  queue.feed.answer(row?.request.id ?? "", false);
  expect(await trust).toBe(false);
});
test.each([" M tracked.txt\0", "?? untracked.txt\0"])(
  "bulk rejects a snapshot containing a non-clean removal: %s",
  async (changes) => {
    const { queue, content } = setup();
    const clean = queue.request(content("clean"));
    const dirty = queue.request(content("dirty", changes));
    queue.feed.presented(true);
    await vi.advanceTimersByTimeAsync(900);
    const rows = queue.feed.current();
    expect(rows.map((row) => row.request.changes)).toEqual(["", changes]);
    queue.feed.answer(
      "queue",
      rows.map((row) => row.request.id),
    );
    expect(queue.feed.current()).toEqual(rows);
    const [cleanId, dirtyId] = rows.map((row) => row.request.id);
    queue.feed.answer("queue", [cleanId ?? ""]);
    queue.feed.answer(dirtyId ?? "", true);
    await expect(clean).resolves.toBe(true);
    await expect(dirty).resolves.toBe(true);
  },
);
test("duplicates share one row, each withdrawal releases only its caller, expiry removes requests", async () => {
  const { queue, content } = setup();
  const cancel = new AbortController();
  const first = queue.request(content("a"), cancel.signal);
  const second = queue.request({
    ...content("a"),
    removal: {
      group: "generation",
      item: { id: "another-op", branch: "a", path: "/repo/a", changes: "" },
    },
  });
  expect(queue.feed.current()).toHaveLength(1);
  expect(queue.feed.current()[0]?.repeats).toBe(2);
  cancel.abort();
  expect(await first).toBe(false);
  expect(queue.feed.current()).toHaveLength(1);
  queue.feed.presented(true);
  await vi.advanceTimersByTimeAsync(900);
  queue.feed.answer(queue.feed.current()[0]?.request.id ?? "", true);
  expect(await second).toBe(true);
  const expired = queue.requestOutcome({
    title: "Pair?",
    accept: "Grant",
    pairing: { code: "123", expiresAt: Date.now() + 100 },
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(await expired).toBe("cancelled");
  expect(queue.feed.current()).toHaveLength(0);
  const aborted = new AbortController();
  aborted.abort();
  expect(await queue.request(content("b"), aborted.signal)).toBe(false);
});
test("withdrawn rows and failed presentations clear without consuming later generations", async () => {
  const { queue, present, content } = setup();
  const listener = vi.fn();
  const off = queue.feed.subscribe(listener);
  const abort = new AbortController();
  const a = queue.request(content("a"), abort.signal);
  abort.abort();
  expect(await a).toBe(false);
  expect(queue.feed.current()).toHaveLength(0);
  present.mockRejectedValueOnce(Error("failed"));
  const b = queue.request(content("b"));
  await vi.advanceTimersByTimeAsync(0);
  expect(await b).toBe(false);
  expect(queue.feed.current()).toHaveLength(0);
  expect(listener).toHaveBeenCalled();
  off();
});
test("plugin acceptance keeps its own progress row and cannot approve while running", async () => {
  const { queue } = setup();
  let progress: PluginSetupProgress | undefined;
  let publish = () => {};
  const accept = vi.fn();
  const unsubscribe = vi.fn();
  const result = queue.request({
    title: "Install?",
    accept: "Install",
    pluginFeed: {
      current: () => progress,
      subscribe: (listener) => {
        publish = listener;
        return unsubscribe;
      },
      accept,
    },
  });
  const id = queue.feed.current()[0]?.request.id ?? "";
  queue.feed.presented(true);
  await vi.advanceTimersByTimeAsync(900);
  publish();
  queue.feed.answer(id, true);
  expect(accept).toHaveBeenCalledOnce();
  expect(queue.feed.current()).toHaveLength(1);
  progress = { phase: "running", steps: [], commands: [], location: "fixture" };
  publish();
  queue.feed.answer(id, false);
  expect(queue.feed.current()).toHaveLength(1);
  progress = { ...progress, phase: "success" };
  publish();
  queue.feed.answer(id, false);
  expect(await result).toBe(false);
  expect(unsubscribe).toHaveBeenCalledOnce();
});

test("an authority request cannot merge into a removal or become bulk eligible by its label", async () => {
  const { queue } = setup();
  const first = queue.request({
    title: "Same target",
    accept: "Approve",
    approval: { kind: "Authority", origin: "Foom", key: "same" },
  });
  const second = queue.request({
    title: "Same target",
    accept: "Approve",
    approval: { kind: "Worktree removal", origin: "Foom", key: "same" },
  });
  expect(queue.feed.current()).toHaveLength(2);
  queue.feed.presented(true);
  await vi.advanceTimersByTimeAsync(900);
  queue.feed.answer(
    "queue",
    queue.feed.current().map((row) => row.request.id),
  );
  expect(queue.feed.current()).toHaveLength(2);
  for (const row of queue.feed.current()) queue.feed.answer(row.request.id, false);
  expect(await first).toBe(false);
  expect(await second).toBe(false);
});

test("the monotonic guard and absolute expiry are enforced independently of renderer readiness", async () => {
  vi.useFakeTimers();
  let time = 0;
  const queue = new Approvals(
    () => new Promise(() => {}),
    theme,
    () => time,
  );
  const result = queue.request({
    title: "Pair",
    accept: "Grant",
    pairing: { code: "123", expiresAt: Date.now() + 1000 },
  });
  queue.feed.presented(true);
  await vi.advanceTimersByTimeAsync(900);
  const id = queue.feed.current()[0]?.request.id ?? "";
  queue.feed.answer(id, true);
  expect(queue.feed.current()).toHaveLength(1);
  time = 900;
  vi.setSystemTime(Date.now() + 200);
  queue.feed.answer(id, true);
  expect(queue.feed.current()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toBe(false);
});

test("bulk cannot consume plugin or credential content even with removal metadata", async () => {
  const { queue, content } = setup();
  const plugin = queue.request({
    ...content("plugin"),
    pluginFeed: { current: () => undefined, subscribe: () => () => {}, accept: vi.fn() },
  });
  const pairing = queue.request({
    ...content("pairing"),
    pairing: { code: "123", expiresAt: Date.now() + 5000 },
  });
  queue.feed.presented(true);
  await vi.advanceTimersByTimeAsync(900);
  for (const row of queue.feed.current()) queue.feed.answer("queue", [row.request.id]);
  expect(queue.feed.current()).toHaveLength(2);
  for (const row of queue.feed.current()) queue.feed.answer(row.request.id, false);
  expect(await plugin).toBe(false);
  expect(await pairing).toBe(false);
});

test("withdrawal during a captured bulk decision never replays consent to a withdrawn row", async () => {
  const { queue, content } = setup();
  const abort = new AbortController();
  const request = content("a");
  const first = queue.request({
    ...request,
    detail: "Extra caller disclosure",
    removal: {
      ...request.removal,
      item: { ...request.removal.item, pullRequest: { number: 42, state: "MERGED" } },
    },
  });
  const second = queue.request(content("b"), abort.signal);
  expect(queue.feed.current()[0]?.request).toMatchObject({
    detail: "Extra caller disclosure",
    facts: [{ label: "PR", value: "#42 · MERGED" }],
  });
  queue.feed.presented(true);
  await vi.advanceTimersByTimeAsync(900);
  let armed = false;
  const off = queue.feed.subscribe(() => {
    if (armed && queue.feed.current().length === 1) abort.abort();
  });
  armed = true;
  queue.feed.answer(
    "queue",
    queue.feed.current().map((row) => row.request.id),
  );
  expect(await first).toBe(true);
  expect(await second).toBe(false);
  expect(queue.feed.current()).toHaveLength(0);
  off();
});

test("unusual source labels cannot poison the bounded queue payload or change its target", async () => {
  const { queue } = setup();
  const abort = new AbortController();
  const result = queue.request(
    {
      title: "Review",
      accept: "Approve",
      subject: "/repo/line\nbreak",
      approval: { kind: "Background", origin: "Agent\n\u202e" + "x".repeat(9000) },
    },
    abort.signal,
  );
  const row = queue.feed.current()[0];
  expect(row?.origin).toHaveLength(8192);
  expect(row?.origin).not.toMatch(/[\p{Cc}\u202a-\u202e]/u);
  expect(row?.request.subject).toBe("/repo/line\nbreak");
  abort.abort();
  expect(await result).toBe(false);
});

test("identical grant labels with different captured checkout identities require separate decisions", async () => {
  const { queue } = setup();
  const abort = new AbortController();
  const content: DialogContent = {
    title: "Make orchestrator?",
    accept: "Grant",
    approval: { kind: "Authority", origin: "Claude · Tile 1 · repo", key: "checkout-one" },
  };
  const first = queue.request(content, abort.signal);
  const second = queue.request(
    {
      ...content,
      approval: { kind: "Authority", origin: "Claude · Tile 1 · repo", key: "checkout-two" },
    },
    abort.signal,
  );
  expect(queue.feed.current()).toHaveLength(2);
  expect(queue.feed.current()[0]?.request.id).not.toBe(queue.feed.current()[1]?.request.id);
  abort.abort();
  expect(await first).toBe(false);
  expect(await second).toBe(false);
});
