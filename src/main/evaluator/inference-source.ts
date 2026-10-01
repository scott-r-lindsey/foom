import type { ApiProvider, InferenceConfig, InferenceSource } from "../../shared/inference";

export function parseInferenceConfig(value: unknown): InferenceConfig {
  if (typeof value !== "object" || value === null || !("kind" in value))
    throw new Error("Invalid inference source");
  if (value.kind === "rules" && Object.keys(value).length === 1) return { kind: "rules" };
  if (value.kind === "claude" || value.kind === "codex" || value.kind === "antigravity") {
    throw new Error(
      "CLI inference unavailable: tail-only isolation is not verified. Choose an API, local endpoint, or rules only.",
    );
  }
  if (
    !("model" in value) ||
    typeof value.model !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value.model)
  )
    throw new Error("Invalid inference model");
  if (
    (value.kind === "anthropic" || value.kind === "openai" || value.kind === "google") &&
    Object.keys(value).length === 2
  ) {
    return { kind: value.kind, model: value.model };
  }
  if (
    value.kind !== "local" ||
    Object.keys(value).length !== 3 ||
    !("endpoint" in value) ||
    typeof value.endpoint !== "string"
  )
    throw new Error("Invalid inference source");
  const url = new URL(value.endpoint);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]*$/.test(url.pathname)
  )
    throw new Error("Local endpoint must use a loopback IP and contain no credentials or query");
  return { kind: "local", model: value.model, endpoint: url.href.replace(/\/$/, "") };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new Error("Invalid provider response");
  return value;
}
function first(value: unknown): unknown {
  if (!Array.isArray(value) || value.length !== 1) throw new Error("Invalid provider response");
  return value[0];
}

type ModelConfig = Exclude<InferenceConfig, { kind: "rules" }>;
export interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * The request for one classification. Origins are fixed for cloud providers; the key
 * goes only into a header. `stream` asks for incremental output (used by Run check).
 */
export function providerRequest(
  config: ModelConfig,
  prompt: string,
  key: string | undefined,
  stream = false,
): ProviderRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.kind === "local" || config.kind === "openai") {
    if (config.kind === "openai") headers["Authorization"] = `Bearer ${key ?? ""}`;
    return {
      url:
        config.kind === "local"
          ? `${config.endpoint}/chat/completions`
          : "https://api.openai.com/v1/chat/completions",
      headers,
      body: {
        model: config.model,
        messages: [{ role: "user", content: prompt }],
        ...(config.kind === "openai"
          ? { max_completion_tokens: 512, store: false }
          : { max_tokens: 512 }),
        stream,
      },
    };
  }
  if (config.kind === "anthropic") {
    headers["x-api-key"] = key ?? "";
    headers["anthropic-version"] = "2023-06-01";
    return {
      url: "https://api.anthropic.com/v1/messages",
      headers,
      body: {
        model: config.model,
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
        ...(stream ? { stream: true } : {}),
      },
    };
  }
  headers["x-goog-api-key"] = key ?? "";
  const model = encodeURIComponent(config.model);
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`,
    headers,
    body: {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 512 },
    },
  };
}

/** No tools or files; fixed cloud origins; local endpoints cannot redirect. */
export function createInferenceSource(
  value: unknown,
  readKey: (provider: ApiProvider) => Promise<string>,
  request: typeof fetch = fetch,
): InferenceSource | undefined {
  const config = parseInferenceConfig(value);
  if (config.kind === "rules") return undefined;
  return {
    async complete(prompt, signal) {
      const key =
        config.kind === "anthropic" || config.kind === "openai" || config.kind === "google"
          ? await readKey(config.kind)
          : undefined;
      const { url, headers, body } = providerRequest(config, prompt, key);
      signal.throwIfAborted();
      const response = await request(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Inference request failed");
      }
      if (!response.body) throw new Error("Inference request failed");
      // Bound decoded response bytes, even without Content-Length or with compression.
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 65_536) throw new Error("Inference response too large");
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      const data = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      let text: unknown;
      if (config.kind === "anthropic") {
        const block = object(first(data["content"]));
        if (data["stop_reason"] !== "end_turn" || block["type"] !== "text")
          throw new Error("Incomplete response");
        text = block["text"];
      } else if (config.kind === "google") {
        const candidate = object(first(data["candidates"]));
        const part = object(first(object(candidate["content"])["parts"]));
        if (candidate["finishReason"] !== "STOP" || Object.keys(part).length !== 1)
          throw new Error("Incomplete response");
        text = part["text"];
      } else {
        const choice = object(first(data["choices"]));
        const message = object(choice["message"]);
        if (
          choice["finish_reason"] !== "stop" ||
          message["tool_calls"] ||
          message["function_call"] ||
          message["refusal"]
        )
          throw new Error("Incomplete response");
        text = message["content"];
      }
      if (typeof text !== "string") throw new Error("Invalid provider text");
      return text;
    },
  };
}
