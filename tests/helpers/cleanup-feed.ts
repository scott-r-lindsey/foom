import type { CleanupFeed } from "../../src/shared/cleanup";

/** Follow the real scan's completion; the owning test supplies its deadline. */
export async function cleanupReady(feed: CleanupFeed): Promise<void> {
  if (feed.current().stage === "ready") return;
  const ready = Promise.withResolvers<undefined>();
  const unsubscribe = feed.subscribe(() => {
    if (feed.current().stage === "ready") ready.resolve(undefined);
  });
  try {
    await ready.promise;
  } finally {
    unsubscribe();
  }
}
