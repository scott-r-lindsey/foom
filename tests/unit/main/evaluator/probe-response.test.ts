import { expect, test, vi } from "vitest";
import { readLimited } from "../../../../src/main/evaluator/probe-response";

test("an oversized response still fails closed when cancelling its body also fails", async () => {
  const cancel = vi.fn(() => Promise.reject(new Error("transport cleanup failed")));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("too large"));
    },
    cancel,
  });
  await expect(readLimited(new Response(body), 4)).rejects.toThrow("Response too large");
  expect(cancel).toHaveBeenCalledOnce();
});
