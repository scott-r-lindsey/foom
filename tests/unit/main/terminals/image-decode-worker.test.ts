import { afterEach, expect, test, vi } from "vitest";
const decode = vi.hoisted(() => vi.fn());
vi.mock("../../../../src/main/terminals/image-decode", () => ({ decodeImage: decode }));
afterEach(() => vi.unstubAllGlobals());
test("one-use decoder worker rejects nonbytes and reports decode failure without content", async () => {
  for (const input of [null, new Uint8Array([1]), new Uint8Array([2])]) {
    vi.resetModules();
    let receive: ((event: { data: unknown }) => void) | undefined;
    const port = {
      postMessage: vi.fn(),
      on: vi.fn((_name: string, fn: typeof receive) => {
        receive = fn;
      }),
    };
    vi.stubGlobal("process", { parentPort: port });
    decode.mockReset();
    if (input instanceof Uint8Array && input[0] === 1) decode.mockResolvedValue(input);
    else decode.mockRejectedValue(new Error("private"));
    await import("../../../../src/main/terminals/image-decode-worker");
    receive?.({ data: input });
    receive?.({ data: new Uint8Array([9]) });
    await Promise.resolve();
    expect(port.postMessage).toHaveBeenCalledExactlyOnceWith(
      input instanceof Uint8Array && input[0] === 1 ? input : null,
    );
  }
});
