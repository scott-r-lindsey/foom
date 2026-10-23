/** Corrupt one field at a time in a real contract fixture, retaining its siblings. */
export function* malformedValues(
  value: unknown,
  path = "$",
): Generator<{ path: string; value: unknown }> {
  if (value instanceof Uint8Array) {
    yield { path, value: [1, 2] };
  } else if (Array.isArray(value)) {
    const items: unknown[] = value;
    yield { path, value: {} };
    yield { path, value: [...items, undefined] };
    for (const [index, item] of items.entries()) {
      for (const bad of malformedValues(item, `${path}[${String(index)}]`)) {
        const copy: unknown[] = [...items];
        copy[index] = bad.value;
        yield { path: bad.path, value: copy };
      }
    }
  } else if (value !== null && typeof value === "object") {
    yield { path, value: [] };
    for (const [key, item] of Object.entries(value)) {
      for (const bad of malformedValues(item, `${path}.${key}`)) {
        yield { path: bad.path, value: { ...value, [key]: bad.value } };
      }
    }
  } else {
    const invalid =
      typeof value === "number"
        ? [NaN, Infinity, -Infinity, "1"]
        : typeof value === "string"
          ? [42]
          : typeof value === "boolean"
            ? ["true"]
            : [{}];
    for (const bad of invalid) yield { path, value: bad };
  }
}
