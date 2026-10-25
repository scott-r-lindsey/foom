import * as Fs from "node:fs";
import { request } from "node:http";
import { stat, writeFile, rm } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import {
  AgentEndpoint,
  endpointRequest,
} from "../../../../src/terminal-host/remote/agent-endpoint";
import { parseAgentManifest } from "../../../../src/shared/agent-plugin-parser";
import claude from "../../../../src/shared/bundled-agents/claude.json";
import type { RemoteControlResult } from "../../../../src/shared/remote-agent";
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof Fs>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});
const endpoints: AgentEndpoint[] = [];
afterEach(() => {
  for (const endpoint of endpoints.splice(0)) endpoint.dispose();
});
const identity: RemoteControlResult = {
  type: "identity",
  alias: "11111111-1111-4111-8111-111111111111",
  role: "child",
  capabilities: ["whoami", "manual", "handoff"],
};
async function fixture(
  call: (method: string, params: unknown) => Promise<RemoteControlResult> = () =>
    Promise.resolve(identity),
) {
  const signal = vi.fn();
  const endpoint = new AgentEndpoint("claude", signal, call);
  endpoints.push(endpoint);
  const model = parseAgentManifest(JSON.stringify(claude), "bundled").model;
  for (const channel of model.hooks?.channels ?? []) endpoint.channels.set(channel.id, channel);
  await endpoint.listen();
  return { endpoint, signal, env: endpoint.env() };
}
function raw(
  endpoint: AgentEndpoint,
  body: string,
  headers: Record<string, string> = {},
  path = "/call",
  method = "POST",
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: endpoint.socket,
        path,
        method,
        headers: {
          Host: "localhost",
          "Content-Type": "application/json",
          Authorization: endpoint.token,
          ...headers,
        },
      },
      (res) => {
        res.resume();
        res.once("end", () => {
          resolve(res.statusCode ?? 0);
        });
      },
    );
    req.once("error", reject);
    req.end(body);
  });
}
test.skipIf(process.platform === "win32")(
  "authenticates independent launch credentials on a private Unix socket, reduces hooks locally and revokes on dispose",
  async () => {
    const call = vi.fn(() => Promise.resolve(identity));
    const f = await fixture(call);
    expect((await stat(f.endpoint.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(f.endpoint.socket)).mode & 0o777).toBe(0o600);
    expect(f.endpoint.token).not.toBe(f.endpoint.hookToken);
    expect(await endpointRequest("/call", { method: "whoami", params: {} }, f.env)).toEqual(
      identity,
    );
    expect(call).toHaveBeenCalledWith("whoami", {});
    const value = {
      channel: "lifecycle",
      payload: {
        session_id: "conversation",
        hook_event_name: "PermissionRequest",
        transcript_path: "/never/read",
        tool_input: "never relayed",
      },
    };
    expect(await endpointRequest("/hook", value, f.env)).toBeUndefined();
    expect(f.signal).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalId: "remote",
        action: "needs_input",
        conversationId: "conversation",
      }),
    );
    expect(JSON.stringify(f.signal.mock.calls)).not.toContain("never");
    expect(
      await raw(f.endpoint, JSON.stringify(value), { Authorization: f.endpoint.token }, "/hook"),
    ).toBe(401);
    expect(
      await raw(
        f.endpoint,
        JSON.stringify({ ...value, payload: { session_id: "foreign", hook_event_name: "Stop" } }),
        { Authorization: f.endpoint.hookToken },
        "/hook",
      ),
    ).toBe(400);
    expect(
      await raw(
        f.endpoint,
        JSON.stringify({
          ...value,
          payload: { session_id: "conversation", hook_event_name: "Unknown" },
        }),
        { Authorization: f.endpoint.hookToken },
        "/hook",
      ),
    ).toBe(204);
    f.endpoint.dispose();
    await expect(
      endpointRequest("/call", { method: "whoami", params: {} }, f.env),
    ).rejects.toThrow();
  },
);
test.skipIf(process.platform === "win32")(
  "rejects origins, foreign credentials, malformed JSON, oversized bodies, unknown fields and unsupported endpoints",
  async () => {
    const f = await fixture();
    for (const [headers, path, method, expected] of [
      [{ Authorization: "wrong" }, "/call", "POST", 401],
      [{ Origin: "https://example.test" }, "/call", "POST", 403],
      [{ Host: "other" }, "/call", "POST", 403],
      [{ "Content-Type": "text/plain" }, "/call", "POST", 400],
      [{ "Content-Length": "65537" }, "/call", "POST", 400],
      [{}, "/other", "POST", 403],
      [{}, "/call", "GET", 403],
    ] as const)
      expect(await raw(f.endpoint, "{}", headers, path, method)).toBe(expected);
    for (const body of [
      "not JSON",
      "null",
      "[]",
      "{}",
      '{"method":"whoami","params":{},"role":"orchestrator"}',
      '{"method":"whoami","params":[]}',
      JSON.stringify({ method: "x".repeat(65), params: {} }),
    ])
      expect(await raw(f.endpoint, body)).toBe(400);
    for (const body of ['{"payload":{}}', '{"channel":"unknown","payload":{}}'])
      expect(await raw(f.endpoint, body, { Authorization: f.endpoint.hookToken }, "/hook")).toBe(
        400,
      );
    expect(await raw(f.endpoint, "x".repeat(65537), { "Transfer-Encoding": "chunked" })).toBe(413);
    await expect(endpointRequest("/call", {}, {})).rejects.toThrow("unavailable");
    await expect(endpointRequest("/call", { text: "x".repeat(65537) }, f.env)).rejects.toThrow(
      "too large",
    );
    await writeFile(f.endpoint.folder("files") + "/not-a-socket", "data");
    await expect(
      endpointRequest(
        "/call",
        {},
        { ...f.env, FOOM_REMOTE_SOCKET: f.endpoint.directory + "/files/not-a-socket" },
      ),
    ).rejects.toThrow("unavailable");
  },
);
test.skipIf(process.platform === "win32")(
  "bounds concurrent calls and rechecks endpoint revocation after asynchronous hub work",
  async () => {
    const resolvers: ((result: RemoteControlResult) => void)[] = [];
    const f = await fixture(() => new Promise((resolve) => resolvers.push(resolve)));
    const pending = Array.from({ length: 4 }, () =>
      endpointRequest("/call", { method: "whoami", params: {} }, f.env),
    );
    await vi.waitFor(() => {
      expect(resolvers).toHaveLength(4);
    });
    expect(await raw(f.endpoint, '{"method":"whoami","params":{}}')).toBe(429);
    for (const resolve of resolvers.splice(0)) resolve(identity);
    expect(await Promise.all(pending)).toEqual(Array(4).fill(identity));
    const late = endpointRequest("/call", { method: "manual", params: {} }, f.env);
    const rejected = expect(late).rejects.toThrow();
    await vi.waitFor(() => {
      expect(resolvers).toHaveLength(1);
    });
    f.endpoint.dispose();
    resolvers[0]?.(identity);
    await rejected;
  },
);

test.skipIf(process.platform === "win32")(
  "cleanup failure cannot preserve a launch credential or prevent terminal exit",
  async () => {
    const f = await fixture();
    const remove = vi.mocked(Fs.rmSync).mockImplementationOnce(() => {
      throw new Error("inaccessible launch files");
    });
    expect(() => {
      f.endpoint.dispose();
    }).not.toThrow();
    remove.mockClear();
    await expect(
      endpointRequest("/call", { method: "whoami", params: {} }, f.env),
    ).rejects.toThrow();
    await rm(f.endpoint.directory, { recursive: true, force: true });
  },
);
