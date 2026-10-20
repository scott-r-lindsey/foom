import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { ProbeHttp } from "../../../../src/main/agents/probe-http";
import { AgentProbes } from "../../../../src/main/agents/probes";
import { execute } from "../../../../src/cli/execute";
import type { ConsoleIo } from "../../../../src/cli/types";
import { agentProvider } from "../../../../src/main/agents/providers/registry";
function post(
  url: string,
  body: string,
  token?: string,
  headers: Record<string, string> = {},
  method = "POST",
) {
  return new Promise<{ status: number | undefined; body: unknown }>((resolve, reject) => {
    const req = request(
      url,
      {
        method,
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () => {
          resolve({ status: response.statusCode, body: JSON.parse(text) });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
test("loopback probe endpoint enforces request boundaries and CLI credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "foom-probe-http-"));
  let release!: (value: { lines: string[]; title: string }) => void;
  const backend = {
    create: vi.fn(() => Promise.resolve("terminal")),
    stop: vi.fn(() => Promise.resolve()),
    kill: vi.fn(() => Promise.resolve()),
    reply: vi.fn(() => Promise.resolve()),
    screen: vi.fn(() => Promise.resolve({ lines: ["visible"], title: "title" })),
    show: vi.fn(() => Promise.resolve()),
    removed: vi.fn(),
  };
  const probes = new AgentProbes(backend, root, {
    environment: () => Promise.resolve({ PATH: "fixture" }),
    provider: () => Promise.resolve(agentProvider("claude")),
    scratch: () => Promise.resolve(join(root, "scratch")),
    prepare: () =>
      Promise.resolve({
        spec: { command: "fixture", args: [], cwd: root, cols: 80, rows: 24 },
        dispose: () => {},
      }),
  });
  const http = await ProbeHttp.listen(probes);
  const token = probes.grant();
  const io: ConsoleIo = {
    out: vi.fn(),
    error: vi.fn(),
    input: (async function* () {
      yield await Promise.resolve("");
    })(),
  };
  const env = { FOOM_CONFIG_TOKEN: token, FOOM_CONFIG_URL: http.url };
  try {
    expect((await post(http.url, "{}", undefined)).status).toBe(401);
    expect((await post(http.url, "{}", "bad")).status).toBe(401);
    expect(
      (await post(http.url, "{}", token, { origin: "https://untrusted.example" })).status,
    ).toBe(403);
    expect((await post(http.url, "{}", token, { host: "localhost" })).status).toBe(403);
    expect((await post(http.url, "{}", token, {}, "GET")).status).toBe(403);
    expect((await post(`${http.url}/foreign`, "{}", token)).status).toBe(403);
    expect((await post(http.url, "{}", token, { "content-type": "text/plain" })).status).toBe(400);
    expect((await post(http.url, "{", token)).body).toEqual({ error: "unavailable" });
    expect((await post(http.url, "x".repeat(65537), token)).status).toBe(413);
    expect((await post(http.url, '{"action":"screen","probe":"bad"}', token)).body).toEqual({
      error: "invalid_request",
    });
    expect(
      (await post(http.url, '{"action":"start","agent":"claude"}', "f".repeat(64))).body,
    ).toEqual({ error: "unauthorized" });
    expect(await execute(["agent", "probe", "start", "claude"], "1", io, env, "/foom")).toBe(0);
    const output = vi.mocked(io.out).mock.calls.at(-1)?.[0];
    if (!output) throw Error("Missing CLI output");
    const value: unknown = JSON.parse(output);
    if (
      typeof value !== "object" ||
      value === null ||
      !("result" in value) ||
      typeof value.result !== "object" ||
      value.result === null ||
      !("probe" in value.result) ||
      typeof value.result.probe !== "string"
    )
      throw Error("Missing ID");
    const id = value.result.probe;
    expect(await execute(["agent", "probe", "start", "claude"], "1", io, env, "/foom")).toBe(4);
    expect(await execute(["agent", "probe", "screen", "e".repeat(64)], "1", io, env, "/foom")).toBe(
      4,
    );
    expect(await execute(["agent", "probe", "screen", id], "1", io, env, "/foom")).toBe(0);
    expect(await execute(["agent", "probe", "screen", id], "1", io, {}, "/foom")).toBe(3);
    for (const url of [
      "https://127.0.0.1:123/probe/v1",
      "http://localhost:123/probe/v1",
      "http://127.0.0.1:123/probe/v1?x=1",
      "http://u:p@127.0.0.1:123/probe/v1",
      "http://127.0.0.1:123/foreign",
    ])
      expect(
        await execute(
          ["agent", "probe", "screen", id],
          "1",
          io,
          { ...env, FOOM_CONFIG_URL: url },
          "/foom",
        ),
      ).toBe(3);
    backend.screen.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    const pending = post(http.url, JSON.stringify({ action: "screen", probe: id }), token);
    await vi.waitFor(() => {
      expect(backend.screen).toHaveBeenCalledTimes(2);
    });
    expect((await post(http.url, "{}", token)).status).toBe(429);
    release({ lines: ["visible"], title: "title" });
    expect((await pending).status).toBe(200);
    await probes.revoke(token);
    expect(await execute(["agent", "probe", "screen", id], "1", io, env, "/foom")).toBe(3);
  } finally {
    await http.close();
    await rm(root, { recursive: true, force: true });
  }
});
