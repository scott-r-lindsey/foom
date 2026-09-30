import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import {
  listLocalModels,
  openConnection,
  probeInference,
  streamDelta,
} from "../src/inference-probe";
import type { ProbeDependencies } from "../src/inference-probe";
import type { ProbeEvent, ProbeUpdate } from "../src/shared/inference";

const local = { kind: "local", model: "qwen3:14b", endpoint: "http://127.0.0.1:11434/v1" };
const href = (input: string | URL | Request) =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
/** A network error carrying a Node error code, as fetch and sockets report them. */
const coded = (code: string, nested = false) => {
  const error = new Error("network");
  return nested
    ? Object.assign(error, { cause: Object.assign(new Error("cause"), { code }) })
    : Object.assign(error, { code });
};
const verdict = '{"state":"needs_input","confidence":0.9}';

function sse(lines: readonly unknown[], status = 200): Response {
  const body = lines
    .map((line) => `data: ${typeof line === "string" ? line : JSON.stringify(line)}\n\n`)
    .join("");
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}
const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  choices: [{ delta, finish_reason: finish }],
});
const reply = (text = verdict, finish = "stop") => [
  chunk({ reasoning: "Hmm" }),
  chunk({ reasoning: "ok" }),
  chunk({ content: text }),
  chunk({}, finish),
  "[DONE]",
];

/** A fetch that answers by path. POST goes to `chat`. */
function server(routes: {
  version?: () => Response;
  models?: () => Response;
  ps?: () => Response;
  chat?: (init: RequestInit) => Response | Promise<Response>;
}) {
  return vi.fn((input: string | URL | Request, init: RequestInit = {}) => {
    const url = href(input);
    const hang = () =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    if (url.endsWith("/api/version"))
      return Promise.resolve(routes.version?.() ?? json({ version: "0.32.14" }));
    if (url.endsWith("/models"))
      return Promise.resolve(routes.models?.() ?? json({ data: [{ id: "qwen3:14b" }] }));
    if (url.endsWith("/api/ps")) return Promise.resolve(routes.ps?.() ?? json({ models: [] }));
    return routes.chat ? Promise.resolve(routes.chat(init)) : hang();
  });
}

async function run(
  config: unknown,
  deps: Partial<ProbeDependencies> = {},
  limit = 5000,
  cancel?: AbortSignal,
) {
  const updates: ProbeUpdate[] = [];
  const result = await probeInference(
    config,
    limit,
    {
      readKey: () => Promise.resolve("sk-secret"),
      connect: () => Promise.resolve(),
      ...deps,
    },
    (update) => updates.push(update),
    cancel,
  );
  const steps = updates.flatMap((update) => (update.kind === "step" ? [update.event] : []));
  const last = (step: ProbeEvent["step"]) => steps.filter((event) => event.step === step).at(-1);
  return { result, updates, steps, last };
}

afterEach(() => {
  vi.useRealTimers();
});

test("an Ollama check reports each step, streams thinking and the reply, and passes", async () => {
  const request = server({ chat: () => sse(reply()) });
  const { result, updates, steps, last } = await run(local, { request });
  expect(result).toMatchObject({
    ok: true,
    verdict: { state: "needs_input", confidence: 0.9 },
    thinking: 2,
    reply: verdict,
  });
  expect(result.message).toMatch(/^needs_input · confidence 0\.90 in \d+\.\ds$/);
  expect(result.timings.firstTokenMs).toBeTypeOf("number");
  expect(result.request).toMatchObject({
    url: "http://127.0.0.1:11434/v1/chat/completions",
    model: "qwen3:14b",
    parameters: { model: "qwen3:14b", max_tokens: 512, stream: true },
  });
  expect(result.request.prompt).toContain("Would you like me to apply these changes?");
  expect(result.request.parameters).not.toHaveProperty("messages");
  expect(steps.filter((event) => event.status !== "running").map((event) => event.label)).toEqual([
    "Connected to 127.0.0.1:11434",
    "Ollama 0.32.14",
    "qwen3:14b is available",
    "Accepted (HTTP 200)",
    "Loaded qwen3:14b",
    "Reply complete: 40 characters after 2 thinking chunks",
    "needs_input · confidence 0.90",
  ]);
  expect(steps.some((event) => event.label === "Thinking")).toBe(true);
  expect(steps.some((event) => event.label === "Writing the reply")).toBe(true);
  expect(last("load")?.durationMs).toBeTypeOf("number");
  expect(updates).toContainEqual({ kind: "stream", thinking: 2, reply: verdict });
  const post = request.mock.calls.find(([, init]) => init?.method === "POST")?.[1];
  expect(JSON.parse(typeof post?.body === "string" ? post.body : "")).toMatchObject({
    stream: true,
  });
  expect(post?.redirect).toBe("error");
});

