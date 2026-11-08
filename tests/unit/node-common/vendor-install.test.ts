import { EventEmitter } from "node:events";
import { readFile, stat, access } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import { downloadVendorScript, runVendorScript } from "../../../src/node-common/vendor-install";

const script = {
  url: "https://vendor.test/install",
  interpreter: "bash",
  arguments: ["stable"],
} as const;
const signal = () => AbortSignal.timeout(5000);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
beforeEach(() => {
  mocks.spawn.mockReset();
});

test("downloads fixture bytes with manual HTTPS redirects and bounded transport", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/actual" } }))
    .mockResolvedValueOnce(new Response("fixture installer"));
  const abort = signal();
  expect(new TextDecoder().decode(await downloadVendorScript(script.url, abort, request))).toBe(
    "fixture installer",
  );
  expect(request).toHaveBeenNthCalledWith(2, new URL("https://vendor.test/actual"), {
    signal: abort,
    redirect: "manual",
  });
});
test.each([
  "http://vendor.test/install",
  "https://user:secret@vendor.test/install",
  "https://vendor.test/install#fragment",
])("refuses unsafe address %s before requesting", async (url) => {
  const request = vi.fn<typeof fetch>();
  await expect(downloadVendorScript(url, signal(), request)).rejects.toThrow("HTTPS");
  expect(request).not.toHaveBeenCalled();
});
test("refuses downgrade before contacting an HTTP redirect target", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(null, { status: 301, headers: { location: "http://vendor.test/install" } }),
    );
  await expect(downloadVendorScript(script.url, signal(), request)).rejects.toThrow("HTTPS");
  expect(request).toHaveBeenCalledTimes(1);
});
test("bounds redirects and refuses missing, unsuccessful, empty and oversized downloads", async () => {
  const loop = vi
    .fn<typeof fetch>()
    .mockImplementation(() =>
      Promise.resolve(new Response(null, { status: 307, headers: { location: script.url } })),
    );
  await expect(downloadVendorScript(script.url, signal(), loop)).rejects.toThrow("redirects");
  expect(loop).toHaveBeenCalledTimes(6);
  for (const response of [
    new Response(null, { status: 302 }),
    new Response("error", { status: 503 }),
    new Response(null),
    new Response(""),
    new Response(new Uint8Array(2 * 1024 * 1024 + 1)),
  ]) {
    await expect(
      downloadVendorScript(script.url, signal(), vi.fn<typeof fetch>().mockResolvedValue(response)),
    ).rejects.toThrow();
  }
});
test.each([0, 7, null, "error"])(
  "executes private fixture script with fixed argv, preserves status %s and always cleans up",
  async (code) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("fixture script")));
    let path: string | undefined;
    let inspecting: Promise<void> | undefined;
    mocks.spawn.mockImplementation((command: string, args: readonly string[], options: unknown) => {
      path = args[0];
      const child = new EventEmitter();
      inspecting = (async () => {
        if (!path) throw new Error("Missing fixture script");
        expect(command).toBe("/bin/bash");
        expect(args.slice(1)).toEqual(["stable"]);
        expect(options).toMatchObject({
          cwd: "/fixture/home",
          env: { PATH: "/fixture" },
          shell: false,
          stdio: "inherit",
        });
        expect(await readFile(path, "utf8")).toBe("fixture script");
        if (process.platform !== "win32") {
          expect((await stat(path)).mode & 0o777).toBe(0o600);
          expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
        }
        if (code === "error") child.emit("error", new Error("fixture spawn failure"));
        child.emit("close", code === "error" ? null : code);
      })();
      return child;
    });
    expect(await runVendorScript(script, "/fixture/home", { PATH: "/fixture" })).toBe(
      code === "error" || code === null ? 1 : code,
    );
    await inspecting;
    if (!path) throw new Error("Missing spawned script");
    await expect(access(dirname(path))).rejects.toThrow();
  },
);
test("download failures run nothing and never disclose untrusted error text", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockRejectedValue(new Error("private remote content")),
  );
  const error = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  expect(await runVendorScript(script, "/fixture/home", {})).toBe(1);
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith("Installer download or execution failed\n");
});

test("a local HTTPS fixture server exercises redirects and failed downloads without vendor traffic", async ({
  onTestFinished,
}) => {
  const { createServer } = await import("node:https");
  const { get } = await import("node:https");
  const key = await readFile("tests/fixtures/vendor-installer/key.pem");
  const cert = await readFile("tests/fixtures/vendor-installer/cert.pem");
  const server = createServer({ key, cert }, (request, response) => {
    if (request.url === "/start") response.writeHead(302, { location: "/script" }).end();
    else if (request.url === "/script") response.end("#!/bin/sh\nexit 7\n");
    else if (request.url === "/downgrade")
      response.writeHead(302, { location: "http://127.0.0.1/never" }).end();
    else response.writeHead(503).end();
  });
  onTestFinished(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  );
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const request: typeof fetch = (input) =>
    new Promise<Response>((resolve, reject) => {
      const client = get(input instanceof Request ? input.url : input, { ca: cert }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        incoming.on("end", () => {
          resolve(
            new Response(Buffer.concat(chunks).toString("utf8"), {
              status: incoming.statusCode ?? 500,
              headers: incoming.headers.location ? { location: incoming.headers.location } : {},
            }),
          );
        });
        incoming.on("error", reject);
      });
      client.on("error", reject);
    });
  const base = `https://127.0.0.1:${String(address.port)}`;
  expect(
    new TextDecoder().decode(await downloadVendorScript(`${base}/start`, signal(), request)),
  ).toContain("exit 7");
  await expect(downloadVendorScript(`${base}/downgrade`, signal(), request)).rejects.toThrow(
    "HTTPS",
  );
  await expect(downloadVendorScript(`${base}/failure`, signal(), request)).rejects.toThrow(
    "failed",
  );
});

test("handled interruption aborts the script and removes its private download and signal handlers", async () => {
  const before = process.listeners("SIGTERM");
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("fixture script")));
  let path: string | undefined;
  mocks.spawn.mockImplementation(
    (_command: string, args: readonly string[], options: { signal: AbortSignal }) => {
      path = args[0];
      const child = new EventEmitter();
      options.signal.addEventListener(
        "abort",
        () => {
          child.emit("error", new Error("fixture interrupted"));
          child.emit("close", null);
        },
        { once: true },
      );
      queueMicrotask(() => {
        // Invoke only this recipe's newly registered handler, preserving the test runner's handlers.
        const interrupt = process
          .listeners("SIGTERM")
          .find((listener) => !before.includes(listener));
        if (!interrupt) throw new Error("Missing recipe interruption handler");
        interrupt("SIGTERM");
      });
      return child;
    },
  );
  expect(await runVendorScript(script, "/fixture/home", {})).toBe(1);
  if (!path) throw new Error("Missing fixture script");
  await expect(access(dirname(path))).rejects.toThrow();
  expect(process.listeners("SIGTERM")).toEqual(before);
});
