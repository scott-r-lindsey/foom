import type { AgentEvidence } from "./agent-detection";

export function cleanTitle(title: string): string {
  return title.slice(0, 512).replace(/[\p{Cc}\p{Cf}]/gu, "");
}

/** OSC 9;4 has a state (0–4) and optional percentage, never arbitrary text. */
export function parseProgress(data: string): AgentEvidence["progress"] {
  const match = /^4;([0-4])(?:;([0-9]{1,3}))?$/.exec(data);
  if (!match) return null;
  const value = match[2] === undefined ? null : Number(match[2]);
  if (value !== null && value > 100) return null;
  return { state: Number(match[1]), value };
}

export function isAgentEvidence(value: unknown): value is AgentEvidence {
  if (typeof value !== "object" || value === null) return false;
  if (
    !("title" in value) ||
    typeof value.title !== "string" ||
    cleanTitle(value.title) !== value.title
  )
    return false;
  if (!("progress" in value)) return false;
  const progress = value.progress;
  return (
    progress === null ||
    (typeof progress === "object" &&
      "state" in progress &&
      typeof progress.state === "number" &&
      Number.isInteger(progress.state) &&
      progress.state >= 0 &&
      progress.state <= 4 &&
      "value" in progress &&
      (progress.value === null ||
        (typeof progress.value === "number" &&
          Number.isInteger(progress.value) &&
          progress.value >= 0 &&
          progress.value <= 100)))
  );
}
