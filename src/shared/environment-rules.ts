import type { EnvironmentScope } from "./environment";

/** Rules shared by Settings (inline reasons) and main (authoritative, on save and launch). */
export const ENVIRONMENT_SCOPES: readonly EnvironmentScope[] = ["all", "claude", "codex", "agy"];
export const ENVIRONMENT_VALUE_LIMIT = 4096;
export const ENVIRONMENT_NAME_LIMIT = 256;
export const ENVIRONMENT_ROW_LIMIT = 64;
/** Appended to NO_PROXY and no_proxy whenever a proxy is set, so Foom's endpoints stay direct. */
export const LOOPBACK = ["localhost", "127.0.0.1", "::1"] as const;

/** Proxy and certificate variables offered by Import from login shell. */
export const IMPORTABLE = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
] as const;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = /^(?:FOOM_.*|CLAUDECODE|TERM|COLORTERM|TERM_PROGRAM)$/;
// Each of these loads code into whatever runs.
const REFUSED =
  /^(?:LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*|NODE_OPTIONS|ELECTRON_.*|BASH_ENV|ENV|PROMPT_COMMAND)$/;

export function isProxyName(name: string): boolean {
  return /^(?:https?|all)_proxy$/i.test(name);
}

export function isPathName(name: string): boolean {
  return name.toUpperCase() === "PATH";
}

/** Windows environment names are case-insensitive. */
export function foldName(name: string, windows: boolean): string {
  return windows ? name.toUpperCase() : name;
}

/** A URL with user information, such as `http://user:pass@proxy`. Always stored as a secret. */
export function hasUrlCredentials(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/?#@\s]+@/i.test(value.trim());
}

/** The user information of a URL value, for redaction, or null. */
export function urlCredentials(value: string): string | null {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#@\s]+)@/i.exec(value.trim());
  return match?.[1] ?? null;
}

/**
 * Shows a URL with its password replaced, for import candidates. A user name alone may
 * be a token, so it is masked too.
 */
export function maskCredentials(value: string): string {
  return value.replace(
    /^(\s*[a-z][a-z0-9+.-]*:\/\/)([^/?#@\s:]*)(:[^/?#@\s]*)?@/i,
    (_match, scheme: string, user: string, password?: string) =>
      `${scheme}${user && password ? `${user}:` : ""}••••@`,
  );
}

export function nameProblem(name: string): string | null {
  if (name.length > ENVIRONMENT_NAME_LIMIT) return "Names are at most 256 characters";
  if (!NAME.test(name)) return "Names use letters, digits and _, and can't start with a digit";
  const upper = name.toUpperCase();
  if (RESERVED.test(upper)) return `${name} is reserved by Foom`;
  if (REFUSED.test(upper)) return `${name} can't be set: it loads code into every process`;
  return null;
}

function absoluteDirectory(entry: string, windows: boolean): boolean {
  return windows
    ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(entry)
    : entry.startsWith("/");
}

export function valueProblem(name: string, value: string, windows: boolean): string | null {
  if (value.includes("\0")) return "Values can't contain NUL";
  if (value.length > ENVIRONMENT_VALUE_LIMIT) return "Values are at most 4096 characters";
  if (isPathName(name)) {
    const entries = value.split(windows ? ";" : ":");
    if (!entries.every((entry) => entry !== "" && absoluteDirectory(entry, windows)))
      return "PATH entries must be absolute directories";
  }
  if (isProxyName(name) && value !== "") {
    let host = "";
    try {
      host = /^(?:https?|socks5):\/\/\S+$/i.test(value) ? new URL(value).hostname : "";
    } catch {
      // Reported below.
    }
    if (!host) return "Must be an http://, https:// or socks5:// URL";
  }
  return null;
}

export function environmentProblem(name: string, value: string, windows: boolean): string | null {
  return nameProblem(name) ?? valueProblem(name, value, windows);
}
