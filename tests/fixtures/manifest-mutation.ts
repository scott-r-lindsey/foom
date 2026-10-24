export function changed(fixture: unknown, path: string, value: unknown, remove = false): string {
  const draft: unknown = structuredClone(fixture);
  let parent: unknown = draft;
  const keys = path.split(".");
  const last = keys.pop();
  for (const key of keys) {
    if (typeof parent !== "object" || parent === null) throw Error("Bad test path");
    parent = Reflect.get(parent, key);
  }
  if (typeof parent !== "object" || parent === null || last === undefined)
    throw Error("Bad test path");
  if (remove) Reflect.deleteProperty(parent, last);
  else Reflect.set(parent, last, value);
  return JSON.stringify(draft);
}