test("a model already in memory says so; other servers skip Ollama's steps", async () => {
  const loaded = await run(local, {
    request: server({
      ps: () => json({ models: [{ name: "qwen3:14b" }] }),
      chat: () => sse(reply()),
    }),
  });
  expect(loaded.last("load")?.label).toBe("qwen3:14b is already in memory");

  const plain = await run(local, {
    request: server({
      version: () => json({}, 404),
      models: () => json({ error: "nope" }, 500),
      chat: () => sse(reply()),
    }),
  });
  expect(plain.last("server")).toMatchObject({
    status: "skipped",
    label: "OpenAI-compatible server",
  });
  expect(plain.last("model")).toMatchObject({
    status: "skipped",
    label: "Couldn't list models; trying anyway",
  });
  expect(plain.last("load")).toBeUndefined();
  expect(plain.result.ok).toBe(true);

  const unlisted = await run(local, {
    request: server({
      version: () => json({ version: "bad version!" }),
      models: () => json({ data: [{ id: "other" }] }),
    }),
  });
  expect(unlisted.result).toMatchObject({
    failure: "model-missing",
    message: "The server doesn't list qwen3:14b",
  });
  const missing = await run(local, {
    request: server({ models: () => json({ data: [{ id: "other" }, 7] }) }),
  });
  expect(missing.result.message).toBe("qwen3:14b isn't pulled. Run: ollama pull qwen3:14b");
  expect(missing.last("model")?.status).toBe("failed");
});

test("HTTP failures are named by status, never by the provider's text", async () => {
  const cases: [number, string, string][] = [
    [401, "auth", "The key was rejected (HTTP 401)"],
    [403, "auth", "The key was rejected (HTTP 403)"],
    [404, "model-missing", "Model qwen3:14b wasn't found (HTTP 404)"],
    [429, "rate-limited", "Rate limited (HTTP 429). Try again shortly"],
    [503, "server-error", "The server failed (HTTP 503)"],
    [418, "http", "Unexpected response (HTTP 418)"],
  ];
  for (const [status, failure, message] of cases) {
    const { result, last } = await run(local, {
      request: server({
        version: () => json({}, 404),
        chat: () => json({ error: "provider secret detail" }, status),
      }),
    });
    expect(result).toMatchObject({ ok: false, failure, message });
    expect(last("request")).toMatchObject({ status: "failed", label: message });
  }
  const ollama404 = await run(local, { request: server({ chat: () => json({}, 404) }) });
  expect(ollama404.result.message).toBe("qwen3:14b isn't pulled. Run: ollama pull qwen3:14b");
});

test("replies that stop early, refuse, or aren't Foom's JSON fail at the reply", async () => {
  const cases: [unknown[], string, string][] = [
    [reply(verdict, "length"), "truncated", "The reply hit the token limit before finishing"],
    [reply(verdict, "content_filter"), "refusal", "The model declined or called a tool"],
    [[chunk({ tool_calls: [{}] }), "[DONE]"], "refusal", "The model declined or called a tool"],
    [[chunk({ content: verdict }), "[DONE]"], "truncated", "The reply ended early"],
    [reply("Sure! Here you go"), "bad-reply", "The reply isn't the JSON Foom asked for"],
    [["not json", ...reply()], "", ""],
  ];
  for (const [lines, failure, message] of cases) {
    const { result } = await run(local, { request: server({ chat: () => sse(lines) }) });
    if (!failure) expect(result.ok).toBe(true);
    else expect(result).toMatchObject({ ok: false, failure, message });
  }
  const long = await run(local, {
    request: server({ chat: () => sse([chunk({ content: "x".repeat(70_000) })]) }),
  });
  expect(long.result).toMatchObject({ failure: "bad-reply", message: "The reply is too long" });
  const empty = await run(local, { request: server({ chat: () => new Response(null) }) });
  expect(empty.result.message).toBe("The server sent no reply");
  const huge = await run(local, {
    request: server({
      chat: () => new Response(`data: ${"x".repeat(1_100_000)}\n\n`, { status: 200 }),
    }),
  });
  expect(huge.result.message).toBe("The reply is too large");
  // A final line without a trailing newline still counts.
  const unterminated = await run(local, {
    request: server({
      chat: () =>
        new Response(
          `data: ${JSON.stringify(chunk({ content: verdict }))}\n\ndata: ${JSON.stringify(chunk({}, "stop"))}`,
        ),
    }),
  });
  expect(unterminated.result.ok).toBe(true);
});

