import type { HostRequest, HostResponse } from "./shared/terminal-host";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function text(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0")
  );
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
export function hostRequest(value: unknown): value is HostRequest {
  if (
    !record(value) ||
    !text(value["id"]) ||
    !integer(value["request"], 1, Number.MAX_SAFE_INTEGER)
  )
    return false;
  switch (value["type"]) {
    case "create": {
      const spec = value["spec"];
      return (
        (value["dark"] === undefined || typeof value["dark"] === "boolean") &&
        record(spec) &&
        text(spec["command"]) &&
        text(spec["cwd"]) &&
        Array.isArray(spec["args"]) &&
        spec["args"].length <= 256 &&
        spec["args"].every(
          (arg: unknown) => typeof arg === "string" && arg.length <= 65536 && !arg.includes("\0"),
        ) &&
        (spec["env"] === undefined ||
          (record(spec["env"]) &&
            !Array.isArray(spec["env"]) &&
            Object.entries(spec["env"]).every(
              ([key, value]) =>
                /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
                typeof value === "string" &&
                !value.includes("\0"),
            ))) &&
        integer(spec["cols"], 2, 500) &&
        integer(spec["rows"], 2, 300)
      );
    }
    case "theme":
      return typeof value["dark"] === "boolean";
    case "attach":
      return text(value["view"]);
    case "shutdown":
    case "detach":
    case "kill":
      return true;
    case "write":
      return typeof value["data"] === "string" && value["data"].length <= 65536;
    case "resize":
      return integer(value["cols"], 2, 500) && integer(value["rows"], 2, 300);
    case "acknowledge":
      return text(value["token"]) && integer(value["count"], 1, Number.MAX_SAFE_INTEGER);
    case "tail":
      return integer(value["lines"], 1, 10000);
    default:
      return false;
  }
}
export function hostResponse(value: unknown): value is HostResponse {
  if (!record(value) || !text(value["id"])) return false;
  switch (value["type"]) {
    case "result":
      return (
        integer(value["request"], 1, Number.MAX_SAFE_INTEGER) &&
        Array.isArray(value["lines"]) &&
        value["lines"].length <= 10000 &&
        value["lines"].every((line: unknown) => typeof line === "string")
      );
    case "error":
      return integer(value["request"], 1, Number.MAX_SAFE_INTEGER);
    case "data":
      return text(value["view"]) && text(value["token"]) && typeof value["data"] === "string";
    case "exit":
      return integer(value["code"], -2147483648, 4294967295);
    default:
      return false;
  }
}
