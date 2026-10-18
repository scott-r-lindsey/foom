import type { ManifestCondition, ManifestSelector } from "./agent-manifest-v2";
type Facts = Readonly<Record<string, unknown>>;
export function selected(
  when: ManifestCondition | undefined,
  facts: Facts,
  resolve?: (field: ManifestSelector) => unknown,
): boolean {
  const test = (entry: NonNullable<ManifestCondition["all"]>[number]) => {
    const key = typeof entry.field === "string" ? entry.field : String(entry.field.path[0]);
    const value =
      typeof entry.field !== "string" && resolve
        ? resolve(entry.field)
        : Object.hasOwn(facts, key)
          ? facts[key]
          : undefined;
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
    !when || (when.all?.every(test) !== false && (when.any === undefined || when.any.some(test)))
  );
}
