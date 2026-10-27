import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const mock = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("node:https", () => ({ get: mock.get }));
import {
  macUpdatePackage,
  nightlyUpdatePackage,
  prepareLocalUpdate,
} from "../../../src/main/update-package";

const archive =
  "https://github.com/scott-r-lindsey/foom/releases/download/v0.2.0/Foom-darwin-arm64-0.2.0.zip";
const cdn =
  "https://release-assets.githubusercontent.com/github-production-release-asset/1394006699/1234-abcd?token=asset";
let directory: string;
let requests: string[];
let request: PassThrough & {
  setTimeout: ReturnType<typeof vi.fn>;
};
let responses: Array<{
  status?: number;
  location?: string;
  body?: string | Buffer;
  error?: boolean;
}>;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "foom-update-test-"));
  requests = [];
  responses = [{ status: 200, body: "fake signed archive" }];
  mock.get.mockImplementation(
    (
      url: string,
      options: { signal: AbortSignal },
      callback: (response: IncomingMessage) => void,
    ) => {
      requests.push(url);
      const current = Object.assign(new PassThrough(), { setTimeout: vi.fn() });
      request = current;
      queueMicrotask(() => {
        const value = responses.shift();
        const response = Object.assign(new PassThrough(), {
          statusCode: value?.status,
          headers: { location: value?.location },
        });
        callback(response as unknown as IncomingMessage);
        if (value?.error) current.emit("error", new Error("private remote error"));
        else if (options.signal.aborted) current.emit("error", new Error("aborted"));
        else response.end(value?.body ?? "");
      });
      return current;
    },
  );
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;

test.each([
  null,
  {},
  { url: 5 },
  { url: "file:///tmp/archive.zip" },
  { url: archive.replace("https:", "http:") },
  { url: archive.replace("github.com/", "github.com.evil/") },
  { url: archive.replace("scott-r-lindsey/foom", "other/foom") },
  { url: archive.replace("v0.2.0/", "v0.3.0/") },
  { url: archive.replace("arm64", "x64") },
  { url: archive + "?next=evil" },
  { url: archive + "#evil" },
  { url: archive.replace("v0.2.0/", "v0.2.0/../v0.2.0/") },
])("rejects hostile or mismatched native metadata %j", (metadata) => {
  expect(() => macUpdatePackage(metadata, "arm64")).toThrow();
  expect(mock.get).not.toHaveBeenCalled();
});

test("ignores remote notes/name/delta; only a repository/version/architecture-bound ZIP can enter the local feed", async () => {
  const metadata = { url: archive, name: "wrong version", delta: { url: "https://evil/" } };
  const update = macUpdatePackage(metadata, "arm64");
  expect(update).toEqual({ url: archive, version: "0.2.0" });
  const local = await prepareLocalUpdate(directory, update, signal());
  const feed: unknown = JSON.parse(await readFile(fileURLToPath(local.url), "utf8"));
  const zip = join(fileURLToPath(new URL(".", local.url)), "update.zip");
  expect(feed).toEqual({
    currentRelease: "0.2.0",
    releases: [{ version: "0.2.0", updateTo: { url: new URL("update.zip", local.url).href } }],
  });
  expect(await readFile(zip, "utf8")).toBe("fake signed archive");
  if (process.platform !== "win32") expect((await stat(zip)).mode & 0o777).toBe(0o600);
  await local.dispose();
  expect(await readdir(directory)).toEqual([]);
});

test("follows only repository-scoped GitHub asset redirects and never forwards metadata credentials", async () => {
  responses = [
    { status: 302, location: cdn },
    { status: 200, body: "zip" },
  ];
  const local = await prepareLocalUpdate(
    directory,
    macUpdatePackage({ url: archive }, "arm64"),
    signal(),
  );
  expect(requests).toEqual([archive, cdn]);
  const options: unknown = mock.get.mock.calls[1]?.[1];
  expect(options).toEqual(expect.objectContaining({ headers: { Accept: "application/zip" } }));
  expect(options).toHaveProperty("signal", expect.any(AbortSignal));
  await local.dispose();
});

test.each([
  "https://evil.example/archive.zip",
  "http://release-assets.githubusercontent.com/github-production-release-asset/1394006699/abcd",
  cdn.replace("1394006699", "123"),
  cdn.replace("https://", "https://user:secret@"),
  cdn.replace(".com/", ".com:8443/"),
  cdn + "#fragment",
  "file:///tmp/archive.zip",
  "/relative",
  "not a URL",
  undefined,
])("refuses redirect %s before a second request and removes partial files", async (location) => {
  responses = [{ status: 302, ...(location === undefined ? {} : { location }) }];
  await expect(
    prepareLocalUpdate(directory, macUpdatePackage({ url: archive }, "arm64"), signal()),
  ).rejects.toThrow("Update download failed");
  expect(requests).toEqual([archive]);
  expect(await readdir(directory)).toEqual([]);
});

