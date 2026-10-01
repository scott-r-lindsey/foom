import { expect, test, vi } from "vitest";
import { events } from "../../../../src/main/evaluator/probe-stream";

test("oversized event streams fail closed even when transport cleanup rejects", async () => {
  const cancel = vi.fn(() => Promise.reject(new Error("transport cleanup failed")));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(1_048_577));
    },
    cancel,
  });
  const stream = events(body, new AbortController().signal);
  await expect(stream.next()).rejects.toThrow("The reply is too large");
  expect(cancel).toHaveBeenCalledOnce();
});

test("cancellation ends a stalled event stream even if its transport cannot clean up", async () => {
  const cancel = vi.fn(() => Promise.reject(new Error("transport cleanup failed")));
  const controller = new AbortController();
  const stream = events(new ReadableStream<Uint8Array>({ cancel }), controller.signal);
  const result = stream.next();
  controller.abort(new Error("Check cancelled"));
  await expect(result).rejects.toThrow("Check cancelled");
  expect(cancel).toHaveBeenCalledOnce();
});
