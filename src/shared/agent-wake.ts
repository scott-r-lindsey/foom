import { wake } from "./agent-manifest-schema";
import type { AgentManifestV2 } from "./agent-manifest-v2";

export type WakePolicy = NonNullable<AgentManifestV2["wake"]>;
export interface WakeInput {
  policy: WakePolicy;
  step: "check" | "cancel" | "submit";
  line: string;
}

/** Only a fixed metadata template can cross the host boundary. */
export function wakeLine(names: readonly string[]): string {
  const clean = names
    .slice(0, 4)
    .map((name) => name.replace(/[^A-Za-z0-9._-]/gu, "").slice(0, 48) || "child");
  return `Foom: child events for ${clean.join(", ")}${names.length > 4 ? " and other children" : ""}. Call wait_for and read_handoff.`;
}
export function isWakeInput(value: unknown): value is WakeInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const fields: Record<string, unknown> = { ...value };
  if (Object.keys(fields).sort().join() !== "line,policy,step") return false;
  if (fields["step"] !== "check" && fields["step"] !== "cancel" && fields["step"] !== "submit")
    return false;
  if (
    typeof fields["line"] !== "string" ||
    !/^Foom: child events for [A-Za-z0-9._-]{1,48}(?:, [A-Za-z0-9._-]{1,48}){0,3}(?: and other children)?\. Call wait_for and read_handoff\.$/u.test(
      fields["line"],
    )
  )
    return false;
  try {
    wake(fields["policy"], "wake");
    return true;
  } catch {
    return false;
  }
}

/** Positive composer plus all layout anchors, vetoed by any prompt/menu marker. */
export function readyComposer(
  policy: WakePolicy,
  lines: readonly string[],
  cursor: number,
): boolean {
  if (lines.length === 0 || lines.length > 300 || lines.some((line) => line.length > 500))
    return false;
  const current = lines[cursor]?.replaceAll("\u00a0", " ").trim();
  if (current === undefined || !policy.composer.some((line) => line === (current || "empty")))
    return false;
  const text = lines.join("\n").toLowerCase();
  return (
    policy.contains.every((part) => text.includes(part.toLowerCase())) &&
    !policy.reject.some((part) => text.includes(part.toLowerCase()))
  );
}
