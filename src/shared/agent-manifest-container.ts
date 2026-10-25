import { manifestJson } from "./agent-manifest-json";
import { parse as parseToml } from "smol-toml";
import { fail, isRecord, multiline, text } from "./agent-manifest-values";
/** Parse full TOML documents and native inline values with the same data validator. */
function boundedContainer(value: unknown, path: string): unknown {
  let nodes = 0;
  const visit = (entry: unknown, depth: number) => {
    if (++nodes > 8192 || depth > 24) fail(path, "invalid-template");
    if (typeof entry === "string") multiline(entry, path);
    else if (typeof entry === "number" && !Number.isFinite(entry)) fail(path, "invalid-template");
    else if (Array.isArray(entry)) for (const item of entry) visit(item, depth + 1);
    else if (typeof entry === "object" && entry !== null) {
      if (
        Object.getPrototypeOf(entry) !== Object.prototype &&
        Object.getPrototypeOf(entry) !== null
      )
        fail(path, "invalid-template");
      for (const [key, item] of Object.entries(entry)) {
        text(key, path);
        if (["__proto__", "prototype", "constructor"].includes(key)) fail(path, "unsafe-key");
        visit(item, depth + 1);
      }
    }
  };
  visit(value, 1);
  return value;
}
export function tomlContainer(source: string, path: string, document = false): unknown {
  const options = { maxDepth: 24, unsafeKeyBehaviour: "throw" } as const;
  try {
    if (document) return boundedContainer(parseToml(source, options), path);
    try {
      const inline: unknown = parseToml(`foom = ${source}`, options);
      if (!isRecord(inline)) fail(path, "invalid-template");
      if (Object.keys(inline).length !== 1) fail(path, "invalid-template");
      return boundedContainer(inline["foom"], path);
    } catch {
      return boundedContainer(parseToml(source, options), path);
    }
  } catch {
    fail(path, "invalid-template");
  }
}

export function dataContainer(
  source: string,
  format: "json" | "toml",
  path: string,
  document = false,
): unknown {
  try {
    return format === "json"
      ? boundedContainer(manifestJson(source), path)
      : tomlContainer(source, path, document);
  } catch {
    fail(path, "invalid-template");
  }
}
/** Command slots have one generated native value; syntax added around it is refused. */
export function validateCommandSlots(
  value: unknown,
  commands: ReadonlySet<string>,
  argvs: ReadonlySet<string>,
  path: string,
  slot?: string,
  generated: ReadonlySet<string> = new Set(),
): void {
  if (typeof value === "string" && generated.has(value)) return;
  if (
    typeof value === "string" &&
    value.includes("FOOM_OBSERVER_") &&
    !commands.has(value) &&
    !argvs.has(value)
  )
    fail(path, "executable-template");
  if (
    typeof value === "string" &&
    !commands.has(value) &&
    !argvs.has(value) &&
    !["name", "version", "matcher", "type", "url", "authorization", "bearertokenenvvar"].includes(
      slot ?? "",
    )
  )
    fail(path, "executable-template");
  if (Array.isArray(value)) {
    for (const entry of value)
      validateCommandSlots(entry, commands, argvs, path, undefined, generated);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      if (
        Object.hasOwn(value, "type") &&
        Reflect.get(value, "type") === "command" &&
        !Object.hasOwn(value, "command")
      )
        fail(path, "executable-template");
      if (key.includes("FOOM_OBSERVER_")) fail(path, "executable-template");
      const normalized = key.toLowerCase().replaceAll(/[-_]/gu, "");
      if (
        [
          "script",
          "scripts",
          "commands",
          "module",
          "modules",
          "entrypoint",
          "executable",
          "exec",
          "program",
          "code",
          "handler",
          "handlers",
          "shell",
          "source",
        ].includes(normalized)
      )
        fail(path, "executable-template");
      if (normalized === "url" && entry !== "FOOM_MCP_URL_SENTINEL") fail(path, "invalid-template");
      if (normalized === "authorization" && entry !== "Bearer FOOM_AUTHORIZATION_SENTINEL")
        fail(path, "environment-reference");
      if (normalized === "bearertokenenvvar" && entry !== "FOOM_CONTROL_TOKEN")
        fail(path, "environment-reference");
      if (normalized === "type" && entry !== "command" && entry !== "http" && entry !== "remote")
        fail(path, "executable-template");
      if (
        normalized === "command" ||
        normalized === "cmd" ||
        normalized === "powershell" ||
        normalized === "bash"
      ) {
        if (typeof entry !== "string" || !commands.has(entry)) fail(path, "executable-template");
      } else if (normalized === "notify" || normalized === "argv") {
        if (
          !Array.isArray(entry) ||
          entry.length !== 1 ||
          typeof entry[0] !== "string" ||
          !argvs.has(entry[0])
        )
          fail(path, "executable-template");
      } else validateCommandSlots(entry, commands, argvs, path, normalized, generated);
    }
  }
}
