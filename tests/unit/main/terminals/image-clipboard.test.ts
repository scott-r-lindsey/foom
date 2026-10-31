import { expect, test, vi } from "vitest";
const read = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({ clipboard: { read } }));
import { readPaste } from "../../../../src/main/terminals/image-clipboard";
import { IMAGE_BYTES } from "../../../../src/shared/image-paste";
function item(payload: Record<string, Blob>) {
  return {
    types: Object.keys(payload),
    getType: vi.fn((type: string) => Promise.resolve(payload[type])),
  };
}
test("one clipboard snapshot gives nonempty plain text precedence over every image", async () => {
  const image = item({ "image/png": new Blob([new Uint8Array([1])]) });
  for (const text of ["hello", " \n "]) {
    read.mockResolvedValue([image, item({ "text/plain": new Blob([text]) })]);
    expect(await readPaste()).toEqual({ kind: "text", text });
    expect(image.getType).not.toHaveBeenCalled();
  }
});
test("reads only one allowed bounded raster; never opens clipboard file references", async () => {
  read.mockResolvedValue([]);
  expect(await readPaste()).toEqual({ kind: "empty" });
  read.mockResolvedValue([item({ "text/plain": new Blob([""]) })]);
  expect(await readPaste()).toEqual({ kind: "empty" });
  const payload = new Uint8Array([1, 2, 3]);
  for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
    read.mockResolvedValue([item({ [type]: new Blob([payload]) })]);
    expect(await readPaste()).toEqual({ kind: "image", bytes: payload });
  }
  for (const items of [
    [item({ "image/svg+xml": new Blob(["<svg/>"]) })],
    [item({ "image/png": new Blob([]) })],
    [item({ "image/png": new Blob([new Uint8Array(IMAGE_BYTES + 1)]) })],
    [item({ "image/png": new Blob([payload]) }), item({ "image/png": new Blob([payload]) })],
    [item({ "text/uri-list": new Blob(["file:///secret"]), "image/png": new Blob([payload]) })],
    [item({ "electron application/file-list": new Blob([]) })],
  ]) {
    read.mockResolvedValue(items);
    expect(await readPaste()).toEqual({ kind: "failed" });
  }
  read.mockRejectedValue(new Error("clipboard denied"));
  await expect(readPaste()).rejects.toThrow();
});

test("clipboard reads have an abort signal and a five-second deadline", async () => {
  vi.useFakeTimers();
  try {
    read.mockReturnValue(new Promise(() => {}));
    const cancel = new AbortController();
    const cancelled = expect(readPaste(cancel.signal)).rejects.toThrow("unavailable");
    cancel.abort();
    await cancelled;
    const deadline = expect(readPaste()).rejects.toThrow("unavailable");
    await vi.advanceTimersByTimeAsync(5000);
    await deadline;
    await expect(readPaste(cancel.signal)).rejects.toThrow("cancelled");
  } finally {
    vi.useRealTimers();
  }
});
