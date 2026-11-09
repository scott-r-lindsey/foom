import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
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
const platform = process.platform;
function fixtureChild() {
  return Object.assign(new EventEmitter(), {
    kill: vi.fn(),
    stdio: [null, null, null, new PassThrough(), new PassThrough()],
  });
}
afterEach(() => {
  Object.defineProperty(process, "platform", { value: platform });
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
      path = args[process.platform === "win32" ? 0 : 4];
      const child = fixtureChild();
      inspecting = (async () => {
        if (!path) throw new Error("Missing fixture script");
        expect(command).toBe(platform === "win32" ? "/bin/bash" : "/bin/sh");
        expect(platform === "win32" ? args : args.slice(2)).toEqual(
          platform === "win32" ? [path, "stable"] : ["foom-installer", "/bin/bash", path, "stable"],
        );
        expect(options).toMatchObject({
          cwd: "/fixture/home",
          env: { PATH: "/fixture" },
          shell: false,
          stdio:
            platform === "win32" ? "inherit" : ["inherit", "inherit", "inherit", "pipe", "pipe"],
        });
        expect(await readFile(path, "utf8")).toBe("fixture script");
        if (process.platform !== "win32") {
          expect((await stat(path)).mode & 0o777).toBe(0o600);
          expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
        }
        if (code === "error") child.emit("error", new Error("fixture spawn failure"));
        if (typeof code === "number")
          child.stdio[3]?.emit("data", Buffer.from(`${String(code)}\n`));
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

test.skipIf(platform === "win32").each(["SIGHUP", "SIGINT", "SIGTERM", "SIGQUIT"] as const)(
  "handled %s terminates the installer group and removes private files and handlers",
  async (signal) => {
    const before = process.listeners(signal);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("fixture script")));
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    let hold: PassThrough | null | undefined;
    let path: string | undefined;
    mocks.spawn.mockImplementation((_command: string, args: readonly string[]) => {
      path = args[process.platform === "win32" ? 0 : 4];
      const child = Object.assign(fixtureChild(), { pid: 123456, kill: vi.fn() });
      hold = child.stdio[4];
      queueMicrotask(() => {
        const interrupt = process.listeners(signal).find((listener) => !before.includes(listener));
        if (!interrupt) throw new Error("Missing recipe interruption handler");
        interrupt(signal);
        child.stdio[3]?.emit("data", Buffer.from("129\n"));
        child.emit("close", null, signal);
      });
      return child;
    });
    const { constants } = await import("node:os");
    expect(await runVendorScript(script, "/fixture/home", {})).toBe(
      128 + constants.signals[signal],
    );
    expect(kill).not.toHaveBeenCalled();
    expect(hold?.destroyed).toBe(true);
    if (!path) throw new Error("Missing fixture script");
    await expect(access(dirname(path))).rejects.toThrow();
    expect(process.listeners(signal)).toEqual(before);
  },
);

test("interruption during download returns its signal status without spawning", async () => {
  const before = process.listeners("SIGHUP");
  vi.stubGlobal(
    "fetch",
    (_input: unknown, options: { signal: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          reject(new Error("fixture abort"));
        });
        queueMicrotask(() => {
          const interrupt = process
            .listeners("SIGHUP")
            .find((listener) => !before.includes(listener));
          if (!interrupt) throw new Error("Missing recipe handler");
          interrupt("SIGHUP");
        });
      }),
  );
  expect(await runVendorScript(script, "/fixture/home", {})).toBe(129);
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(process.listeners("SIGHUP")).toEqual(before);
});

test("signal exits preserve status even when the helper was not interrupted", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("fixture script")));
  mocks.spawn.mockImplementation(() => {
    const child = fixtureChild();
    queueMicrotask(() => {
      child.stdio[3]?.emit("data", Buffer.from("143\n"));
      child.emit("close", null, "SIGTERM");
    });
    return child;
  });
  expect(await runVendorScript(script, "/fixture/home", {})).toBe(143);
});

test.skipIf(platform === "win32")(
  "supervisor exit closes the lifetime pipe before waiting for the watcher",
  async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("fixture script")));
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    let path: string | undefined;
    mocks.spawn.mockImplementation((_command: string, args: readonly string[]) => {
      path = args[4];
      const child = Object.assign(fixtureChild(), { pid: 123456 });
      const hold = child.stdio[4];
      hold?.once("close", () => child.emit("close", null, "SIGKILL"));
      queueMicrotask(() => {
        child.emit("exit", null, "SIGKILL");
        expect(hold?.destroyed).toBe(true);
        expect(path && existsSync(path)).toBe(true);
      });
      return child;
    });
    expect(await runVendorScript(script, "/fixture/home", {})).toBe(1);
    expect(kill).not.toHaveBeenCalled();
    if (!path) throw new Error("Missing script");
    await expect(access(dirname(path))).rejects.toThrow();
  },
);

