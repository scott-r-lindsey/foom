import { Readable, PassThrough } from "node:stream";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  boundedInput,
  observeRemote,
  remoteCli,
  remoteMcp,
} from "../../../../src/terminal-host/remote/agent-helper";
import { endpointRequest } from "../../../../src/terminal-host/remote/agent-endpoint";
import type { RemoteControlResult } from "../../../../src/shared/remote-agent";
vi.mock("../../../../src/terminal-host/remote/agent-endpoint", () => ({
  endpointRequest: vi.fn(),
}));
const identity: RemoteControlResult = {
  type: "identity",
  alias: "11111111-1111-4111-8111-111111111111",
  role: "child",
  capabilities: ["whoami", "manual", "handoff"],
};
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ah-"));
  vi.mocked(endpointRequest).mockReset().mockResolvedValue(identity);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function output() {
  const pipe = new PassThrough();
  const chunks: string[] = [];
  pipe.on("data", (bytes: Buffer) => chunks.push(bytes.toString()));
  return { pipe, text: () => chunks.join("") };
}
const input = (text: string) => Readable.from([text]);
test("bounds UTF-8 input before parsing or forwarding", async () => {
  expect(await boundedInput(Readable.from(["hello", Buffer.from(" 🌙")]))).toBe("hello 🌙");
  await expect(boundedInput(input("large"), 2)).rejects.toThrow("too large");
  await expect(boundedInput(Readable.from([42]))).rejects.toThrow("Invalid");
  await expect(boundedInput(Readable.from([Buffer.from([255])]))).rejects.toThrow();
});
test("observer is neutral, bounds payloads and allocates ordered sequence locally", async () => {
  const order = join(root, "order");
  await writeFile(order, "0");
  const out = output();
  await observeRemote(
    ["lifecycle", "stdin", "empty-json-first", "ordered", "Stop"],
    input('{"conversationId":"conversation"}'),
    out.pipe,
    { FOOM_HOOK_ORDER: order },
  );
  expect(out.text()).toBe("{}\n");
  expect(await readFile(order, "utf8")).toBe("1");
  expect(endpointRequest).toHaveBeenCalledWith(
    "/hook",
    {
      channel: "lifecycle",
      event: "Stop",
      sequence: "1",
      payload: { conversationId: "conversation" },
    },
    { FOOM_HOOK_ORDER: order },
  );
  await observeRemote(
    ["notify", "argv-last", "silent", "unordered", "codex", '{"type":"agent-turn-complete"}'],
    input("ignored"),
    out.pipe,
    {},
  );
  expect(endpointRequest).toHaveBeenLastCalledWith(
    "/hook",
    { channel: "notify", event: "", payload: { type: "agent-turn-complete" } },
    {},
  );
  vi.mocked(endpointRequest).mockClear();
  for (const args of [
    [],
    ["bad/channel", "stdin", "silent", "unordered"],
    ["channel", "external", "silent", "unordered"],
    ["channel", "stdin", "bad", "unordered"],
    ["channel", "stdin", "silent", "bad"],
    ["channel", "stdin", "silent", "ordered"],
  ])
    await observeRemote(args, input("{}"), out.pipe, {});
  for (const previous of ["invalid", "2147483647"]) {
    await writeFile(order, previous);
    await observeRemote(["lifecycle", "stdin", "silent", "ordered"], input("{}"), out.pipe, {
      FOOM_ORDER_lifecycle: order,
    });
  }
  await mkdir(order + ".lock");
  await observeRemote(["lifecycle", "stdin", "silent", "ordered"], input("{}"), out.pipe, {
    FOOM_ORDER_lifecycle: order,
  });
  await observeRemote(
    ["lifecycle", "stdin", "silent", "unordered"],
    input("not json"),
    out.pipe,
    {},
  );
  await observeRemote(
    ["notify", "argv-last", "silent", "unordered", "x".repeat(65537)],
    input(""),
    out.pipe,
    {},
  );
  await observeRemote(["notify", "argv-last", "silent", "unordered"], input(""), out.pipe, {});
  expect(endpointRequest).not.toHaveBeenCalled();
});
test("CLI handoff reads bounded stdin or regular files and exposes only supported commands", async () => {
  vi.mocked(endpointRequest).mockResolvedValue({
    type: "handoff",
    seq: 1,
    status: "done",
    timestamp: "2026-10-24T00:00:00.000Z",
  });
  const args = [
    "handoff",
    "--status",
    "done",
    "--summary-file",
    "-",
    "--idempotency-key",
    "report",
    "--link",
    "https://example.test/a",
    "--link",
    "https://example.test/b",
    "--review",
    '{"verdict":"clean"}',
    "--json",
  ];
  expect(await remoteCli(args, input("Report"))).toMatchObject({ seq: 1, status: "done" });
  expect(endpointRequest).toHaveBeenLastCalledWith("/call", {
    method: "handoff",
    params: {
      status: "done",
      summary: "Report",
      idempotencyKey: "report",
      links: ["https://example.test/a", "https://example.test/b"],
      review: { verdict: "clean" },
    },
  });
  const path = join(root, "summary");
  await writeFile(path, "From file");
  await remoteCli([
    "handoff",
    "--status",
    "done",
    "--summary-file",
    path,
    "--idempotency-key",
    "file",
  ]);
  expect(endpointRequest).toHaveBeenLastCalledWith("/call", {
    method: "handoff",
    params: { status: "done", summary: "From file", idempotencyKey: "file" },
  });
  vi.mocked(endpointRequest).mockResolvedValue(identity);
  expect(await remoteCli(["whoami", "--json"])).toMatchObject({ alias: identity.alias });
  await remoteCli(["manual", "--section", "intro", "--page", "1"]);
  expect(endpointRequest).toHaveBeenLastCalledWith("/call", {
    method: "manual",
    params: { section: "intro", page: 1 },
  });
  expect(await remoteCli(["sessions"])).toMatchObject({ error: "phase_2_restricted" });
  for (const args of [["--help"], ["help"], ["handoff", "--help"]])
    expect(await remoteCli(args)).toHaveProperty("usage");
  for (const args of [
    ["handoff"],
    ["handoff", "--summary-file"],
    ["handoff", "--unknown", "a"],
    ["handoff", "--status", "done", "--status", "done"],
    ["handoff", "--summary-file", path, "--summary-file", path],
    ["manual", "--page", "bad"],
    ["manual", "--section", "a", "--section", "b"],
    Array(31).fill("handoff"),
  ])
    await expect(remoteCli(args)).rejects.toThrow();
  await expect(remoteCli(["handoff", "--summary-file", root])).rejects.toThrow("Invalid");
  await writeFile(path, "x".repeat(8193));
  await expect(remoteCli(["handoff", "--summary-file", path])).rejects.toThrow("Invalid");
  vi.mocked(endpointRequest).mockResolvedValue(undefined);
  expect(await remoteCli(["whoami"])).toEqual({ error: "unavailable" });
  expect(await remoteCli(["manual"])).toEqual({ error: "unavailable" });
});
test("stdio MCP terminates locally, exposes three tools and forwards only typed calls", async () => {
  const out = output();
  const lines = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "fixture", version: "1" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "ping" },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "whoami", arguments: {}, _meta: { ignored: true } },
    },
    { jsonrpc: "2.0", id: 5, method: "unknown" },
    { jsonrpc: "2.0", method: "unknown-notification" },
  ];
  await remoteMcp(input(lines.map((line) => JSON.stringify(line)).join("\n") + "\n"), out.pipe);
  expect(out.text()).toContain('"foom-remote"');
  expect(out.text()).toContain('"name":"handoff"');
  expect(out.text()).not.toContain('"name":"sessions"');
  expect(out.text()).not.toContain('"terminalId"');
  expect(out.text()).not.toContain('"parentId"');
  expect(endpointRequest).toHaveBeenCalledTimes(3);
  expect(endpointRequest).toHaveBeenNthCalledWith(2, "/call", {
    method: "mcp_connected",
    params: {},
  });
  expect(endpointRequest).toHaveBeenLastCalledWith("/call", { method: "whoami", params: {} });
  const unready = output();
  vi.mocked(endpointRequest).mockResolvedValueOnce(identity).mockResolvedValueOnce(undefined);
  await remoteMcp(
    input(
      lines
        .slice(0, 3)
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    ),
    unready.pipe,
  );
  expect(unready.text()).not.toContain('"name":"handoff"');
  const errorOut = output();
  vi.mocked(endpointRequest).mockResolvedValue({ type: "error", error: "phase_2_restricted" });
  await remoteMcp(input(JSON.stringify(lines[0]) + "\n"), errorOut.pipe);
  expect(errorOut.text()).toContain("Invalid or unavailable");
  await expect(remoteMcp(input("truncated"), out.pipe)).rejects.toThrow("Truncated");
  await expect(remoteMcp(input("x".repeat(65537)), out.pipe)).rejects.toThrow("too large");
  await expect(remoteMcp(Readable.from([42]), out.pipe)).rejects.toThrow("Invalid MCP input");
});
