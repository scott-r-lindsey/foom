import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { execute } from "../../../src/cli/execute";
import { ControlHttp } from "../../../src/main/control/http";
import { ControlService } from "../../../src/main/control/service";
import { Operations } from "../../../src/main/control/operations";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "fixture", version: "1" },
  },
};
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
const session = "00000000-0000-4000-8000-000000000001";
const base = {
  FOOM_CONTROL_TOKEN: "a".repeat(64),
  FOOM_SESSION: session,
  FOOM_CONTROL_URL: "http://127.0.0.1:1/control/v1",
};
async function run(env = base, messages: unknown[] = [], args = ["mcp"]) {
  const out = vi.fn<(text: string) => void>();
  const error = vi.fn();
  const code = await execute(
    args,
    "1",
    { out, error, input: Readable.from(messages.map((m) => `${JSON.stringify(m)}\n`)) },
    env,
    "foom",
  );
  return { code, out, error };
}
it.each([
  {},
  { ...base, FOOM_SESSION: undefined },
  { ...base, FOOM_CONTROL_TOKEN: undefined },
  { ...base, FOOM_CONTROL_URL: undefined },
  { ...base, FOOM_CONTROL_TOKEN: "bad" },
  { ...base, FOOM_SESSION: "bad" },
  { ...base, FOOM_CONTROL_URL: "http://localhost:1/control/v1" },
  { ...base, FOOM_CONTROL_URL: "http://127.0.0.1:1/control/v1?token=bad" },
])(
  "is inert with invalid credentials and never reads stdin or discovers/pairs: %s",
  async (env) => {
    const read = vi.fn(() => {
      throw Error("must not read");
    });
    const output = vi.fn();
    expect(
      await execute(
        ["mcp"],
        "1",
        { out: output, error: output, input: { [Symbol.asyncIterator]: read } },
        env,
        "foom",
      ),
    ).toBe(0);
    expect(read).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
  },
);
it("relays the authenticated MCP handshake, notifications and the launch role without disclosing credentials", async () => {
  const service: ControlService = new ControlService(
    new Operations(
      () => Promise.resolve(),
      (actor) => {
        service.assertActive(actor);
      },
    ),
  );
  const http = await ControlHttp.listen(service);
  cleanup.push(() => http.close());
  const launch = service.prepare(tmpdir(), tmpdir());
  launch.bind("terminal", true);
  const env = { ...base, ...launch.env, FOOM_CONTROL_URL: http.endpoint };
  const result = await run(env, [
    initialize,
    initialized,
    list,
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "whoami" } },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "operation_status", arguments: { operationId: "x" } },
    },
  ]);
  expect(result.code).toBe(0);
  expect(result.out).toHaveBeenCalledTimes(4);
  const text = result.out.mock.calls.map(([line]) => line).join("");
  expect(text).toContain('"name":"whoami"');
  expect(text).toContain('"role":"agent"');
  expect(text).toContain("call whoami to check");
  expect(text).not.toContain(env.FOOM_CONTROL_TOKEN);
  service.setRole("terminal", "orchestrator");
  const elevated = await run(env, [
    initialize,
    initialized,
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "whoami" } },
  ]);
  expect(elevated.code).toBe(0);
  expect(elevated.out.mock.calls.map(([line]) => line).join("")).toContain('"role":"orchestrator"');
  launch.dispose();
  expect((await run(env, [initialize])).code).toBe(4);
});
it("refuses extra arguments before reading stdin", async () => {
  expect((await run(base, [], ["mcp", "--repository", "/repo"])).code).toBe(2);
});
it.each(["redirect", "oversize", "malformed", "header", "error", "empty", "protocol"])(
  "fails closed on %s responses",
  async (failure) => {
    const server = createServer((_req, res) => {
      if (failure === "redirect") res.writeHead(302, { location: "http://localhost:1" }).end();
      else if (failure === "oversize") res.end("x".repeat(262145));
      else if (failure === "malformed") res.end("bad");
      else if (failure === "header")
        res.writeHead(200, { "mcp-session-id": "bad header!" }).end("{}");
      else if (failure === "error") res.destroy();
      else if (failure === "empty") res.writeHead(202).end();
      else res.writeHead(200, { "mcp-session-id": "id" }).end('{"result":{}}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(
      () =>
        new Promise((resolve) =>
          server.close(() => {
            resolve();
          }),
        ),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No port");
    const result = await run(
      { ...base, FOOM_CONTROL_URL: `http://127.0.0.1:${String(address.port)}/control/v1` },
      [initialize],
    );
    expect(result.code).toBe(failure === "empty" ? 0 : 4);
    if (result.code === 4)
      expect(result.error).toHaveBeenCalledWith("Foom MCP transport failed.\n");
  },
);
it.each(["x".repeat(65537), `${"x".repeat(65537)}\n`, "{}", "bad\n"])(
  "bounds and validates stdin",
  async (text) => {
    const code = await execute(
      ["mcp"],
      "1",
      { out: vi.fn(), error: vi.fn(), input: Readable.from([text]) },
      base,
      "foom",
    );
    expect(code).toBe(text === "bad\n" ? 4 : 2);
  },
);
it("bounds stalled requests", async () => {
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => {
    server.closeAllConnections();
    return new Promise((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No port");
  vi.useFakeTimers();
  try {
    const pending = run(
      { ...base, FOOM_CONTROL_URL: `http://127.0.0.1:${String(address.port)}/control/v1` },
      [initialize],
    );
    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBeGreaterThan(0);
    });
    await vi.advanceTimersByTimeAsync(65000);
    expect((await pending).code).toBe(4);
  } finally {
    vi.useRealTimers();
  }
});

it("preserves UTF-8 split across stdin chunks and refuses an incomplete trailing character", async () => {
  let received = "";
  const server = createServer((req, res) => {
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      received += chunk;
    });
    req.on("end", () => {
      res.writeHead(202).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise((resolve) =>
        server.close(() => {
          resolve();
        }),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No port");
  const bytes = Buffer.from('{"text":"é"}\n');
  const split = bytes.indexOf(0xc3) + 1;
  const io = {
    out: vi.fn(),
    error: vi.fn(),
    input: Readable.from([bytes.subarray(0, split), bytes.subarray(split)]),
  };
  expect(
    await execute(
      ["mcp"],
      "1",
      io,
      { ...base, FOOM_CONTROL_URL: `http://127.0.0.1:${String(address.port)}/control/v1` },
      "foom",
    ),
  ).toBe(0);
  expect(received).toBe('{"text":"é"}');
  expect(
    await execute(
      ["mcp"],
      "1",
      { ...io, input: Readable.from([Buffer.from([0xc3])]) },
      base,
      "foom",
    ),
  ).toBe(2);
});
