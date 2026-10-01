import type { ProbeDependencies, StreamDelta } from "./probe.d";
import { ProbeError, networkFailure, providerCode, httpFailure } from "./probe-errors";
import { record, readJson } from "./probe-response";
import { events, streamDelta } from "./probe-stream";
import { connect as netConnect } from "node:net";
import { CHECK_SAMPLE, classifierPrompt, parseModelVerdict } from "./inference-input";
import { parseInferenceConfig, providerRequest } from "./inference-source";
import type {
  ApiProvider,
  ModelList,
  ProbeEvent,
  ProbeResult,
  ProbeStep,
  ProbeUpdate,
} from "../../shared/inference";

const REPLY_LIMIT = 65_536;
const SHOWN_REPLY = 4096;
const LIST_TIMEOUT = 3000;
const LABELS: Record<ApiProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
};

/** Opens and closes one TCP connection. Exported for tests. */
export function openConnection(host: string, port: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port });
    const settle = (error?: Error) => {
      signal.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      settle(new Error("Aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => {
      settle();
    });
    socket.once("error", settle);
  });
}

function hostOf(url: URL): { host: string; port: number; where: string } {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
  return { host, port, where: `${url.hostname}:${String(port)}` };
}

/**
 * Run check, step by step. Each stage reports as it starts and ends, the reply streams
 * as it arrives, and a failure names the stage that failed.
 */
