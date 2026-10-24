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

/** Add structured-cloneable unknown data at every object/array boundary. */
export function withUndeclaredFields(
  value: unknown,
  dictionaries: ReadonlySet<string> = new Set(),
  path = "$",
): unknown {
  const extra = { unexpected: { text: {} }, __proto__: null };
  if (value instanceof Uint8Array) {
    const copy = Uint8Array.from(value);
    Object.defineProperty(copy, "unexpected", { value: extra, enumerable: true });
    return copy;
  }
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    const copy = items.map((entry, index) =>
      withUndeclaredFields(entry, dictionaries, `${path}[${String(index)}]`),
    );
    Object.defineProperty(copy, "unexpected", { value: extra, enumerable: true });
    return copy;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries([
      ...Object.entries(value).map(([key, entry]) => [
        key,
        withUndeclaredFields(entry, dictionaries, `${path}.${key}`),
      ]),
      ...(dictionaries.has(path)
        ? []
        : [
            ["unexpected", extra],
            ["__proto__", { changes: {} }],
            ["constructor", extra],
          ]),
    ]);
  }
  return value;
}
