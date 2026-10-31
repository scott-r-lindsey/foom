import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
const fork = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({ utilityProcess: { fork } }));
import { normalizeImage } from "../../../../src/main/terminals/image-decoder";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5ioAAAAASUVORK5CYII=",
  "base64",
);
class Decoder extends EventEmitter {
  kill = vi.fn();
  postMessage = vi.fn();
}
afterEach(() => vi.useRealTimers());
test("disposable utility decode returns only bounded PNG and kills on success/failure", async () => {
  for (const reply of [png, null, new Uint8Array(1)]) {
    const child = new Decoder();
    fork.mockReturnValue(child);
    const result = normalizeImage(png, new AbortController().signal);
    child.emit("spawn");
    expect(child.postMessage).toHaveBeenCalledWith(png);
    const assertion =
      reply === png
        ? expect(result).resolves.toEqual(png)
        : expect(result).rejects.toThrow("refused");
    child.emit("message", reply);
    await assertion;
    expect(child.kill).toHaveBeenCalledOnce();
  }
});
test("abort, early process exit and five-second deadline terminate decoding", async () => {
  for (const reason of ["abort", "exit", "timeout"]) {
    vi.useFakeTimers();
    const child = new Decoder();
    fork.mockReturnValue(child);
    const cancel = new AbortController();
    const result = normalizeImage(png, cancel.signal);
    const assertion = expect(result).rejects.toThrow();
    if (reason === "abort") cancel.abort();
    else if (reason === "exit") child.emit("exit", 1);
    else await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(child.kill).toHaveBeenCalledOnce();
  }
  const aborted = new AbortController();
  aborted.abort();
  await expect(normalizeImage(png, aborted.signal)).rejects.toThrow();
});
