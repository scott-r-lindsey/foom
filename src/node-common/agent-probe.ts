import { ControlError, exact, object } from "./control-validation";
import { validAgentId } from "../shared/providers/catalog";
import type { CaptureState } from "../shared/probe-capture";
import { conversationId } from "../shared/conversation";

export const PROBE_KEYS = {
  esc: "\x1b",
  "ctrl-c": "\x03",
  enter: "\r",
  up: "\x1b[A",
  down: "\x1b[B",
  tab: "\t",
};
export type ProbeRequest =
  | { action: "config-status" }
  | { action: "test-rules"; agent: string }
  | { action: "screen"; probe: string; save?: CaptureState }
  | { action: "start"; agent: string; manifest?: string; resume?: string }
  | { action: "send"; probe: string; text: string }
  | { action: "keys"; probe: string; key: keyof typeof PROBE_KEYS }
  | { action: "wait"; probe: string; quiet?: number; timeout?: number }
  | { action: "state" | "stop"; probe: string };
const invalid = (): never => {
  throw new ControlError("invalid_request");
};
export function probeRequest(input: unknown): ProbeRequest {
  const value = object(input);
  const action = value["action"];
  if (action === "config-status") {
    exact(value, ["action"]);
    return { action };
  }
  if (action === "test-rules") {
    exact(value, ["action", "agent"]);
    if (!validAgentId(value["agent"])) return invalid();
    return { action, agent: value["agent"] };
  }
  if (action === "start") {
    exact(value, ["action", "agent", "manifest", "resume"]);
    const agent = value["agent"];
    const manifest = value["manifest"];
    const resume = value["resume"];
    if (!validAgentId(agent) || agent === "shell") return invalid();
    if (
      manifest !== undefined &&
      (typeof manifest !== "string" ||
        !manifest.length ||
        manifest.length > 4096 ||
        /[\p{Cc}\p{Cf}]/u.test(manifest))
    )
      return invalid();
    if (resume !== undefined && !conversationId(resume)) return invalid();
    return {
      action,
      agent,
      ...(typeof manifest === "string" ? { manifest } : {}),
      ...(typeof resume === "string" ? { resume } : {}),
    };
  }
  const probe = value["probe"];
  if (typeof probe !== "string" || !/^[a-f0-9]{64}$/u.test(probe)) return invalid();
  switch (action) {
    case "send": {
      exact(value, ["action", "probe", "text"]);
      const text = value["text"];
      // Named control keys have their own route; ordinary prompt text may contain LF and TAB.
      if (
        typeof text !== "string" ||
        Buffer.byteLength(text) > 16384 ||
        /[^\P{Cc}\n\t]|\p{Cf}/u.test(text)
      )
        return invalid();
      return { action, probe, text };
    }
    case "keys": {
      exact(value, ["action", "probe", "key"]);
      const key = value["key"];
      if (
        key !== "esc" &&
        key !== "ctrl-c" &&
        key !== "enter" &&
        key !== "up" &&
        key !== "down" &&
        key !== "tab"
      )
        return invalid();
      return { action, probe, key };
    }
    case "wait": {
      exact(value, ["action", "probe", "quiet", "timeout"]);
      const quiet = value["quiet"];
      const timeout = value["timeout"];
      const seconds = quiet ?? timeout;
      if (
        (quiet === undefined) === (timeout === undefined) ||
        typeof seconds !== "number" ||
        !Number.isFinite(seconds) ||
        seconds <= 0 ||
        seconds > 600
      )
        return invalid();
      return {
        action,
        probe,
        ...(quiet === undefined ? { timeout: seconds } : { quiet: seconds }),
      };
    }
    case "screen": {
      exact(value, ["action", "probe", "save"]);
      const save = value["save"];
      if (
        save !== undefined &&
        save !== "working" &&
        save !== "blocked" &&
        save !== "idle" &&
        save !== "other"
      )
        return invalid();
      return { action, probe, ...(save === undefined ? {} : { save }) };
    }
    case "state":
    case "stop":
      exact(value, ["action", "probe"]);
      return { action, probe };
    default:
      return invalid();
  }
}
export function probeCommand(words: readonly string[]): ProbeRequest {
  const [action, id, ...rest] = words;
  if (action === "start") {
    const value: Record<string, unknown> = { action, agent: id };
    for (let i = 0; i < rest.length; i += 2) {
      const flag = rest[i];
      const key = flag === "--manifest" ? "manifest" : flag === "--resume" ? "resume" : invalid();
      if (value[key] !== undefined || rest[i + 1] === undefined) return invalid();
      value[key] = rest[i + 1];
    }
    return probeRequest(value);
  }
  if (action === "send" || action === "keys") {
    if (rest.length !== 1) return invalid();
    return probeRequest({ action, probe: id, [action === "send" ? "text" : "key"]: rest[0] });
  }
  if (action === "wait") {
    if (
      rest.length !== 2 ||
      !["--quiet", "--timeout"].includes(rest[0] ?? "") ||
      !/^(?:\d+)(?:\.\d+)?$/u.test(rest[1] ?? "")
    )
      return invalid();
    return probeRequest({
      action,
      probe: id,
      [rest[0] === "--quiet" ? "quiet" : "timeout"]: Number(rest[1]),
    });
  }
  if (action === "screen" && rest.length === 2 && rest[0] === "--save")
    return probeRequest({ action, probe: id, save: rest[1] });
  if (rest.length) return invalid();
  return probeRequest({ action, probe: id });
}