export async function probeInference(
  value: unknown,
  timeoutMs: number,
  deps: ProbeDependencies,
  onUpdate: (update: ProbeUpdate) => void,
  cancel?: AbortSignal,
): Promise<ProbeResult> {
  const config = parseInferenceConfig(value);
  if (config.kind === "rules") throw new Error("Rules only needs no check");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30_000)
    throw new Error("Invalid time limit");
  const now = deps.now ?? (() => performance.now());
  const request = deps.request ?? fetch;
  const connect = deps.connect ?? openConnection;
  const start = now();
  const at = () => Math.round(now() - start);
  const controller = new AbortController();
  const signal = controller.signal;
  // Set from the timer callback, so it lives on an object the compiler can't narrow.
  const deadline = { passed: false };
  const timer = setTimeout(() => {
    deadline.passed = true;
    controller.abort();
  }, timeoutMs);
  const stop = () => {
    controller.abort();
  };
  cancel?.addEventListener("abort", stop, { once: true });
  if (cancel?.aborted) controller.abort();

  const prompt = classifierPrompt([CHECK_SAMPLE]);
  const sent = providerRequest(config, prompt, undefined, true);
  // Details show the parameters beside the prompt, not the prompt twice.
  const parameters = { ...sent.body };
  delete parameters["messages"];
  delete parameters["contents"];
  const result: ProbeResult = {
    ok: false,
    message: "",
    timings: { totalMs: 0 },
    request: { url: sent.url, model: config.model, parameters, prompt },
    reply: "",
    thinking: 0,
  };
  const open = new Map<ProbeStep, { label: string; startedAt: number }>();
  const emit = (event: ProbeEvent) => {
    onUpdate({ kind: "step", event });
  };
  const begin = (step: ProbeStep, label: string) => {
    // A cancel or timeout between steps stops here, even if a request ignored the signal.
    signal.throwIfAborted();
    const startedAt = open.get(step)?.startedAt ?? at();
    open.set(step, { label, startedAt });
    emit({ step, status: "running", label, atMs: at() });
  };
  const end = (step: ProbeStep, status: "ok" | "skipped" | "failed", label?: string) => {
    const entry = open.get(step);
    open.delete(step);
    const time = at();
    emit({
      step,
      status,
      label: label ?? entry?.label ?? step,
      atMs: time,
      ...(entry ? { durationMs: time - entry.startedAt } : {}),
    });
  };
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const url = new URL(sent.url);
  const target = hostOf(url);
  const local = config.kind === "local";
  let ollama = false;
  let stopStream: () => void = () => {};

  try {
    const headers = { ...sent.headers };
    if (!local) {
      const name = LABELS[config.kind];
      begin("key", `Reading the ${name} key from your system keychain`);
      let key: string;
      try {
        key = await deps.readKey(config.kind);
      } catch {
        throw new ProbeError("no-key", `No ${name} key is saved`);
      }
      Object.assign(headers, providerRequest(config, prompt, key, true).headers);
      end("key", "ok", "Key loaded from your system keychain");
    }

    begin("connect", `Connecting to ${target.where}`);
    try {
      await connect(target.host, target.port, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      throw networkFailure(error, target.where);
    }
    result.timings.connectMs = at();
    end("connect", "ok", `Connected to ${target.where}`);

    if (local) {
      const origin = url.origin;
      const endpoint = sent.url.replace(/\/chat\/completions$/, "");
      begin("server", "Identifying the server");
      const version = await request(`${origin}/api/version`, { signal, redirect: "error" })
        .then(async (response) => (response.ok ? readJson(response) : undefined))
        .catch(() => undefined);
      if (
        record(version) &&
        typeof version["version"] === "string" &&
        /^[\w.+-]{1,32}$/.test(version["version"])
      ) {
        ollama = true;
        end("server", "ok", `Ollama ${version["version"]}`);
      } else end("server", "skipped", "OpenAI-compatible server");

      begin("model", `Looking for ${config.model}`);
      const listed = await request(`${endpoint}/models`, { signal, redirect: "error" })
        .then(async (response) => (response.ok ? readJson(response) : undefined))
        .catch(() => undefined);
      const ids =
        record(listed) && Array.isArray(listed["data"])
          ? listed["data"].flatMap((entry: unknown) =>
              record(entry) && typeof entry["id"] === "string" ? [entry["id"]] : [],
            )
          : undefined;
      if (!ids) end("model", "skipped", "Couldn't list models; trying anyway");
      else if (ids.includes(config.model)) end("model", "ok", `${config.model} is available`);
      else if (ollama) throw httpFailure(404, config.model, true);
      else throw new ProbeError("model-missing", `The server doesn't list ${config.model}`);

      if (ollama) {
        const ps = await request(`${origin}/api/ps`, { signal, redirect: "error" })
          .then(async (response) => (response.ok ? readJson(response) : undefined))
          .catch(() => undefined);
        const loaded =
          record(ps) && Array.isArray(ps["models"])
            ? ps["models"].some(
                (entry: unknown) =>
                  record(entry) &&
                  (entry["name"] === config.model || entry["model"] === config.model),
              )
            : undefined;
        if (loaded) {
          begin("load", "Checking memory");
          end("load", "ok", `${config.model} is already in memory`);
        } else if (loaded === false)
          begin("load", `Loading ${config.model} into memory (slower after idle)`);
      }
    }

    begin("request", "Sending the sample");
    let response: Response;
    try {
      response = await request(sent.url, {
        method: "POST",
        headers,
        body: JSON.stringify(sent.body),
        signal,
        redirect: "error",
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw networkFailure(error, target.where);
    }
    if (!response.ok)
      throw httpFailure(response.status, config.model, ollama, await providerCode(response));
    if (!response.body) throw new ProbeError("bad-reply", "The server sent no reply");
    end("request", "ok", `Accepted (HTTP ${String(response.status)})`);

    begin("reply", "Waiting for the first token");
    let reply = "";
    let finish: StreamDelta["finish"];
    let phase: "thinking" | "writing" | undefined;
    // At most ten stream updates a second; the latest one is always delivered.
    let shown: number | undefined;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      clearTimeout(pending);
      pending = undefined;
      shown = at();
      onUpdate({ kind: "stream", thinking: result.thinking, reply: reply.slice(0, SHOWN_REPLY) });
    };
    const stream = () => {
      if (shown === undefined || at() - shown >= 100) flush();
      else pending ??= setTimeout(flush, 100 - (at() - shown));
    };
    stopStream = () => {
      clearTimeout(pending);
    };
    for await (const data of events(response.body, signal)) {
      if (data === "[DONE]") break;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = streamDelta(config.kind, parsed);
      if (delta.error)
        throw new ProbeError("server-error", "The server reported an error mid-reply");
      if ((delta.text || delta.thinking) && result.timings.firstTokenMs === undefined) {
        result.timings.firstTokenMs = at();
        if (open.has("load")) end("load", "ok", `Loaded ${config.model}`);
      }
      if (delta.thinking) {
        result.thinking++;
        if (phase !== "thinking") begin("reply", "Thinking");
        phase = "thinking";
      }
      if (delta.text) {
        reply += delta.text;
        if (reply.length > REPLY_LIMIT) throw new ProbeError("bad-reply", "The reply is too long");
        if (phase !== "writing") begin("reply", "Writing the reply");
        phase = "writing";
      }
      if (delta.finish) finish = delta.finish;
      stream();
    }
    flush();
    result.reply = reply.slice(0, SHOWN_REPLY);
    if (finish === "length")
      throw new ProbeError("truncated", "The reply hit the token limit before finishing");
    if (finish === "refusal")
      throw new ProbeError("refusal", "The model declined or called a tool");
    if (!finish) throw new ProbeError("truncated", "The reply ended early");
    end(
      "reply",
      "ok",
      `Reply complete: ${String(reply.length)} characters${result.thinking ? ` after ${String(result.thinking)} thinking chunks` : ""}`,
    );

    begin("parse", "Reading the verdict");
    let verdict;
    try {
      verdict = parseModelVerdict(reply.trim());
    } catch {
      throw new ProbeError("bad-reply", "The reply isn't the JSON Foom asked for");
    }
    result.verdict = verdict;
    end("parse", "ok", `${verdict.state} · confidence ${verdict.confidence.toFixed(2)}`);
    result.ok = true;
    result.message = `${verdict.state} · confidence ${verdict.confidence.toFixed(2)} in ${seconds(at())}`;
  } catch (error) {
    // A model still loading is why the request is slow, so it takes the blame.
    const running = open.has("load") ? "load" : [...open.keys()].at(-1);
    const failure = signal.aborted
      ? deadline.passed
        ? new ProbeError(
            "timeout",
            `Timed out after ${seconds(timeoutMs)} ${
              running === "load"
                ? `while loading ${config.model}`
                : running === "reply"
                  ? result.timings.firstTokenMs === undefined
                    ? "waiting for the first token"
                    : "mid-reply"
                  : running === "connect"
                    ? "connecting"
                    : running === "request"
                      ? "waiting for the server"
                      : "during the check"
            }`,
          )
        : new ProbeError("cancelled", "Cancelled")
      : error instanceof ProbeError
        ? error
        : new ProbeError("failed", "The check failed unexpectedly");
    for (const step of [...open.keys()])
      end(step, "failed", step === running ? failure.message : undefined);
    result.failure = failure.failure;
    result.message = failure.message;
  } finally {
    clearTimeout(timer);
    stopStream();
    cancel?.removeEventListener("abort", stop);
  }
  result.timings.totalMs = at();
  return result;
}

/** What a local endpoint offers, for the model picker. Doubles as a connection test. */
export async function listLocalModels(
  endpoint: unknown,
  deps: Pick<ProbeDependencies, "request">,
  timeoutMs = LIST_TIMEOUT,
): Promise<ModelList> {
  const config = parseInferenceConfig({ kind: "local", model: "any", endpoint });
  if (config.kind !== "local") throw new Error("Invalid local endpoint");
  const request = deps.request ?? fetch;
  const url = new URL(config.endpoint);
  const { where } = hostOf(url);
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await request(`${config.endpoint}/models`, { signal, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel();
      return {
        ok: false,
        failure: "http",
        message: `The model list answered HTTP ${String(response.status)}`,
      };
    }
    const listed = await readJson(response);
    const models =
      record(listed) && Array.isArray(listed["data"])
        ? listed["data"].flatMap((entry: unknown) =>
            record(entry) && typeof entry["id"] === "string" && entry["id"].length <= 128
              ? [entry["id"]]
              : [],
          )
        : undefined;
    if (!models)
      return { ok: false, failure: "bad-reply", message: "The server didn't return a model list" };
    const version = await request(`${url.origin}/api/version`, { signal, redirect: "error" })
      .then(async (reply) => (reply.ok ? readJson(reply) : undefined))
      .catch(() => undefined);
    const server =
      record(version) &&
      typeof version["version"] === "string" &&
      /^[\w.+-]{1,32}$/.test(version["version"])
        ? `Ollama ${version["version"]}`
        : null;
    return { ok: true, models: models.slice(0, 500), server };
  } catch (error) {
    if (signal.aborted)
      return { ok: false, failure: "connect-timeout", message: `No answer from ${where}` };
    const failure = networkFailure(error, where);
    return { ok: false, failure: failure.failure, message: failure.message };
  }
}
