import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { beforeEach, expect, test, vi } from "vitest";
const mock = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("node:https", () => ({ get: mock.get }));
import { getUpdateRelease } from "../../../src/main/update-http";

let callback: (response: IncomingMessage) => void;
let request: EventEmitter & {
  destroy: ReturnType<typeof vi.fn>;
  setTimeout: ReturnType<typeof vi.fn>;
};
let response: EventEmitter & {
  statusCode: number;
  resume: ReturnType<typeof vi.fn>;
  setEncoding: ReturnType<typeof vi.fn>;
};
beforeEach(() => {
  request = Object.assign(new EventEmitter(), {
    destroy: vi.fn((error: Error) => {
      request.emit("error", error);
      request.emit("close");
    }),
    setTimeout: vi.fn(),
  });
  response = Object.assign(new EventEmitter(), {
    statusCode: 200,
    resume: vi.fn(),
    setEncoding: vi.fn(),
  });
  mock.get.mockImplementation((_url: string, _options: unknown, done: typeof callback) => {
    callback = done;
    return request;
  });
});
const url = "https://api.github.com/repos/scott-r-lindsey/foom/releases/latest";
const signal = () => new AbortController().signal;
function respond(status = 200, body = "{}") {
  response.statusCode = status;
  callback(response as unknown as IncomingMessage);
  response.emit("data", body);
  response.emit("end");
  request.emit("close");
}

test("anonymous GET sends version/platform only, with cancellation and a deadline", async () => {
  const abort = signal();
  const result = getUpdateRelease("0.1.0", "linux", url, abort);
  expect(mock.get).toHaveBeenCalledWith(
    url,
    {
      signal: abort,
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Foom/0.1.0 (linux)" },
    },
    expect.any(Function),
  );
  respond(200, '{"tag_name":"v0.2.0"}');
  await expect(result).resolves.toEqual({ tag_name: "v0.2.0" });
  expect(request.setTimeout).toHaveBeenCalledWith(15000, expect.any(Function));
});
test.each([
  "http://api.github.com/repos/scott-r-lindsey/foom/releases/latest",
  url + "?token=secret",
  url + "/other",
  "https://evil.example/",
])("refuses arbitrary endpoint %s", async (endpoint) => {
  await expect(getUpdateRelease("0.1.0", "linux", endpoint, signal())).rejects.toThrow(
    "Invalid update endpoint",
  );
  expect(mock.get).not.toHaveBeenCalled();
});
test("missing stable release is quiet", async () => {
  const result = getUpdateRelease("0.1.0", "linux", url, signal());
  respond(404);
  await expect(result).resolves.toBeNull();
  expect(response.resume).toHaveBeenCalled();
});
test.each([301, 403, 500])(
  "HTTP %i never follows redirects or forwards server errors",
  async (status) => {
    const result = getUpdateRelease("0.1.0", "linux", url, signal());
    respond(status, "secret");
    await expect(result).rejects.toThrow("Update check failed");
  },
);
test("invalid JSON and oversized bodies fail closed", async () => {
  let result = getUpdateRelease("0.1.0", "linux", url, signal());
  respond(200, "secret");
  await expect(result).rejects.toThrow("Invalid update response");
  result = getUpdateRelease("0.1.0", "linux", url, signal());
  respond(200, "x".repeat(262145));
  await expect(result).rejects.toThrow("Update check failed");
});
test("request, response and timeout failures remain fixed local errors", async () => {
  let result = getUpdateRelease("0.1.0", "linux", url, signal());
  request.emit("error", new Error("secret"));
  await expect(result).rejects.toThrow("Update check failed");
  result = getUpdateRelease("0.1.0", "linux", url, signal());
  callback(response as unknown as IncomingMessage);
  response.emit("error", new Error("secret"));
  await expect(result).rejects.toThrow("Update check failed");
  result = getUpdateRelease("0.1.0", "linux", url, signal());
  const timeout: unknown = request.setTimeout.mock.calls[0]?.[1];
  const isCallback = (value: unknown): value is () => void => typeof value === "function";
  if (!isCallback(timeout)) throw new Error("Missing timeout");
  timeout();
  await expect(result).rejects.toThrow("Update check failed");
});

test("overall deadline also bounds a slowly streaming response", async () => {
  vi.useFakeTimers();
  try {
    const result = getUpdateRelease("0.1.0", "linux", url, signal());
    const rejected = expect(result).rejects.toThrow("Update check failed");
    callback(response as unknown as IncomingMessage);
    response.emit("data", "{");
    await vi.advanceTimersByTimeAsync(15000);
    await rejected;
  } finally {
    vi.useRealTimers();
  }
});

test.each([404, 500])(
  "discarded HTTP %i responses still absorb stream failures",
  async (status) => {
    const result = getUpdateRelease("0.1.0", "linux", url, signal());
    const settled =
      status === 404
        ? expect(result).resolves.toBeNull()
        : expect(result).rejects.toThrow("Update check failed");
    response.statusCode = status;
    callback(response as unknown as IncomingMessage);
    expect(() => response.emit("error", new Error("connection reset"))).not.toThrow();
    request.emit("close");
    await settled;
  },
);

