import { expect, test, vi } from "vitest";
import {
  RemovalReview,
  removalContent,
  RemovalPresentations,
  declineOnAbort,
} from "../../../../src/main/confirmations/removal-review";
import type { DialogContent } from "../../../../src/shared/confirmation";

function harness() {
  const pending: { content: DialogContent; resolve(value: boolean): void }[] = [];
  const dialog = vi.fn(
    (content: DialogContent) =>
      new Promise<boolean>((resolve) => {
        pending.push({ content, resolve });
      }),
  );
  return { review: new RemovalReview(dialog), dialog, pending };
}
const item = (id: string) => ({ id, branch: id, path: `/trees/${id}`, changes: "" });

test("single removals keep their ordinary dialog and disclose cached PR state when present", () => {
  expect(removalContent([item("clean")])).toMatchObject({
    title: "Remove worktree?",
    subject: "clean",
    accept: "Remove worktree",
    facts: [
      { label: "Worktree", value: "/trees/clean", mono: true },
      { label: "State", value: "Clean" },
    ],
  });
  const dirty = {
    ...item("dirty"),
    changes: "?? file\0",
    pullRequest: { number: 338, state: "MERGED" as const },
  };
  expect(removalContent([dirty])).toMatchObject({
    title: "Remove worktree with uncommitted changes?",
    accept: "Discard changes and remove",
    changes: dirty.changes,
    facts: expect.arrayContaining([
      { label: "State", value: "Dirty" },
      { label: "PR", value: "#338 · MERGED" },
    ]) as unknown,
  });
  expect(removalContent([item("clean"), dirty])).toMatchObject({
    title: "Remove worktrees?",
    accept: "Approve all",
    removals: [item("clean"), dirty],
  });
});

test("groups only one actor's pending reviews, approves a subset and declines the rest", async () => {
  const { review, dialog, pending } = harness();
  const first = review.request("actor", item("one"));
  const feed = pending[0]?.content.removalFeed;
  if (!feed) throw Error("missing feed");
  const changed = vi.fn();
  const off = feed.subscribe(changed);
  const second = review.request("actor", { ...item("two"), changes: "?? file\0" });
  const foreign = review.request("other", item("three"));
  expect(dialog).toHaveBeenCalledTimes(2);
  expect(feed.current()).toEqual([item("one"), { ...item("two"), changes: "?? file\0" }]);
  expect(changed).toHaveBeenCalledOnce();
  off();
  const third = review.request("actor", item("four"));
  expect(changed).toHaveBeenCalledOnce();
  feed.select(["one", "four"]);
  pending[0]?.resolve(true);
  pending[1]?.resolve(false);
  await expect(first).resolves.toBe(true);
  await expect(second).resolves.toBe(false);
  await expect(third).resolves.toBe(true);
  await expect(foreign).resolves.toBe(false);
});

test("new arrivals after an answer get a separate review; completion cannot clear that batch", async () => {
  const { review, pending } = harness();
  const first = review.request("actor", item("one"));
  pending[0]?.content.removalFeed?.select(["one"]);
  const next = review.request("actor", item("two"));
  pending[0]?.resolve(true);
  await expect(first).resolves.toBe(true);
  const third = review.request("actor", item("three"));
  expect(pending).toHaveLength(2);
  pending[1]?.content.removalFeed?.select(["two", "three"]);
  pending[1]?.resolve(true);
  await expect(next).resolves.toBe(true);
  await expect(third).resolves.toBe(true);
});

test("aborted requests and late answers cannot approve a revoked batch", async () => {
  const { review, dialog, pending } = harness();
  const abort = new AbortController();
  const first = review.request("actor", item("one"), abort.signal);
  const second = review.request("actor", item("two"), abort.signal);
  abort.abort();
  await expect(review.request("actor", item("three"), abort.signal)).resolves.toBe(false);
  const fresh = review.request("actor", item("four"));
  expect(dialog).toHaveBeenCalledTimes(2);
  pending[0]?.content.removalFeed?.select(["one", "two"]);
  pending[0]?.resolve(true);
  await expect(first).resolves.toBe(false);
  await expect(second).resolves.toBe(false);
  // The stale completion must not delete the fresh batch.
  const fifth = review.request("actor", item("five"));
  expect(dialog).toHaveBeenCalledTimes(2);
  pending[1]?.resolve(false);
  await expect(fresh).resolves.toBe(false);
  await expect(fifth).resolves.toBe(false);
});

test("aborting one item declines it immediately and leaves the others under review", async () => {
  const { review, dialog, pending } = harness();
  const abort = new AbortController();
  const first = review.request("actor", item("one"), abort.signal);
  const second = review.request("actor", item("two"));
  const feed = pending[0]?.content.removalFeed;
  if (!feed) throw Error("missing feed");
  const changed = vi.fn();
  feed.subscribe(changed);
  abort.abort();
  await expect(first).resolves.toBe(false);
  expect(changed).toHaveBeenCalledOnce();
  expect(feed.current()).toEqual([item("two")]);
  const third = review.request("actor", item("three"));
  expect(dialog).toHaveBeenCalledOnce();
  feed.select(["two", "three"]);
  pending[0]?.resolve(true);
  await expect(second).resolves.toBe(true);
  await expect(third).resolves.toBe(true);
});