test("cloud checks read the key first and stream Anthropic and Google formats", async () => {
  const anthropic = { kind: "anthropic", model: "claude-haiku-4-5" };
  const events = (stop: string) => [
    { type: "message_start" },
    { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "..." } },
    { type: "content_block_delta", delta: { type: "text_delta", text: verdict } },
    { type: "content_block_delta", delta: { type: "other" } },
    { type: "message_delta", delta: { stop_reason: stop } },
  ];
  const connect = vi.fn(() => Promise.resolve());
  const request = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(sse(events("end_turn"))),
  );
  const ok = await run(anthropic, { request, connect });
  expect(ok.result).toMatchObject({ ok: true, thinking: 1 });
  expect(connect).toHaveBeenCalledWith("api.anthropic.com", 443, expect.any(AbortSignal));
  expect(ok.last("key")?.label).toBe("Key loaded from your system keychain");
  const headers = request.mock.calls[0]?.[1]?.headers as Record<string, string>;
  expect(headers["x-api-key"]).toBe("sk-secret");
  expect(JSON.stringify(ok.result)).not.toContain("sk-secret");
  for (const [stop, failure] of [
    ["max_tokens", "truncated"],
    ["refusal", "refusal"],
  ] as const) {
    const { result } = await run(anthropic, {
      request: () => Promise.resolve(sse(events(stop))),
    });
    expect(result.failure).toBe(failure);
  }
  const error = await run(anthropic, {
    request: () => Promise.resolve(sse([{ type: "error", error: { message: "secret" } }])),
  });
  expect(error.result).toMatchObject({
    failure: "server-error",
    message: "The server reported an error mid-reply",
  });
  const keyless = await run(anthropic, { readKey: () => Promise.reject(new Error("none")) });
  expect(keyless.result).toMatchObject({ failure: "no-key", message: "No Anthropic key is saved" });

  const google = { kind: "google", model: "gemini-2.5-flash" };
  const part = (parts: unknown[], finishReason?: string) => ({
    candidates: [{ content: { parts }, ...(finishReason ? { finishReason } : {}) }],
  });
  const googleOk = await run(google, {
    request: (url) => {
      expect(href(url)).toContain(":streamGenerateContent?alt=sse");
      return Promise.resolve(
        sse([part([{ thought: true, text: "hm" }]), part([{ text: verdict }, 3], "STOP")]),
      );
    },
  });
  expect(googleOk.result).toMatchObject({ ok: true, thinking: 1 });
  for (const [reason, failure] of [
    ["MAX_TOKENS", "truncated"],
    ["SAFETY", "refusal"],
  ] as const) {
    const { result } = await run(google, {
      request: () => Promise.resolve(sse([part([{ text: verdict }], reason)])),
    });
    expect(result.failure).toBe(failure);
  }
  const openai = await run(
    { kind: "openai", model: "gpt-4.1-mini" },
    { request: () => Promise.resolve(sse(reply())) },
  );
  expect(openai.result.ok).toBe(true);
});

test("connection errors are named from their code", async () => {
  const failing = (error: Error) => () => Promise.reject(error);
  const cases: [Error, string, string][] = [
    [
      coded("ECONNREFUSED"),
      "refused",
      "Connection refused: nothing is listening on 127.0.0.1:11434",
    ],
    [coded("ENOTFOUND", true), "dns", "Couldn't resolve 127.0.0.1:11434"],
    [coded("EHOSTUNREACH"), "unreachable", "Can't reach 127.0.0.1:11434 (EHOSTUNREACH)"],
    [coded("ETIMEDOUT"), "connect-timeout", "Connecting to 127.0.0.1:11434 timed out"],
    [
      coded("CERT_HAS_EXPIRED", true),
      "tls",
      "A secure connection to 127.0.0.1:11434 failed (CERT_HAS_EXPIRED)",
    ],
    [coded("EWHATEVER"), "failed", "The request to 127.0.0.1:11434 failed (EWHATEVER)"],
    [new Error("plain"), "failed", "The request to 127.0.0.1:11434 failed"],
    [
      Object.assign(new Error("fetch failed"), { cause: new Error("bad port") }),
      "failed",
      "Fetch won't connect to port-blocked 127.0.0.1:11434. Use another port",
    ],
  ];
  for (const [error, failure, message] of cases) {
    const { result, last } = await run(local, { connect: failing(error) });
    expect(result).toMatchObject({ failure, message });
    expect(last("connect")?.status).toBe("failed");
  }
  // The same mapping applies when the request itself fails after connecting.
  const post = await run(local, {
    request: server({ chat: () => Promise.reject(coded("ECONNRESET")) }),
  });
  expect(post.result.failure).toBe("unreachable");
});

