import { forgeHost } from "../../shared/forge-manifest";

function validForgeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-z][a-z0-9-]{0,39}$/u.test(value) &&
    !["__proto__", "constructor", "prototype"].includes(value)
  );
}

function entries(value: unknown): [string, unknown][] {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid forge settings");
  const result = Object.entries(value);
  if (result.length > 100) throw new Error("Too many forge settings");
  return result;
}

function exactHostname(host: string): boolean {
  if (!forgeHost(host) || ["__proto__", "constructor", "prototype"].includes(host)) return false;
  try {
    // Reject alternative numeric IP spellings and any URL-normalized hostname.
    return new URL(`https://${host}`).hostname === host;
  } catch {
    return false;
  }
}

export function parseForgeEnablement(value: unknown): Readonly<Record<string, boolean>> {
  return Object.fromEntries(
    entries(value).map(([id, enabled]) => {
      if (!validForgeId(id) || typeof enabled !== "boolean")
        throw new Error("Invalid forge enablement");
      return [id, enabled];
    }),
  );
}

/** Exact lowercase DNS names only. No URL normalization or inferred host authority. */
export function parseForgeHosts(value: unknown): Readonly<Record<string, string>> {
  return Object.fromEntries(
    entries(value).map(([host, id]) => {
      if (!exactHostname(host) || typeof id !== "string" || !validForgeId(id))
        throw new Error("Use a lowercase DNS hostname and a valid forge.");
      return [host, id];
    }),
  );
}
