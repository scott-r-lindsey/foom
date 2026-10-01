import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import {
  createInferenceSource,
  parseInferenceConfig,
} from "../../../../src/main/evaluator/inference-source";
import { ModelEvaluator } from "../../../../src/main/evaluator/model-evaluator";
import type { ApiProvider } from "../../../../src/shared/inference";
const answer = '{"state":"needs_input","confidence":0.9}';
const chat = { choices: [{ finish_reason: "stop", message: { content: answer } }] };
const responses = {
  openai: chat,
  local: chat,
  anthropic: { stop_reason: "end_turn", content: [{ type: "text", text: answer }] },
  google: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: answer }] } }] },
};
const readKey = vi.fn((_provider: ApiProvider) => Promise.resolve("private-key"));
it.each(["openai", "anthropic", "google", "local"] as const)(
  "sends a bounded tool-free %s request and extracts its response",
  async (kind) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(responses[kind]));
    const config =
      kind === "local"
        ? { kind, model: "small", endpoint: "http://127.0.0.1:1234/v1/" }
        : { kind, model: "small" };
    const source = createInferenceSource(config, readKey, request);
    const signal = new AbortController().signal;
    expect(await source?.complete("only-tail", signal)).toBe(answer);
    const call = request.mock.calls[0];
    if (!call) throw new Error("Missing request");
    expect(call[1]).toMatchObject({ signal, redirect: "error", method: "POST" });
    const raw = call[1]?.body;
    if (typeof raw !== "string") throw new Error("Missing body");
    const body: unknown = JSON.parse(raw);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("files");
    expect(JSON.stringify(body)).toContain("only-tail");
    expect(JSON.stringify(body)).not.toContain("private-key");
    if (kind === "openai")
      expect(call[1]?.headers).toHaveProperty("Authorization", "Bearer private-key");
    if (kind === "anthropic") expect(call[1]?.headers).toHaveProperty("x-api-key", "private-key");
    if (kind === "google") expect(call[1]?.headers).toHaveProperty("x-goog-api-key", "private-key");
    if (kind === "local") {
      expect(call[0]).toBe("http://127.0.0.1:1234/v1/chat/completions");
      expect(call[1]?.headers).toEqual({ "content-type": "application/json" });
    }
  },
);
it("offers rules without reading a key or making a request", () => {
  const key = vi.fn();
  const request = vi.fn();
  expect(createInferenceSource({ kind: "rules" }, key, request)).toBeUndefined();
  expect(key).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
  expect(
    parseInferenceConfig({ kind: "local", model: "llama:small", endpoint: "http://[::1]:11434/v1" })
      .kind,
  ).toBe("local");
});
it.each([
  null,
  [],
  {},
  { kind: "rules", extra: true },
  { kind: "wat", model: "x" },
  { kind: "openai" },
  { kind: "openai", model: null },
  { kind: "openai", model: "bad\nmodel" },
  { kind: "openai", model: "x", endpoint: "https://evil.example" },
  { kind: "local", model: "x" },
  { kind: "local", model: "x", endpoint: 1 },
  ...["claude", "codex", "antigravity"].map((kind) => ({ kind })),
])("rejects invalid and unisolated source %#", (value) => {
  expect(() => parseInferenceConfig(value)).toThrow();
});
it.each([
  "file:///tmp/x",
  "http://example.com/v1",
  "http://localhost/v1",
  "http://127.0.0.1.evil.test/v1",
  "http://user:pass@127.0.0.1/v1",
  "http://127.0.0.1/v1?key=secret",
  "http://127.0.0.1/v1#hash",
  "http://127.0.0.1/a%20b",
  "garbage",
])("rejects unsafe local endpoint %s", (endpoint) => {
  expect(() => parseInferenceConfig({ kind: "local", model: "x", endpoint })).toThrow();
});
it.each([
  null,
  [],
  {},
  { choices: [] },
  { choices: [null] },
  { choices: [{ message: {}, finish_reason: "length" }] },
  { choices: [{ finish_reason: "stop", message: { content: 5 } }] },
  ...["tool_calls", "function_call", "refusal"].map((key) => ({
    choices: [{ finish_reason: "stop", message: { content: answer, [key]: "untrusted" } }],
  })),
])("rejects invalid OpenAI envelopes %#", async (data) => {
  const source = createInferenceSource(
    { kind: "openai", model: "small" },
    readKey,
    vi.fn<typeof fetch>().mockResolvedValue(Response.json(data)),
  );
  await expect(source?.complete("tail", new AbortController().signal)).rejects.toThrow();
});
it.each([
  ["anthropic", { content: [{ type: "tool_use" }], stop_reason: "end_turn" }],
  ["anthropic", { content: [{ type: "text", text: answer }], stop_reason: "max_tokens" }],
  [
    "google",
    { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: answer }] } }] },
  ],
  [
    "google",
    {
      candidates: [
        { finishReason: "STOP", content: { parts: [{ text: answer, functionCall: {} }] } },
      ],
    },
  ],
])("rejects nonfinal/tool %s responses", async (kind, data) => {
  const source = createInferenceSource(
    { kind, model: "small" },
    readKey,
    vi.fn<typeof fetch>().mockResolvedValue(Response.json(data)),
  );
  await expect(source?.complete("tail", new AbortController().signal)).rejects.toThrow();
});
it.each([
  new Response("error", { status: 500 }),
  new Response(null),
  new Response("not json"),
  new Response("x".repeat(65537)),
])(
  "rejects HTTP failures, missing bodies, invalid JSON and oversized responses %#",
  async (response) => {
    const source = createInferenceSource(
      { kind: "openai", model: "small" },
      readKey,
      vi.fn<typeof fetch>().mockResolvedValue(response),
    );
    await expect(source?.complete("tail", new AbortController().signal)).rejects.toThrow();
  },
);
it("does not send after key retrieval outlives its deadline", async () => {
  const controller = new AbortController();
  const request = vi.fn<typeof fetch>();
  const source = createInferenceSource(
    { kind: "openai", model: "small" },
    () => {
      controller.abort();
      return Promise.resolve("key");
    },
    request,
  );
  await expect(source?.complete("tail", controller.signal)).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
it("uses real HTTP, refuses redirects, and aborts a stalled body", async () => {
  let redirectHits = 0;
  const server = createServer((req, res) => {
    if (req.url === "/redirect/chat/completions") {
      res.writeHead(307, { Location: "/leak" });
      res.end();
    } else if (req.url === "/leak") {
      redirectHits++;
      res.end();
    } else if (req.url === "/stall/chat/completions") {
      res.writeHead(200);
      res.write("{");
    } else {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(chat));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No server address");
    const base = `http://127.0.0.1:${String(address.port)}`;
    for (const [suffix, status] of [
      ["v1", "model"],
      ["redirect", "failed"],
      ["stall", "timeout"],
    ] as const) {
      const source = createInferenceSource(
        { kind: "local", model: "small", endpoint: `${base}/${suffix}` },
        readKey,
      );
      expect(await new ModelEvaluator(source, 200).runCheck()).toMatchObject({ status });
    }
    expect(redirectHits).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});