test("a timeout names the step that was running", async () => {
  vi.useFakeTimers();
  const hangingStream = (text?: string) => () =>
    new Response(
      new ReadableStream({
        start(controller) {
          if (text)
            controller.enqueue(
              new TextEncoder().encode(`data: ${JSON.stringify(chunk({ content: text }))}\n\n`),
            );
        },
      }),
    );
  const inMemory = () => json({ models: [{ model: "qwen3:14b" }] });
  const cases: [Partial<ProbeDependencies>, string][] = [
    [{ request: server({}) }, "while loading qwen3:14b"],
    [
      { request: server({ ps: () => json({ models: [{ model: "qwen3:14b" }] }) }) },
      "waiting for the server",
    ],
    [{ request: server({ ps: inMemory, chat: hangingStream() }) }, "waiting for the first token"],
    [{ request: server({ ps: inMemory, chat: hangingStream('{"state"') }) }, "mid-reply"],
    [
      {
        connect: (_host, _port, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          }),
      },
      "connecting",
    ],
    [
      {
        request: vi.fn(
          (_url: string | URL | Request, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                reject(new Error("aborted"));
              });
            }),
        ),
      },
      "during the check",
    ],
  ];
  for (const [deps, phase] of cases) {
    const pending = run(local, deps, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    const { result } = await pending;
    expect(result).toMatchObject({ failure: "timeout", message: `Timed out after 1.0s ${phase}` });
  }
});

test("cancelling stops the check; bad input is rejected before it starts", async () => {
  const controller = new AbortController();
  controller.abort();
  const { result } = await run(
    local,
    { request: server({ chat: () => sse(reply()) }) },
    5000,
    controller.signal,
  );
  expect(result).toMatchObject({ failure: "cancelled", message: "Cancelled" });
  const live = new AbortController();
  const pending = run(local, { request: server({}) }, 5000, live.signal);
  await vi.waitFor(() => {
    expect(live.signal.aborted).toBe(false);
  });
  live.abort();
  expect((await pending).result.failure).toBe("cancelled");

  await expect(run({ kind: "rules" })).rejects.toThrow("Rules only needs no check");
  await expect(run(local, {}, 500)).rejects.toThrow("Invalid time limit");
  await expect(run(local, {}, 1500.5)).rejects.toThrow("Invalid time limit");
  await expect(run({ kind: "claude" })).rejects.toThrow("CLI inference unavailable");
});

test("stream chunks with unexpected shapes are ignored", () => {
  expect(streamDelta("local", null)).toEqual({});
  expect(streamDelta("local", { choices: [] })).toEqual({});
  expect(streamDelta("local", { choices: [{}] })).toEqual({});
  expect(streamDelta("local", chunk({ reasoning_content: "x" }))).toEqual({ thinking: true });
  expect(streamDelta("local", chunk({ refusal: "no" }))).toEqual({ finish: "refusal" });
  expect(streamDelta("anthropic", { type: "ping" })).toEqual({});
  expect(streamDelta("anthropic", { type: "message_delta", delta: {} })).toEqual({});
  expect(streamDelta("anthropic", { type: "content_block_delta" })).toEqual({});
  expect(streamDelta("google", { candidates: [] })).toEqual({});
  expect(streamDelta("google", { candidates: [{}] })).toEqual({});
});

test("the local model list names the server and its models, or why it failed", async () => {
  const request = server({ models: () => json({ data: [{ id: "a" }, { id: 1 }, { id: "b" }] }) });
  await expect(listLocalModels(local.endpoint, { request })).resolves.toEqual({
    ok: true,
    models: ["a", "b"],
    server: "Ollama 0.32.14",
  });
  const plain = server({ version: () => json({}, 404), models: () => json({ data: [] }) });
  await expect(listLocalModels(local.endpoint, { request: plain })).resolves.toMatchObject({
    ok: true,
    server: null,
  });
  await expect(
    listLocalModels(local.endpoint, { request: server({ models: () => json({}, 500) }) }),
  ).resolves.toEqual({ ok: false, failure: "http", message: "The model list answered HTTP 500" });
  await expect(
    listLocalModels(local.endpoint, { request: server({ models: () => json({ nope: 1 }) }) }),
  ).resolves.toMatchObject({ ok: false, failure: "bad-reply" });
  await expect(
    listLocalModels(local.endpoint, { request: () => Promise.reject(coded("ECONNREFUSED")) }),
  ).resolves.toMatchObject({ ok: false, failure: "refused" });
  await expect(
    listLocalModels(
      local.endpoint,
      {
        request: (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          }),
      },
      10,
    ),
  ).resolves.toEqual({
    ok: false,
    failure: "connect-timeout",
    message: "No answer from 127.0.0.1:11434",
  });
  await expect(listLocalModels("http://example.com/v1", {})).rejects.toThrow("loopback");
});

