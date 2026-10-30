import { expect, test } from "vitest";
import {
  imageDimensions,
  imageLabel,
  imageNonce,
  imageUploadId,
  imagePut,
  imagePutResult,
  imagePng,
  IMAGE_BYTES,
} from "../../../src/shared/image-paste";
import {
  remoteRequest,
  remoteResponse,
  remoteFrame,
  RemoteFrames,
} from "../../../src/shared/remote-host-protocol";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5ioAAAAASUVORK5CYII=",
  "base64",
);
const put = {
  type: "image-put" as const,
  id: "session",
  owner: "a".repeat(64),
  upload: "b".repeat(32),
  size: png.length,
  sha256: "c".repeat(64),
  data: png.toString("base64"),
};
test("bounds normalized dimensions, signatures and recipient reference quoting", () => {
  expect(imagePng(png)).toBe(true);
  for (const bytes of [new Uint8Array(), new Uint8Array(IMAGE_BYTES + 1), new Uint8Array(33)])
    expect(imagePng(bytes)).toBe(false);
  for (const [width, height] of [
    [0, 1],
    [1, 0],
    [8193, 1],
    [1, 8193],
    [4001, 4000],
  ])
    expect(imageDimensions(width ?? 0, height ?? 0)).toBe(false);
  const oversized = Buffer.from(png);
  oversized.writeUInt32BE(8193, 16);
  expect(imagePng(oversized)).toBe(false);
  expect(imageDimensions(4000, 4000)).toBe(true);
  expect(imageLabel("/tmp/a b's/image.png")).toBe("[pasted image '/tmp/a b'\\''s/image.png'] ");
  expect(imageLabel("C:\\a b's\\image.png", true)).toBe("[pasted image 'C:\\a b''s\\image.png'] ");
  for (const path of ["", "a".repeat(4097), "/a\n", "/a\x1b", "/a\0"])
    expect(() => imageLabel(path)).toThrow();
  for (const invalid of [null, 1, "a", "z".repeat(64)]) {
    expect(imageNonce(invalid)).toBe(false);
    expect(imageUploadId(invalid)).toBe(false);
  }
});
test("closed bounded image management request and path result cross versioned frames", () => {
  expect(imagePut(put)).toBe(true);
  expect(remoteRequest(put)).toBe(true);
  const frames = new RemoteFrames();
  const result: unknown[] = [];
  frames.push(remoteFrame(put), (value) => result.push(value));
  expect(result).toEqual([put]);
  for (const value of [
    null,
    {},
    { ...put, extra: true },
    { ...put, type: "write" },
    { ...put, id: "../x" },
    { ...put, owner: "bad" },
    { ...put, upload: "bad" },
    { ...put, sha256: "bad" },
    { ...put, size: 0 },
    { ...put, size: IMAGE_BYTES + 1 },
    { ...put, size: 1.5 },
    { ...put, data: "?".repeat(put.data.length) },
    { ...put, data: put.data.slice(1) },
  ])
    expect(imagePut(value)).toBe(false);
  const reply = {
    type: "image-result",
    id: put.id,
    owner: put.owner,
    upload: put.upload,
    ok: true,
    path: `/home/user/.foom-host/images/${"d".repeat(32)}/image-${"e".repeat(32)}.png`,
  };
  expect(imagePutResult(reply)).toBe(true);
  expect(remoteResponse(reply)).toBe(true);
  expect(imagePutResult({ ...reply, ok: false, path: undefined })).toBe(true);
  for (const value of [
    null,
    {},
    { ...reply, type: "bad" },
    { ...reply, id: "../x" },
    { ...reply, owner: "bad" },
    { ...reply, upload: "bad" },
    { ...reply, extra: true },
    { ...reply, ok: 1 },
    { ...reply, path: "/home/../user/.foom-host/images/" },
    { ...reply, path: "/tmp/foo" },
    { ...reply, ok: false },
  ])
    expect(imagePutResult(value)).toBe(false);
});

test("cleanup retries only bounded transient failures and preserves the last failure", async () => {
  const { imageCleanup } = await import("../../../src/shared/image-paste");
  const { vi } = await import("vitest");
  vi.useFakeTimers();
  try {
    const busy = Object.assign(new Error("busy"), { code: "EBUSY" });
    const operation = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(busy)
      .mockRejectedValueOnce(busy)
      .mockResolvedValue(undefined);
    const pending = imageCleanup(operation);
    await vi.advanceTimersByTimeAsync(600);
    await pending;
    expect(operation).toHaveBeenCalledTimes(3);
    const failed = vi.fn<() => Promise<void>>().mockRejectedValue(busy);
    const rejected = expect(imageCleanup(failed)).rejects.toBe(busy);
    await vi.advanceTimersByTimeAsync(600);
    await rejected;
    expect(failed).toHaveBeenCalledTimes(3);
    await expect(imageCleanup(() => Promise.reject(new Error("unsafe")))).rejects.toThrow("unsafe");
  } finally {
    vi.useRealTimers();
  }
});

test("measured recipient metadata enables only the hand-checked built-in identities", async () => {
  const { imagePasteRecipient } = await import("../../../src/shared/image-paste");
  for (const agent of ["claude", "codex", "pi"]) expect(imagePasteRecipient(agent)).toBe(true);
  for (const agent of ["agy", "copilot", "opencode", "custom", "toString", "constructor"])
    expect(imagePasteRecipient(agent)).toBe(false);
});
