import { fail } from "./agent-manifest-values";
/** Parse before schema validation so duplicate decoded members cannot disappear. */
export function manifestJson(source: string): unknown {
  if (new TextEncoder().encode(source).length > 65536) fail("$", "too-large");
  if (/\p{Cs}/u.test(source)) fail("$", "malformed-json");
  let offset = 0;
  let nodes = 0;
  const space = () => {
    while (/[ \n\r\t]/u.test(source[offset] ?? "!")) offset++;
  };
  const token = (): string => {
    space();
    const match =
      /^(?:"(?:[^"\\\p{Cc}]|[\u007f-\u009f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null)/u.exec(
        source.slice(offset),
      );
    if (!match) fail("$", "malformed-json");
    offset += match[0].length;
    return match[0];
  };
  const take = (character: string) => {
    space();
    if (source[offset] !== character) fail("$", "malformed-json");
    offset++;
  };
  const parse = (depth: number): unknown => {
    if (++nodes > 8192) fail("$", "too-many-nodes");
    if (depth > 24) fail("$", "too-deep");
    space();
    if (source[offset] === "{") {
      offset++;
      const result: Record<string, unknown> = {};
      const keys = new Set<string>();
      space();
      if (source[offset] !== "}") {
        while (offset < source.length) {
          const raw = token();
          if (!raw.startsWith('"')) fail("$", "malformed-json");
          const key: unknown = JSON.parse(raw);
          if (typeof key !== "string") fail("$", "malformed-json");
          if (["__proto__", "prototype", "constructor"].includes(key)) fail("$", "unsafe-key");
          if (keys.has(key)) fail("$", "duplicate-key");
          keys.add(key);
          take(":");
          Object.defineProperty(result, key, { value: parse(depth + 1), enumerable: true });
          space();
          if (source[offset] !== ",") break;
          offset++;
        }
      }
      take("}");
      return result;
    }
    if (source[offset] === "[") {
      offset++;
      const result: unknown[] = [];
      space();
      if (source[offset] !== "]") {
        while (offset < source.length) {
          result.push(parse(depth + 1));
          space();
          if (source[offset] !== ",") break;
          offset++;
        }
      }
      take("]");
      return result;
    }
    const result: unknown = JSON.parse(token());
    if (typeof result === "number" && !Number.isFinite(result)) fail("$", "invalid-value");
    return result;
  };
  const result = parse(1);
  space();
  if (offset !== source.length) fail("$", "malformed-json");
  return result;
}
