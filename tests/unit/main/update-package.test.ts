import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const mock = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("node:https", () => ({ get: mock.get }));
import { macUpdatePackage, prepareLocalUpdate } from "../../../src/main/update-package";

const archive =
  "https://github.com/scott-r-lindsey/foom/releases/download/v0.2.0/Foom-darwin-arm64-0.2.0.zip";
const cdn =
  "https://release-assets.githubusercontent.com/github-production-release-asset/1394006699/1234-abcd?token=asset";
let directory: string;
let requests: string[];
let request: EventEmitter & {
  destroy: ReturnType<typeof vi.fn>;
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
      const current = Object.assign(new EventEmitter(), {
        destroy: vi.fn((error: Error) => current.emit("error", error)),
        setTimeout: vi.fn(),
      });
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
      const current = Object.assign(new EventEmitter(), {
        destroy: vi.fn((error: Error) => current.emit("error", error)),
        setTimeout: vi.fn(),
      });
      request = current;
      options.signal.addEventListener("abort", () => current.emit("error", new Error("cancelled")));
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
