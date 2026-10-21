import type { PullRequest } from "./forge.d";

export function forgeBranch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    !value.startsWith("-") &&
    !/[\p{Cc}\p{Cf}\s~^:?*[\\]/u.test(value) &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.endsWith(".") &&
    value
      .split("/")
      .every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"))
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

/** Whitelist persisted and public metadata as well as network output. */
export function pullRequest(value: unknown): PullRequest | undefined {
  const data = record(value);
  if (
    !data ||
    typeof data["number"] !== "number" ||
    !Number.isSafeInteger(data["number"]) ||
    data["number"] <= 0 ||
    typeof data["headSha"] !== "string" ||
    !/^[a-f0-9]{40}$/u.test(data["headSha"]) ||
    (data["state"] !== "OPEN" && data["state"] !== "CLOSED" && data["state"] !== "MERGED") ||
    (data["requiredChecks"] !== "pending" &&
      data["requiredChecks"] !== "success" &&
      data["requiredChecks"] !== "failure" &&
      data["requiredChecks"] !== "none" &&
      data["requiredChecks"] !== "unknown")
  )
    return undefined;
  const title = forgeTitle(data["title"]);
  const sourceName = forgeTitle(data["sourceName"]);
  const url = forgeWebUrl(data["url"]);
  return {
    number: data["number"],
    headSha: data["headSha"],
    ...(typeof data["mergeCommit"] === "string" && /^[a-f0-9]{40,64}$/u.test(data["mergeCommit"])
      ? { mergeCommit: data["mergeCommit"] }
      : {}),
    ...(data["checksMeaning"] === "required" ||
    data["checksMeaning"] === "head-pipeline" ||
    data["checksMeaning"] === "commit-status"
      ? { checksMeaning: data["checksMeaning"] }
      : {}),
    ...(title === undefined ? {} : { title }),
    ...(sourceName === undefined ? {} : { sourceName }),
    ...(url === undefined ? {} : { url }),
    state: data["state"],
    requiredChecks: data["requiredChecks"],
  };
}

/** Display text is bounded before removing invisible and non-text characters. */
export function forgeTitle(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 1024
    ? value.replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}\u2028\u2029]/gu, "")
    : undefined;
}

/** Reject raw spellings that URL normalization could conceal. */
export function forgeWebUrl(value: unknown, host?: string): string | undefined {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    !/^https:\/\/[A-Za-z0-9.-]+(?:[/?#]|$)/u.test(value) ||
    /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\s\\]/u.test(value)
  )
    return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      (host === undefined || url.hostname === host)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}