test("bounds redirect loops, failed statuses and request failures", async () => {
  for (const values of [
    Array.from({ length: 4 }, () => ({ status: 302, location: cdn })),
    [{ status: 500 }],
    [{ error: true }],
    [{}],
  ]) {
    responses = values;
    await expect(
      prepareLocalUpdate(directory, macUpdatePackage({ url: archive }, "arm64"), signal()),
    ).rejects.toThrow("Update download failed");
    expect(await readdir(directory)).toEqual([]);
  }
});

test("pre-aborted downloads never open a network connection", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    prepareLocalUpdate(directory, macUpdatePackage({ url: archive }, "arm64"), controller.signal),
  ).rejects.toThrow();
  expect(mock.get).not.toHaveBeenCalled();
  expect(await readdir(directory)).toEqual([]);
});

test.each(["opt-out", "inactivity", "overall"])(
  "%s cancels an in-flight ZIP and leaves no native feed",
  async (failure) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    mock.get.mockImplementation((_url: string, options: { signal: AbortSignal }) => {
      const current = Object.assign(new PassThrough(), { setTimeout: vi.fn() });
      request = current;
      const abort = () => {
        current.destroy(new Error("cancelled"));
      };
      options.signal.addEventListener("abort", abort, { once: true });
      current.once("close", () => {
        options.signal.removeEventListener("abort", abort);
      });
      return current;
    });
    const result = prepareLocalUpdate(
      directory,
      macUpdatePackage({ url: archive }, "arm64"),
      controller.signal,
    );
    const rejected = expect(result).rejects.toThrow("Update download failed");
    await vi.waitFor(() => {
      expect(mock.get).toHaveBeenCalled();
    });
    if (failure === "opt-out") controller.abort();
    else if (failure === "overall") await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    else {
      const timeout: unknown = request.setTimeout.mock.calls[0]?.[1];
      const isCallback = (value: unknown): value is () => void => typeof value === "function";
      if (!isCallback(timeout)) throw new Error("Missing timeout");
      timeout();
    }
    await rejected;
    expect(await readdir(directory)).toEqual([]);
  },
);

test("a ZIP exceeding the byte limit is discarded before a feed exists", async () => {
  const oversized = Buffer.from("simulated oversized response");
  Object.defineProperty(oversized, "length", { value: 1024 * 1024 * 1024 + 1 });
  responses = [{ status: 200, body: oversized }];
  await expect(
    prepareLocalUpdate(directory, macUpdatePackage({ url: archive }, "arm64"), signal()),
  ).rejects.toThrow("Update download failed");
  expect(await readdir(directory)).toEqual([]);
});

class EndlessResponse extends Readable {
  readonly headers = { location: cdn };
  bytes = 0;
  reads = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(readonly statusCode = 302) {
    super();
  }

  override _read(): void {
    this.reads++;
    this.timer ??= setInterval(() => {
      const chunk = Buffer.alloc(1024);
      this.bytes += chunk.length;
      this.push(chunk);
    }, 1);
  }

  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    clearInterval(this.timer);
    done(error);
  }
}

test.each(["complete", "opt-out"])(
  "an endless allowed redirect is destroyed without reading; %s closes the entire chain",
  async (outcome) => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const redirect = new EndlessResponse();
    const zip = Object.assign(new PassThrough(), { statusCode: 200, headers: {} });
    const streams = [redirect, zip];
    const signals: AbortSignal[] = [];
    const clients: Array<PassThrough & { setTimeout: ReturnType<typeof vi.fn> }> = [];
    let responseIndex = 0;
    mock.get.mockImplementation(
      (
        url: string,
        options: { signal: AbortSignal },
        callback: (response: IncomingMessage) => void,
      ) => {
        if (url === cdn) expect(redirect.destroyed).toBe(true);
        signals.push(options.signal);
        const current = Object.assign(new PassThrough(), { setTimeout: vi.fn() });
        let timeout: ReturnType<typeof setTimeout> | undefined;
        current.setTimeout.mockImplementation((milliseconds: number, listener?: () => void) => {
          clearTimeout(timeout);
          if (listener) current.on("timeout", listener);
          if (milliseconds > 0)
            timeout = setTimeout(() => {
              current.emit("timeout");
            }, milliseconds);
          return current;
        });
        clients.push(current);
        const response = streams[responseIndex++];
        if (!response) throw new Error("Unexpected request");
        queueMicrotask(() => {
          callback(response as unknown as IncomingMessage);
          if (response === zip && outcome === "complete") zip.end("fixture ZIP");
        });
        return current;
      },
    );
    const pending = prepareLocalUpdate(
      directory,
      macUpdatePackage({ url: archive }, "arm64"),
      caller.signal,
    );
    const completed =
      outcome === "complete" ? pending : expect(pending).rejects.toThrow("Update download failed");
    await vi.waitFor(() => {
      expect(clients).toHaveLength(2);
    });
    expect(redirect.destroyed).toBe(true);
    expect(redirect.reads).toBe(0);
    if (outcome === "opt-out") caller.abort();
    await completed;
    if (outcome === "complete") {
      const local = await pending;
      await local.dispose();
      caller.abort(); // Opt-out after success cannot leave a previous hop draining.
    }
    expect(signals[0]).toBe(signals[1]);
    for (const internal of signals) {
      expect(internal.aborted).toBe(true);
      expect(getEventListeners(internal, "abort")).toHaveLength(0);
    }
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
    expect(clients.every((client) => client.destroyed)).toBe(true);
    expect(streams.every((stream) => stream.destroyed)).toBe(true);
    for (const client of clients) {
      expect(client.listenerCount("timeout")).toBe(0);
      expect(client.listenerCount("error")).toBe(0);
      expect(client.listenerCount("close")).toBe(0);
      expect(client.setTimeout).toHaveBeenLastCalledWith(0);
    }
    const bytes = redirect.bytes;
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000 + 1);
    expect(redirect.bytes).toBe(bytes);
    expect(bytes).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(await readdir(directory)).toEqual([]);
  },
);

