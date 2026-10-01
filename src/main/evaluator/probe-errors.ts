import type { ProbeFailure } from "../../shared/inference";
import { record, readLimited } from "./probe-response";

/** A failure in Foom's own words. Provider error text is never shown. */
export class ProbeError extends Error {
  constructor(
    readonly failure: ProbeFailure,
    message: string,
  ) {
    super(message);
  }
}

/** Node's error code (a fixed identifier such as ECONNREFUSED), wherever fetch put it. */
function errorCode(error: unknown): string | undefined {
  for (let current = error, depth = 0; record(current) && depth < 4; depth++) {
    if (typeof current["code"] === "string") return current["code"];
    current = current["cause"];
  }
  return undefined;
}

export function networkFailure(error: unknown, where: string): ProbeError {
  const code = errorCode(error);
  if (code === "ECONNREFUSED")
    return new ProbeError("refused", `Connection refused: nothing is listening on ${where}`);
  if (code === "ENOTFOUND" || code === "EAI_AGAIN")
    return new ProbeError("dns", `Couldn't resolve ${where}`);
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "ECONNRESET")
    return new ProbeError("unreachable", `Can't reach ${where} (${code})`);
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT")
    return new ProbeError("connect-timeout", `Connecting to ${where} timed out`);
  if (code && /CERT|TLS|SSL/.test(code))
    return new ProbeError("tls", `A secure connection to ${where} failed (${code})`);
  // Fetch refuses some ports outright (https://fetch.spec.whatwg.org/#port-blocking).
  if (record(error) && record(error["cause"]) && error["cause"]["message"] === "bad port")
    return new ProbeError(
      "failed",
      `Fetch won't connect to port-blocked ${where}. Use another port`,
    );
  return new ProbeError("failed", `The request to ${where} failed${code ? ` (${code})` : ""}`);
}

/**
 * Provider error codes Foom recognises. Only the code is read from an error body, and
 * only to choose one of these messages; the body's text is never shown or logged.
 */
const PROVIDER_CODES: Record<string, [ProbeFailure, string]> = {
  // OpenAI
  insufficient_quota: [
    "quota",
    "No quota left on this account. Add credit or check billing at the provider",
  ],
  rate_limit_exceeded: ["rate-limited", "Rate limited. Try again shortly"],
  invalid_api_key: ["auth", "The key was rejected"],
  model_not_found: ["model-missing", "The provider doesn't offer this model to this key"],
  // Anthropic
  authentication_error: ["auth", "The key was rejected"],
  permission_error: ["auth", "The key isn't allowed to use this model"],
  not_found_error: ["model-missing", "The provider doesn't offer this model to this key"],
  rate_limit_error: ["rate-limited", "Rate limited. Try again shortly"],
  overloaded_error: ["server-error", "The provider is overloaded. Try again shortly"],
  // Google
  UNAUTHENTICATED: ["auth", "The key was rejected"],
  PERMISSION_DENIED: ["auth", "The key isn't allowed to use this model"],
  NOT_FOUND: ["model-missing", "The provider doesn't offer this model to this key"],
  RESOURCE_EXHAUSTED: [
    "quota",
    "Quota or rate limit reached. Check usage and billing at the provider",
  ],
};

/** The provider's machine-readable error code, if it is one Foom knows. */
export async function providerCode(response: Response): Promise<string | undefined> {
  const body = await readLimited(response, 16_384)
    .then((text): unknown => JSON.parse(text))
    .catch(() => undefined);
  const error = record(body) && record(body["error"]) ? body["error"] : undefined;
  if (!error) return undefined;
  for (const key of ["code", "type", "status"]) {
    const value = error[key];
    if (typeof value === "string" && Object.hasOwn(PROVIDER_CODES, value)) return value;
  }
  return undefined;
}

export function httpFailure(
  status: number,
  model: string,
  ollama: boolean,
  code?: string,
): ProbeError {
  const known = code === undefined ? undefined : ([code, PROVIDER_CODES[code]] as const);
  if (known?.[1])
    return new ProbeError(known[1][0], `${known[1][1]} (HTTP ${String(status)}, ${known[0]})`);
  if (status === 401 || status === 403)
    return new ProbeError("auth", `The key was rejected (HTTP ${String(status)})`);
  if (status === 404)
    return new ProbeError(
      "model-missing",
      ollama
        ? `${model} isn't pulled. Run: ollama pull ${model}`
        : `Model ${model} wasn't found (HTTP 404)`,
    );
  if (status === 429)
    return new ProbeError("rate-limited", "Rate limited (HTTP 429). Try again shortly");
  if (status >= 500)
    return new ProbeError("server-error", `The server failed (HTTP ${String(status)})`);
  return new ProbeError("http", `Unexpected response (HTTP ${String(status)})`);
}