test("a real OpenAI-compatible server over TCP, and a real refused port", async () => {
  const http = createServer((request, response) => {
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "qwen3:14b" }] }));
    } else if (request.url === "/v1/chat/completions") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const line of reply())
        response.write(`data: ${typeof line === "string" ? line : JSON.stringify(line)}\n\n`);
      response.end();
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  const endpoint = `http://127.0.0.1:${String(port)}/v1`;
  try {
    const updates: ProbeUpdate[] = [];
    const result = await probeInference(
      { ...local, endpoint },
      5000,
      { readKey: () => Promise.reject(new Error("unused")) },
      (update) => updates.push(update),
    );
    expect(result).toMatchObject({ ok: true, verdict: { state: "needs_input" } });
    await expect(listLocalModels(endpoint, {})).resolves.toMatchObject({
      ok: true,
      models: ["qwen3:14b"],
    });
  } finally {
    await new Promise((resolve) => http.close(resolve));
  }
  const refused = await probeInference(
    { ...local, endpoint },
    5000,
    { readKey: () => Promise.reject(new Error("unused")) },
    () => {},
  );
  expect(refused).toMatchObject({ failure: "refused" });
});

test("optional server questions fail soft, and a pending connection can be abandoned", async () => {
  const flaky = vi.fn((input: string | URL | Request) => {
    const url = href(input);
    if (url.endsWith("/api/version")) return Promise.resolve(new Response(null));
    if (url.endsWith("/models"))
      return Promise.resolve(new Response(`{"data":"${"x".repeat(1_100_000)}"}`));
    if (url.endsWith("/api/ps")) return Promise.reject(new Error("gone"));
    return Promise.resolve(sse(reply()));
  });
  const { result, last } = await run(local, { request: flaky });
  expect(result.ok).toBe(true);
  expect(last("server")?.status).toBe("skipped");
  expect(last("model")?.status).toBe("skipped");
  const rejecting = vi.fn((input: string | URL | Request) =>
    href(input).endsWith("/chat/completions")
      ? Promise.resolve(sse(reply()))
      : Promise.reject(new Error("gone")),
  );
  expect((await run(local, { request: rejecting })).result.ok).toBe(true);
  await expect(
    listLocalModels(local.endpoint, {
      request: (input) =>
        href(input).endsWith("/models")
          ? Promise.resolve(json({ data: [] }))
          : Promise.reject(new Error("gone")),
    }),
  ).resolves.toMatchObject({ ok: true, server: null });

  const controller = new AbortController();
  const pending = openConnection("127.0.0.1", 9, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow("Aborted");
});

test("stream updates are throttled, but the latest one is never dropped", async () => {
  vi.useFakeTimers();
  const encoder = new TextEncoder();
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const updates: ProbeUpdate[] = [];
  const pending = probeInference(
    local,
    5000,
    {
      readKey: () => Promise.reject(new Error("unused")),
      connect: () => Promise.resolve(),
      request: server({
        ps: () => json({ models: [{ name: "qwen3:14b" }] }),
        chat: () =>
          new Response(
            new ReadableStream({
              start(controller) {
                stream = controller;
              },
            }),
          ),
      }),
    },
    (update) => updates.push(update),
  );
  const send = (value: unknown) => {
    stream?.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
  };
  await vi.waitFor(() => {
    expect(stream).toBeDefined();
  });
  send(chunk({ reasoning: "a" }));
  send(chunk({ reasoning: "b" }));
  send(chunk({ reasoning: "c" }));
  await vi.advanceTimersByTimeAsync(0);
  const streamed = () => updates.filter((update) => update.kind === "stream");
  // The first update goes out at once; the rest wait for the interval.
  expect(streamed()).toEqual([{ kind: "stream", thinking: 1, reply: "" }]);
  await vi.advanceTimersByTimeAsync(100);
  expect(streamed().at(-1)).toEqual({ kind: "stream", thinking: 3, reply: "" });
  send(chunk({ content: verdict }, "stop"));
  stream?.close();
  const result = await pending;
  expect(result.ok).toBe(true);
  expect(streamed().at(-1)).toEqual({ kind: "stream", thinking: 3, reply: verdict });
});