test("the unsupported Windows path uses the child fallback without POSIX process groups or QUIT", async () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("fixture script")));
  const before = process.listeners("SIGTERM");
  const beforeQuit = process.listeners("SIGQUIT");
  const killGroup = vi.spyOn(process, "kill").mockReturnValue(true);
  const killChild = vi.fn();
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(fixtureChild(), { pid: 123456, kill: killChild });
    queueMicrotask(() => {
      expect(process.listeners("SIGQUIT")).toEqual(beforeQuit);
      const interrupt = process.listeners("SIGTERM").find((listener) => !before.includes(listener));
      if (!interrupt) throw new Error("Missing recipe handler");
      interrupt("SIGTERM");
      child.emit("close", null, "SIGTERM");
    });
    return child;
  });
  expect(await runVendorScript(script, "/fixture/home", {})).toBe(143);
  expect(killGroup).not.toHaveBeenCalled();
  expect(killChild).toHaveBeenCalledWith("SIGTERM");
  expect(killChild).not.toHaveBeenCalledWith("SIGKILL");
});

test("an interruption during private-file cleanup still returns the signal status", async () => {
  vi.useFakeTimers();
  try {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("fixture script")));
    vi.spyOn(process, "kill").mockReturnValue(true);
    const before = process.listeners("SIGHUP");
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(fixtureChild(), { pid: 123456, kill: vi.fn() });
      queueMicrotask(() => {
        child.emit("close", 0, null);
        queueMicrotask(() => {
          const interrupt = process
            .listeners("SIGHUP")
            .find((listener) => !before.includes(listener));
          if (!interrupt) throw new Error("Missing recipe handler during cleanup");
          interrupt("SIGHUP");
        });
      });
      return child;
    });
    expect(await runVendorScript(script, "/fixture/home", {})).toBe(129);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test.skipIf(platform === "win32").each([0, 7])(
  "interpreter exit %s closes the lifetime pipe exactly once without signaling a numeric group",
  async (code) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("fixture script")));
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    let closeCount = 0;
    let leaderAlive = true;
    const aliveAtSignal: boolean[] = [];
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(fixtureChild(), { pid: 123456 });
      child.kill.mockImplementation(() => {
        aliveAtSignal.push(leaderAlive);
        return true;
      });
      const hold = child.stdio[4];
      if (!hold) throw new Error("Missing lifetime pipe");
      vi.spyOn(hold, "destroy").mockImplementation(() => {
        closeCount++;
        return hold;
      });
      queueMicrotask(() => {
        child.stdio[3]?.emit("data", Buffer.from(`${String(code)}\n`));
        leaderAlive = false;
        child.emit("exit", null, "SIGKILL");
        child.emit("close", null, "SIGKILL");
      });
      return child;
    });
    expect(await runVendorScript(script, "/fixture/home", {})).toBe(code);
    expect(closeCount).toBe(1);
    expect(aliveAtSignal).toEqual([true]);
    expect(kill).not.toHaveBeenCalled();
  },
);

test.skipIf(platform === "win32").each([
  { chunks: ["0", "\n"], expected: 0 },
  { chunks: ["bad\n"], expected: 1 },
  { chunks: ["256\n"], expected: 1 },
  { chunks: ["00000"], expected: 1 },
  { chunks: ["0\n", "7\n"], expected: 0 },
])(
  "bounds supervisor status frames and preserves only the first result: $chunks",
  async ({ chunks, expected }) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("fixture script")));
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(fixtureChild(), { pid: 123456 });
      queueMicrotask(() => {
        for (const chunk of chunks) child.stdio[3]?.emit("data", Buffer.from(chunk));
        child.emit("close", null, "SIGKILL");
      });
      return child;
    });
    expect(await runVendorScript(script, "/fixture/home", {})).toBe(expected);
    expect(kill).not.toHaveBeenCalled();
  },
);

test("spawn throws still remove the downloaded private script", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("fixture script")));
  let path: string | undefined;
  mocks.spawn.mockImplementation((_command: string, args: readonly string[]) => {
    path = args[platform === "win32" ? 0 : 4];
    throw new Error("fixture spawn throw");
  });
  expect(await runVendorScript(script, "/fixture/home", {})).toBe(1);
  if (!path) throw new Error("Missing fixture path");
  await expect(access(dirname(path))).rejects.toThrow();
});