test("headers arriving during opt-out are destroyed inside the same cancelled scope", async () => {
  vi.useFakeTimers();
  const caller = new AbortController();
  const response = new EndlessResponse();
  const signals: AbortSignal[] = [];
  mock.get.mockImplementation(
    (
      _url: string,
      options: { signal: AbortSignal },
      callback: (response: IncomingMessage) => void,
    ) => {
      const current = Object.assign(new PassThrough(), { setTimeout: vi.fn() });
      const headers = () => {
        callback(response as unknown as IncomingMessage);
      };
      signals.push(options.signal);
      options.signal.addEventListener("abort", headers, { once: true });
      return current;
    },
  );
  const pending = prepareLocalUpdate(
    directory,
    macUpdatePackage({ url: archive }, "arm64"),
    caller.signal,
  );
  const failed = expect(pending).rejects.toThrow("Update download failed");
  await vi.waitFor(() => {
    expect(signals).toHaveLength(1);
  });
  caller.abort();
  await failed;
  expect(response.destroyed).toBe(true);
  expect(response.reads).toBe(0);
  for (const internal of signals) expect(getEventListeners(internal, "abort")).toHaveLength(0);
  expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});

test.each([304, 404, 500])(
  "HTTP %i destroys an endless error body without draining it",
  async (status) => {
    vi.useFakeTimers();
    const response = new EndlessResponse(status);
    mock.get.mockImplementation(
      (_url: string, _options: unknown, callback: (response: IncomingMessage) => void) => {
        const current = Object.assign(new PassThrough(), { setTimeout: vi.fn() });
        queueMicrotask(() => {
          callback(response as unknown as IncomingMessage);
        });
        return current;
      },
    );
    await expect(
      prepareLocalUpdate(directory, macUpdatePackage({ url: archive }, "arm64"), signal()),
    ).rejects.toThrow("Update download failed");
    expect(response.destroyed).toBe(true);
    expect(response.reads).toBe(0);
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000 + 1);
    expect(response.bytes).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test.skipIf(process.platform !== "darwin")(
  "macOS Foundation can read the local feed and copy the local ZIP without HTTP",
  async () => {
    // These are the exact Foundation APIs used by the pinned Squirrel revision.
    // No updater, network URL, signing identity or real app profile is involved.
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { writeFile } = await import("node:fs/promises");
    const run = promisify(execFile);
    const source = join(directory, "file-urls.m");
    const executable = join(directory, "file-urls");
    const feed = join(directory, "feed.json");
    const zip = join(directory, "update.zip");
    await writeFile(feed, '{"currentRelease":"0.2.0","releases":[]}');
    await writeFile(zip, "fixture ZIP bytes");
    await writeFile(
      source,
      `
#import <Foundation/Foundation.h>
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSURL *feed = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[1]]];
    NSURL *zip = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[2]]];
    NSError *error = nil;
    NSData *metadata = [NSURLConnection sendSynchronousRequest:[NSURLRequest requestWithURL:feed] returningResponse:nil error:&error];
    NSDictionary *json = metadata ? [NSJSONSerialization JSONObjectWithData:metadata options:0 error:&error] : nil;
    if (![json[@"currentRelease"] isEqual:@"0.2.0"]) { fprintf(stderr, "Local feed failed: %s\\n", error.description.UTF8String); return 1; }
    dispatch_semaphore_t finished = dispatch_semaphore_create(0);
    __block int result = 2;
    NSURLSessionDownloadTask *task = [NSURLSession.sharedSession downloadTaskWithRequest:[NSURLRequest requestWithURL:zip] completionHandler:^(NSURL *location, NSURLResponse *response, NSError *error) {
      NSData *copied = location ? [NSData dataWithContentsOfURL:location] : nil;
      if ([copied isEqualToData:[@"fixture ZIP bytes" dataUsingEncoding:NSUTF8StringEncoding]]) result = 0;
      else fprintf(stderr, "Local ZIP failed: %s\\n", error.description.UTF8String);
      dispatch_semaphore_signal(finished);
    }];
    [task resume];
    if (dispatch_semaphore_wait(finished, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC))) return 3;
    return result;
  }
}
`,
    );
    await run(
      "/usr/bin/clang",
      ["-fobjc-arc", "-fblocks", "-framework", "Foundation", source, "-o", executable],
      { timeout: 10000 },
    );
    await expect(run(executable, [feed, zip], { timeout: 15000 })).resolves.toMatchObject({
      stdout: "",
    });
  },
  30000,
);

const nightlyMetadata = () => ({
  version: "0.1.0-nightly.20261023+aaaaaaa",
  commit: "a".repeat(40),
  commitDate: "2026-10-23T01:00:00Z",
  sha256: createHash("sha256").update("fake signed archive").digest("hex"),
  url: `https://foom-term.com/updates/nightly/artifacts/${"a".repeat(40)}/Foom-nightly-20261023-aaaaaaa-darwin-arm64.zip`,
});
test.each([
  null,
  {},
  { version: 2 },
  { ...nightlyMetadata(), version: "0.2.0" },
  Object.fromEntries(Object.entries(nightlyMetadata()).filter(([key]) => key !== "url")),
  Object.fromEntries(Object.entries(nightlyMetadata()).filter(([key]) => key !== "commit")),
  Object.fromEntries(Object.entries(nightlyMetadata()).filter(([key]) => key !== "commitDate")),
  Object.fromEntries(Object.entries(nightlyMetadata()).filter(([key]) => key !== "sha256")),
  { ...nightlyMetadata(), version: 2 },
  { ...nightlyMetadata(), commit: 2 },
  { ...nightlyMetadata(), commitDate: 2 },
  { ...nightlyMetadata(), commit: "bad" },
  { ...nightlyMetadata(), commitDate: "2026-99-99T00:00:00Z" },
  { ...nightlyMetadata(), commit: "b".repeat(40) },
  { ...nightlyMetadata(), commitDate: "invalid" },
  { ...nightlyMetadata(), commitDate: "2026-10-24T00:00:00Z" },
  { ...nightlyMetadata(), sha256: "bad" },
  { ...nightlyMetadata(), sha256: 5 },
  { ...nightlyMetadata(), url: nightlyMetadata().url + "?evil=1" },
  { ...nightlyMetadata(), url: nightlyMetadata().url.replace("arm64", "x64") },
])("rejects untrusted nightly archive metadata %j", (value) => {
  expect(() => nightlyUpdatePackage(value, "darwin", "arm64")).toThrow();
});
test("nightly archive is downloaded directly and checksum-verified before native handoff", async () => {
  const update = nightlyUpdatePackage(
    {
      ...nightlyMetadata(),
      currentRelease: "99.0.0",
      releases: [{ version: "99.0.0", updateTo: { url: "https://evil.example/archive.zip" } }],
      delta: { url: "https://evil.example/delta.zip" },
    },
    "darwin",
    "arm64",
  );
  const local = await prepareLocalUpdate(directory, update, signal());
  expect(requests).toEqual([update.url]);
  expect(JSON.parse(await readFile(fileURLToPath(local.url), "utf8"))).toEqual({
    currentRelease: "20261023.3600.0",
    releases: [
      { version: "20261023.3600.0", updateTo: { url: new URL("update.zip", local.url).href } },
    ],
  });
  await local.dispose();
  responses = [{ status: 200, body: "tampered" }];
  await expect(prepareLocalUpdate(directory, update, signal())).rejects.toThrow(
    "Update download failed",
  );
  expect(await readdir(directory)).toEqual([]);
});
test("nightly origin cannot redirect even to the stable GitHub CDN", async () => {
  responses = [{ status: 302, location: cdn }];
  await expect(
    prepareLocalUpdate(
      directory,
      nightlyUpdatePackage(nightlyMetadata(), "darwin", "arm64"),
      signal(),
    ),
  ).rejects.toThrow();
  expect(requests).toEqual([nightlyMetadata().url]);
  expect(await readdir(directory)).toEqual([]);
});
