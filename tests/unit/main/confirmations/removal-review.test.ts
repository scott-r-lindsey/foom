import { expect, test, vi } from "vitest";
import { RemovalReview } from "../../../../src/main/confirmations/removal-review";
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
