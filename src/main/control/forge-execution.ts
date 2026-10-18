import type { ForgeArgument, ForgeCommand, ForgeSlot } from "../../shared/forge-plugin";
import type { ForgeBindings, ForgeResponse } from "./forge.d";
import { forgeBranch } from "./forge";
import { forgeProject } from "./forge-mapping";
import { forgeHost } from "../../shared/forge-manifest";

export function expandForgeArguments(
  argv: readonly ForgeArgument[],
  bindings: ForgeBindings,
): string[] {
  const slot = (name: ForgeSlot): string => {
    const value = bindings[name];
    let valid: boolean;
    switch (name) {
      case "host":
        valid = typeof value === "string" && forgeHost(value);
        break;
      case "project":
        valid = typeof value === "string" && forgeProject(value, "nested");
        break;
      case "projectOwner":
      case "projectName":
        valid = typeof value === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/u.test(value);
        break;
      case "branch":
        valid = forgeBranch(value);
        break;
      case "number":
        valid = typeof value === "number" && Number.isSafeInteger(value) && value > 0;
        break;
      case "nodeId":
        valid = typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_+/=-]{0,199}$/u.test(value);
        break;
      case "query":
        valid = typeof value === "string" && Buffer.byteLength(value) <= 16384;
        break;
    }
    if (!valid || value === undefined) throw new Error("Invalid forge binding");
    return String(value);
  };
  const result = argv.map((arg) => {
    const query =
      typeof arg !== "string" &&
      arg.parts.some((part) => typeof part !== "string" && part.slot === "query");
    const expanded =
      typeof arg === "string"
        ? arg
        : arg.parts
            .map((part) =>
              typeof part === "string"
                ? part
                : part.encoding === "percent-component"
                  ? encodeURIComponent(slot(part.slot))
                  : slot(part.slot),
            )
            .join("");
    if (
      !expanded ||
      Buffer.byteLength(expanded) > 20480 ||
      (query
        ? /[^\P{Cc}\n\t]|[\p{Cf}\p{Co}\p{Cs}\u2028\u2029]/u
        : /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\u2028\u2029]/u
      ).test(expanded)
    )
      throw new Error("Invalid forge argument");
    return expanded;
  });
  if (result.reduce((total, arg) => total + Buffer.byteLength(arg), 0) > 65536)
    throw new Error("Forge arguments too large");
  return result;
}
export function forgeJson(response: ForgeResponse, command: ForgeCommand): unknown {
  if (
    Buffer.byteLength(response.stdout) > 256 * 1024 ||
    Buffer.byteLength(response.stderr) > 256 * 1024
  )
    throw new Error("Forge output too large");
  if (response.stdout === "") {
    for (const diagnostic of command.emptyDiagnostics) {
      const message = response.stderr.replace(/\r?\n$/u, "");
      if (
        response.code === diagnostic.exitCode &&
        message.startsWith(diagnostic.prefix) &&
        message.endsWith(diagnostic.suffix) &&
        forgeBranch(message.slice(diagnostic.prefix.length, -diagnostic.suffix.length))
      )
        return [];
    }
  }
  if (!command.jsonExitCodes.includes(response.code)) throw new Error("Forge unavailable");
  const parsed: unknown = JSON.parse(response.stdout);
  if (response.code !== 0 && !Array.isArray(parsed)) throw new Error("Invalid forge result");
  return parsed;
}
