import type {
  ManifestChannel,
  ManifestCondition,
  ManifestSelector,
} from "../../../shared/agent-manifest-v2";
import type { HookSignal } from "../../../shared/hooks";
import { conversationId } from "../../../shared/conversation";

export type { V2HookState } from "../../../shared/v2-hooks";
import type { V2HookState } from "../../../shared/v2-hooks";
export function selectValue(
  selector: ManifestSelector,
  sources: Readonly<Record<string, unknown>>,
): unknown {
  let value = sources[selector.source];
  for (const key of selector.path) {
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, key)) return undefined;
    value = Reflect.get(value, key);
  }
  return value;
}
export function eventCondition(
  condition: ManifestCondition | undefined,
  sources: Readonly<Record<string, unknown>>,
  facts: Readonly<Record<string, unknown>>,
): boolean {
  const test = (entry: NonNullable<ManifestCondition["all"]>[number]) => {
    const value =
      typeof entry.field === "string" ? facts[entry.field] : selectValue(entry.field, sources);
    switch (entry.op) {
      case "exists":
        return value !== undefined;
      case "absent":
        return value === undefined;
      case "eq":
        return value !== undefined && value === entry.value;
      case "in":
        return (
          value !== undefined &&
          Array.isArray(entry.value) &&
          entry.value.some((candidate) => candidate === value)
        );
      case "lt":
        return (
          typeof value === "number" &&
          Number.isSafeInteger(value) &&
          typeof entry.value === "number" &&
          value < entry.value
        );
      case "gte":
        return (
          typeof value === "number" &&
          Number.isSafeInteger(value) &&
          typeof entry.value === "number" &&
          value >= entry.value
        );
    }
  };
  return (
    !condition ||
    (condition.all?.every(test) !== false &&
      (condition.any === undefined || condition.any.some(test)))
  );
}
/** Called only after receiver authentication. Validate completely before pin/cache mutation. */
export function reduceV2(
  channel: ManifestChannel,
  state: V2HookState,
  terminalId: string,
  agent: string,
  payload: unknown,
  event: unknown,
  sequenceHeader: unknown,
): HookSignal | undefined {
  const sources = { payload, header: { "X-Foom-Event": event, "X-Foom-Sequence": sequenceHeader } };
  const mapping = channel.mapping;
  const id = selectValue(mapping.session, sources);
  if (!conversationId(id) || (state.conversation !== undefined && state.conversation !== id))
    throw new Error("Invalid conversation");
  const name = selectValue(mapping.event, sources);
  if (typeof name !== "string" || name.length === 0 || name.length > 64)
    throw new Error("Invalid event");
  const cases = mapping.cases.filter((entry) => entry.event === name);
  const first = cases[0];
  if (!first) return;
  for (const rule of first.require) {
    const value = selectValue(rule.field, sources);
    const valid =
      rule.type === "boolean"
        ? typeof value === "boolean"
        : rule.type === "integer"
          ? typeof value === "number" && Number.isSafeInteger(value) && value >= 0
          : rule.type === "conversation"
            ? conversationId(value)
            : rule.type === "identifier"
              ? typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/u.test(value)
              : typeof value === "string" && value.length > 0 && value.length <= 200;
    if (!valid || (rule.values && !rule.values.some((candidate) => candidate === value)))
      throw new Error("Invalid required field");
  }
  let sequence: number | undefined;
  if (mapping.sequence) {
    const raw = selectValue(mapping.sequence, sources);
    if (typeof raw !== "string" || !/^[1-9][0-9]{0,9}$/u.test(raw) || Number(raw) > 2147483647)
      throw new Error("Invalid sequence");
    sequence = Number(raw);
  }
  let dedupe: string | undefined;
  if (mapping.dedupe) {
    const raw = selectValue(mapping.dedupe, sources);
    if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{1,200}$/u.test(raw))
      throw new Error("Invalid dedupe ID");
    dedupe = raw;
  }
  for (const entry of cases) {
    const facts: Record<string, unknown> = {};
    for (const extractor of entry.facts) {
      const raw = selectValue(extractor.field, sources);
      const value =
        typeof raw === "string" && extractor.aliases && Object.hasOwn(extractor.aliases, raw)
          ? extractor.aliases[raw]
          : raw;
      if (
        extractor.name === "fullyIdle"
          ? typeof value !== "boolean"
          : !["model_stop", "max_steps_exceeded", "error"].includes(String(value))
      )
        throw new Error("Invalid normalized fact");
      facts[extractor.name] = value;
    }
    const conditionFacts = { ...state.launchFacts, ...facts };
    if (!eventCondition(entry.when, { ...sources, facts: conditionFacts }, conditionFacts))
      continue;
    const stream = state.channels?.get(channel.id);
    if (
      (sequence !== undefined && stream?.sequence !== undefined && sequence <= stream.sequence) ||
      (dedupe !== undefined && stream?.completed?.has(dedupe))
    )
      return;
    state.conversation = id;
    const accepted = stream ?? {};
    state.channels ??= new Map();
    state.channels.set(channel.id, accepted);
    if (sequence !== undefined) accepted.sequence = sequence;
    if (dedupe !== undefined) {
      accepted.completed ??= new Set();
      accepted.completed.add(dedupe);
      if (accepted.completed.size > 128) {
        const oldest = accepted.completed.values().next().value;
        if (oldest !== undefined) accepted.completed.delete(oldest);
      }
    }
    const reason = facts["terminationReason"];
    return {
      terminalId,
      conversationId: id,
      action: entry.action,
      signal: `plugin:${agent}:${entry.id}`,
      channel: channel.id,
      caseId: entry.id,
      endsTurn: entry.endsTurn ?? (entry.action === "classify" || entry.action === "failed"),
      recoverTurn: entry.recoverTurn,
      ...(reason === "model_stop" || reason === "max_steps_exceeded" || reason === "error"
        ? { terminationReason: reason }
        : {}),
      ...(typeof facts["fullyIdle"] === "boolean" ? { fullyIdle: facts["fullyIdle"] } : {}),
    };
  }
  return;
}
