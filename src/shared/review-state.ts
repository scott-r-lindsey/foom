import { conversationId } from "./conversation";
import { validAgentId } from "./providers/catalog";
import type { ReviewState } from "./review";

/** Validated presentation metadata grants no authority or automatic restore. */
export function isReviewState(value: unknown): value is ReviewState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const data: Record<string, unknown> = { ...value };
  return (
    Object.keys(data).every((key) =>
      [
        "authorId",
        "round",
        "phase",
        "model",
        "effort",
        "rounds",
        "agent",
        "postFindings",
        "parentWaitMinutes",
        "reason",
        "waiting",
      ].includes(key),
    ) &&
    ["model", "effort"].every(
      (key) =>
        data[key] === undefined ||
        (typeof data[key] === "string" &&
          data[key].trim() === data[key] &&
          /^[A-Za-z0-9._:/][A-Za-z0-9._:/-]{0,63}$/u.test(data[key])),
    ) &&
    conversationId(data["authorId"]) &&
    validAgentId(data["agent"]) &&
    typeof data["rounds"] === "number" &&
    Number.isInteger(data["rounds"]) &&
    data["rounds"] >= 1 &&
    data["rounds"] <= 5 &&
    typeof data["round"] === "number" &&
    Number.isInteger(data["round"]) &&
    data["round"] >= 0 &&
    data["round"] <= data["rounds"] &&
    typeof data["postFindings"] === "boolean" &&
    (data["parentWaitMinutes"] === undefined ||
      (typeof data["parentWaitMinutes"] === "number" &&
        Number.isInteger(data["parentWaitMinutes"]) &&
        data["parentWaitMinutes"] >= 1 &&
        data["parentWaitMinutes"] <= 1440)) &&
    typeof data["phase"] === "string" &&
    ["building", "reviewing", "fixing", "waiting-on-parent", "clean", "escalated"].includes(
      data["phase"],
    ) &&
    (data["waiting"] === undefined || typeof data["waiting"] === "boolean") &&
    (data["phase"] === "escalated"
      ? typeof data["reason"] === "string" &&
        [
          "round cap",
          "author blocked",
          "author failed",
          "reviewer blocked",
          "reviewer failed",
          "missing handoff",
          "missing verdict",
          "checks not green",
          "worktree changed",
          "launch failed",
          "resume unavailable",
          "stopped",
          "restored",
        ].includes(data["reason"])
      : data["reason"] === undefined)
  );
}

export function reviewLabel(state: ReviewState): string {
  switch (state.phase) {
    case "building":
      return "Building";
    case "reviewing":
      return `Reviewing ${String(state.round)}/${String(state.rounds)}${state.waiting ? " · Waiting for slot" : ""}`;
    case "fixing":
      return `Fixing ${String(state.round)}/${String(state.rounds)}${state.waiting ? " · Waiting for slot" : ""}`;
    case "waiting-on-parent":
      return "Waiting on parent";
    case "clean":
      return "Review clean";
    case "escalated":
      return `Escalated: ${state.reason ?? "stopped"}`;
  }
}
