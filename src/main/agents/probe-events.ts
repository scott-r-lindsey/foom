import type { ManifestChannel } from "../../shared/agent-manifest-v2";
import type { HookSignal } from "../../shared/hooks";
import { selectValue } from "./providers/v2-events";

/** Only bounded, validated field names and mapping facts survive the request. */
export function probeHookEvent(
  channel: ManifestChannel,
  payload: unknown,
  event: unknown,
  sequence: unknown,
  expected: string | undefined,
  signal: HookSignal | undefined,
) {
  const sources = { payload, header: { "X-Foom-Event": event, "X-Foom-Sequence": sequence } };
  const name = selectValue(channel.mapping.event, sources);
  const paths: string[] = [];
  const visit = (value: unknown, prefix: string, depth: number): void => {
    if (depth === 4 || typeof value !== "object" || value === null) return;
    for (const key of Object.keys(value)) {
      if (paths.length === 128) return;
      // Keys themselves are untrusted: omit controls, ambiguous paths and oversized names.
      if (!/^[A-Za-z0-9_-]{1,64}$/u.test(key)) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      if (path.length > 256) continue;
      paths.push(path);
      visit(Reflect.get(value, key), path, depth + 1);
    }
  };
  visit(payload, "", 0);
  return {
    channel: channel.id,
    event: typeof name === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(name) ? name : null,
    caseId: signal?.caseId ?? null,
    paths,
    sessionMatchesNewId:
      expected !== undefined && selectValue(channel.mapping.session, sources) === expected,
  };
}
export type ProbeHookEvent = ReturnType<typeof probeHookEvent>;

export interface ProbeHookObserver {
  expected(): string | undefined;
  receive(event: ProbeHookEvent): void;
}
