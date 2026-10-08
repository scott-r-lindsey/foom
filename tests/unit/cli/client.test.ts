import { createServer } from "node:http";
import { mkdtemp, rm, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { endpoint, inherited, profilePath, call, pair, exchange } from "../../../src/cli/client";
import { command } from "../../../src/cli/commands";
import { ControlRuntime } from "../../../src/main/control/runtime";
import { atomicPrivate, privateDirectory } from "../../../src/node-common/private-files";
const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
it("rejects inherited partial credentials without discovery or privilege fallback", () => {
  expect(inherited({})).toBeUndefined();
  for (const env of [
    { FOOM_SESSION: "id" },
    { FOOM_CONTROL_TOKEN: "bad" },
    { FOOM_CONTROL_URL: "http://example.com" },
    { FOOM_CONTROL_TOKEN: "a".repeat(64) },
  ])
    expect(() => inherited(env)).toThrow();
  const env = {
    FOOM_CONTROL_URL: "http://127.0.0.1:1234/control/v1",
    FOOM_CONTROL_TOKEN: "a".repeat(64),
    FOOM_CONTROL_INSTANCE: "instance",
  };
  expect(inherited(env)).toMatchObject({ token: env.FOOM_CONTROL_TOKEN });
  for (const value of [
    "https://127.0.0.1:1234/control/v1",
    "http://localhost:1234/control/v1",
    "http://127.0.0.1/control/v1",
    "http://user@127.0.0.1:1234/control/v1",
    "http://127.0.0.1:1234/control/v1?q=x",
    "http://127.0.0.1:1234/control/v1#x",
    "http://127.0.0.1:1234/other",
    "http://127.0.0.1:01234/control/v1",
  ])
    expect(() => endpoint(value)).toThrow();
  expect(profilePath({ APPDATA: tmpdir() }, "win32")).toBe(join(tmpdir(), "Foom"));
  expect(profilePath({}, "darwin")).toContain("Application Support");
  expect(profilePath({}, "linux")).toContain(".config");
  expect(profilePath({ XDG_CONFIG_HOME: tmpdir() }, "linux")).toBe(join(tmpdir(), "Foom"));
  expect(() => profilePath({}, "win32")).toThrow("unavailable");
  expect(() => profilePath({ XDG_CONFIG_HOME: "relative" }, "linux")).toThrow("unavailable");
});
it("maps only known bounded argv to existing API schemas", () => {
  expect(command(["whoami"])).toEqual({ method: "whoami", params: {} });
  expect(command(["sessions", "--cursor", "id", "--limit", "100"])).toEqual({
    method: "sessions",
    params: { cursor: "id", limit: 100 },
  });
  expect(command(["sessions"])).toEqual({ method: "sessions", params: {} });
  expect(command(["session-state", "id"])).toEqual({
    method: "session_state",
    params: { id: "id" },
  });
  for (const [flag, key] of [
    ["--operation-id", "operationId"],
    ["--idempotency-key", "idempotencyKey"],
  ])
    expect(command(["operation-status", flag ?? "", "id"]).params).toEqual({ [key ?? ""]: "id" });
  for (const args of [
    [],
    Array<string>(17).fill("x"),
    ["x".repeat(4097)],
    ["whoami", "extra"],
    ["sessions", "--limit", "101"],
    ["sessions", "--limit", "0"],
    ["sessions", "--cursor"],
    ["sessions", "--cursor", "a", "--cursor", "b"],
    ["sessions", "--limit", "1", "--limit", "2"],
    ["session-state", "../foreign"],
    ["operation-status", "--role", "admin"],
  ])
    expect(() => command(args)).toThrow("invalid_request");
});
it("negotiates the instance, pairs on the pending connection, and calls the same scoped service", async () => {
  const root = await mkdtemp(join(tmpdir(), "foom-cli-"));
  scratch.push(root);
  const runtime = await ControlRuntime.start(root, () => [], {
    repository: (path) => (path === root ? root : undefined),
    approve: () => Promise.resolve(true),
  });
  try {
    const codes: string[] = [];
    const connection = await pair(root, root, (code) => {
      codes.push(code);
    });
    expect(codes).toHaveLength(1);
    expect(await call(connection, command(["whoami"]))).toMatchObject({ role: "cli" });
    expect(await call(connection, command(["sessions"]))).toEqual({
      sessions: [],
      nextCursor: null,
    });
    await expect(call(connection, command(["session-state", "foreign"]))).rejects.toThrow(
      "not_found",
    );
    await expect(
      call(connection, command(["operation-status", "--operation-id", "id"])),
    ).rejects.toThrow("forbidden");
    await expect(call({ ...connection, instanceId: "old" }, command(["whoami"]))).rejects.toThrow(
      "invalid_request",
    );
    await expect(call({ ...connection, token: "invalid" }, command(["whoami"]))).rejects.toThrow(
      "unauthorized",
    );
  } finally {
    await runtime.close();
  }
});
it("refuses insecure and redirected discovery and invalid pairing paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "foom-cli-"));
  scratch.push(root);
  const directory = await privateDirectory(root);
  await atomicPrivate(directory, "discovery.json", {
    version: 1,
    endpoint: "http://127.0.0.1:9/control/v1",
    instanceId: "old",
  });
  for (const [profile, repo] of [
    ["relative", root],
    [root, "relative"],
    [root, "/line\nfeed"],
  ])
    await expect(pair(profile ?? "", repo ?? "", () => {})).rejects.toThrow("invalid_request");
  if (process.platform !== "win32") {
    await chmod(join(directory, "discovery.json"), 0o644);
    await expect(pair(root, root, () => {})).rejects.toThrow("unavailable");
    await rm(join(directory, "discovery.json"));
    await symlink(join(root, "absent"), join(directory, "discovery.json"));
    await expect(pair(root, root, () => {})).rejects.toThrow();
  }
  await expect(exchange("http://127.0.0.1:1/control/v1", {})).rejects.toThrow("unavailable");
});
it("bounds replies, refuses redirects and malformed JSON, and does not print server error text", async () => {
  let status = 200;
  let data = '{"result":{}}';
  const server = createServer((_req, res) => {
    res.writeHead(status);
    res.end(data);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("address");
  const connection = {
    endpoint: `http://127.0.0.1:${String(address.port)}/control/v1`,
    token: "a".repeat(64),
    instanceId: "id",
  };
  try {
    expect(await call(connection, command(["whoami"]))).toEqual({});
    for (const value of ["{", "{}", '{"unexpected":true}', '{"error":"SECRET raw exception"}']) {
      data = value;
      await expect(call(connection, command(["whoami"]))).rejects.toThrow();
    }
    data = "x".repeat(65537);
    await expect(call(connection, command(["whoami"]))).rejects.toThrow("unavailable");
    data = '{"result":{}}';
    status = 302;
    await expect(call(connection, command(["whoami"]))).rejects.toThrow("unavailable");
    status = 401;
    await expect(exchange(connection.endpoint, {}, undefined, () => {})).rejects.toThrow(
      "unauthorized",
    );
    status = 403;
    await expect(exchange(connection.endpoint, {}, undefined, () => {})).rejects.toThrow(
      "forbidden",
    );
    status = 429;
    await expect(exchange(connection.endpoint, {}, undefined, () => {})).rejects.toThrow(
      "capacity",
    );
    status = 500;
    await expect(exchange(connection.endpoint, {}, undefined, () => {})).rejects.toThrow(
      "unavailable",
    );
    status = 200;
    data = "{\n";
    await expect(exchange(connection.endpoint, {}, undefined, () => {})).rejects.toThrow(
      "invalid_request",
    );
  } finally {
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
});

it("rejects interrupted responses instead of accepting partial JSON", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-length": "1000" });
    res.write('{"result":');
    setImmediate(() => {
      res.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("address");
  try {
    await expect(exchange(`http://127.0.0.1:${String(address.port)}`, {})).rejects.toThrow(
      "unavailable",
    );
  } finally {
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
});