test("copy targets are only pending worktree and displayed change paths, including rename sources", async () => {
  const { removalCopyPaths } = await import("../../../../src/main/confirmations/removal-review");
  const paths = removalCopyPaths({
    title: "Remove",
    accept: "Remove",
    worktreePath: "/tree",
    changes: "R  new.txt\0old.txt\0?? extra\0",
    removals: [{ id: "one", branch: "feature", path: "/one", changes: "?? file\0" }],
    cleanup: {
      stage: "ready",
      progress: {
        total: 1,
        done: 0,
        phase: "remove",
        stopped: false,
        items: [{ id: "two", branch: "two", state: "queued", changes: "!! ignored\0" }],
      },
    },
    pairing: { code: "SECRET", expiresAt: 10 },
    facts: [{ label: "Token", value: "SECRET" }],
  });
  expect([...paths]).toEqual([
    ["worktree", "/tree"],
    ["change:0", "new.txt"],
    ["change:1", "old.txt"],
    ["change:2", "extra"],
    ["removal:one", "/one"],
    ["removal-change:one:0", "file"],
    ["cleanup-change:two:0", "ignored"],
  ]);
  expect(paths.get("unknown")).toBeUndefined();
  expect([...paths.values()]).not.toContain("SECRET");
  expect(removalCopyPaths({ title: "Other", accept: "Continue" }).size).toBe(0);
});

test("removal presentation slots serialize independent boards and recover after failure", async () => {
  const { RemovalPresentations } = await import(
    "../../../../src/main/confirmations/removal-review"
  );
  const presentations = new RemovalPresentations();
  let decline: (value: boolean) => void = () => undefined;
  const first = presentations.run(
    () =>
      new Promise<boolean>((resolve) => {
        decline = resolve;
      }),
  );
  const secondPresent = vi.fn(() => Promise.reject(new Error("renderer lost")));
  const second = presentations.run(secondPresent);
  // Attach the rejection assertion before releasing the earlier presentation.
  const failed = expect(second).rejects.toThrow("renderer lost");
  const thirdPresent = vi.fn(() => Promise.resolve(true));
  const third = presentations.run(thirdPresent);
  await Promise.resolve();
  expect(secondPresent).not.toHaveBeenCalled();
  expect(thirdPresent).not.toHaveBeenCalled();
  decline(false);
  await expect(first).resolves.toBe(false);
  await failed;
  await expect(third).resolves.toBe(true);
  expect(secondPresent).toHaveBeenCalledOnce();
  expect(thirdPresent).toHaveBeenCalledOnce();
});

test("an abandoned queued presentation settles before the active slot and never activates", async () => {
  const slots = new RemovalPresentations();
  let release: (answer: boolean) => void = () => undefined;
  const first = slots.run(
    () =>
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
  );
  const abort = new AbortController();
  const present = vi.fn(() => Promise.resolve(true));
  let answer: boolean | undefined;
  const queued = slots.run(present, abort.signal).then((value) => {
    answer = value;
  });
  await Promise.resolve();
  abort.abort();
  await new Promise<void>(setImmediate);
  const beforeRelease = answer;
  release(true);
  await Promise.all([first, queued]);
  expect(beforeRelease).toBe(false);
  expect(present).not.toHaveBeenCalled();
  await expect(slots.run(present, abort.signal)).resolves.toBe(false);
  expect(present).not.toHaveBeenCalled();
});

test("canceling an active caller keeps the slot until its presentation has finished", async () => {
  const slots = new RemovalPresentations();
  const abort = new AbortController();
  let finish: (answer: boolean) => void = () => undefined;
  const active = slots.run(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    abort.signal,
  );
  const next = vi.fn(() => Promise.resolve(true));
  const queued = slots.run(next);
  await Promise.resolve();
  abort.abort();
  await expect(active).resolves.toBe(false);
  expect(next).not.toHaveBeenCalled();
  finish(true);
  await expect(queued).resolves.toBe(true);
});

test("abort settlement removes listeners on completion and propagates a live failure", async () => {
  const abort = new AbortController();
  const removed = vi.spyOn(abort.signal, "removeEventListener");
  await expect(declineOnAbort(Promise.resolve(true), abort.signal)).resolves.toBe(true);
  await expect(declineOnAbort(Promise.reject(new Error("failed")), abort.signal)).rejects.toThrow(
    "failed",
  );
  const nonError = vi.fn<() => Promise<boolean>>().mockRejectedValue("invalid rejection");
  await expect(declineOnAbort(nonError(), abort.signal)).rejects.toThrow(
    "Confirmation presentation failed",
  );
  expect(removed).toHaveBeenCalledTimes(3);
  abort.abort();
  await expect(declineOnAbort(Promise.resolve(true), abort.signal)).resolves.toBe(false);
  await expect(
    declineOnAbort(Promise.reject(new Error("late failure")), abort.signal),
  ).resolves.toBe(false);
});