test.each([200, 204])(
  "macOS metadata uses the fixed allowlisted endpoint, HTTP %i",
  async (status) => {
    const endpoint = "https://update.electronjs.org/scott-r-lindsey/foom/darwin-arm64/0.1.0";
    const result = getUpdateRelease("0.1.0", "darwin", endpoint, signal());
    respond(status, '{"url":"untrusted"}');
    await expect(result).resolves.toEqual(status === 204 ? null : { url: "untrusted" });
  },
);

test.each([
  "https://update.electronjs.org/other/foom/darwin-arm64/0.1.0",
  "https://update.electronjs.org/scott-r-lindsey/foom/darwin-arm64/0.1.0?next=evil",
  "https://update.electronjs.org/scott-r-lindsey/foom/darwin-arm64/0.1.0/extra",
])("rejects altered macOS metadata route %s", async (endpoint) => {
  await expect(getUpdateRelease("0.1.0", "darwin", endpoint, signal())).rejects.toThrow(
    "Invalid update endpoint",
  );
  expect(mock.get).not.toHaveBeenCalled();
});

test.each([
  "darwin-arm64/latest-mac.json",
  "darwin-x64/latest-mac.json",
  "linux-x64/latest.json",
  "win32-x64/latest.json",
])("allows only fixed nightly endpoint %s", async (path) => {
  const result = getUpdateRelease(
    "0.1.0-nightly.20261023+aaaaaaa",
    "darwin",
    `https://foom-term.com/updates/nightly/${path}`,
    signal(),
  );
  respond(200, '{"version":"nightly"}');
  await expect(result).resolves.toEqual({ version: "nightly" });
});
test.each([
  "https://foom-term.com/updates/nightly/darwin-arm64/latest-mac.json?evil=1",
  "https://foom-term.com.evil/updates/nightly/darwin-arm64/latest-mac.json",
  "https://foom-term.com/updates/nightly/darwin-arm64/../latest-mac.json",
  "https://foom-term.com/updates/nightly/win32-x64/RELEASES",
  "https://api.github.com/repos/scott-r-lindsey/foom/releases/tags/nightly",
])("refuses alternate nightly endpoint %s", async (endpoint) => {
  await expect(getUpdateRelease("0.1.0", "darwin", endpoint, signal())).rejects.toThrow();
  expect(mock.get).not.toHaveBeenCalled();
});

const proxy = "https://foom-term.com/u/v1/stable/linux/x64/0.1.0";
test.each(["", "?d=1", "?w=1", "?m=1", "?d=1&w=1", "?d=1&m=1", "?w=1&m=1", "?d=1&w=1&m=1"])(
  "allows only anonymous activity flags %s",
  async (flags) => {
    const result = getUpdateRelease("0.1.0", "linux", proxy + flags, signal());
    respond(200, '{"draft":false,"prerelease":false,"tag_name":"v0.1.0"}');
    await expect(result).resolves.toMatchObject({ tag_name: "v0.1.0" });
  },
);

test.each([
  proxy + "?d=0",
  proxy + "?d=1&d=1",
  proxy + "?id=123",
  proxy + "?m=1&d=1",
  proxy.replace("stable", "unknown"),
  proxy.replace("linux", "freebsd"),
  proxy.replace("x64", "unknown"),
  proxy.replace("0.1.0", "0.1.0/other"),
  proxy.replace("foom-term.com", "foom-term.com.evil"),
  proxy.replace("linux", "win32"),
  proxy.replace("0.1.0", "0.1.0-nightly.20261022%2Bbbbbbbb"),
])("rejects altered counting endpoint %s", async (endpoint) => {
  await expect(getUpdateRelease("0.1.0", "linux", endpoint, signal())).rejects.toThrow(
    "Invalid update endpoint",
  );
  expect(mock.get).not.toHaveBeenCalled();
});

test.each(["darwin", "linux", "win32"])(
  "allows stamped nightly counting route on %s",
  async (platform) => {
    const result = getUpdateRelease(
      "0.1.0-nightly.20261022+bbbbbbb",
      platform,
      `https://foom-term.com/u/v1/nightly/${platform}/arm64/0.1.0-nightly.20261022%2Bbbbbbbb?d=1&w=1&m=1`,
      signal(),
    );
    respond(200, "{}");
    await expect(result).resolves.toEqual({});
  },
);

test.each([301, 302, 400, 404, 429, 500, 503])(
  "proxy HTTP %i fails so the caller can use its upstream fallback",
  async (status) => {
    const result = getUpdateRelease("0.1.0", "linux", proxy, signal());
    respond(status, "remote secret");
    await expect(result).rejects.toThrow("Update check failed");
    expect(mock.get).toHaveBeenCalledOnce();
  },
);

test("proxy no-update and invalid metadata preserve upstream validation", async () => {
  let result = getUpdateRelease("0.1.0", "linux", proxy, signal());
  respond(204);
  await expect(result).resolves.toBeNull();
  result = getUpdateRelease("0.1.0", "linux", proxy, signal());
  respond(200, "secret");
  await expect(result).rejects.toThrow("Invalid update response");
  result = getUpdateRelease("0.1.0", "linux", proxy, signal());
  respond(200, "x".repeat(262145));
  await expect(result).rejects.toThrow("Update check failed");
});
