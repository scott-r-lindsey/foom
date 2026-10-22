import type { ReviewOptions, ReviewVerdict } from "../shared/review";
import { validAgentId } from "../shared/providers/catalog";
import { ControlError, exact, object } from "./control-validation";

export function reviewOptions(value: unknown): ReviewOptions {
  const data = object(value);
  exact(data, ["rounds", "agent", "postFindings"]);
  const rounds = data["rounds"] === undefined ? 3 : data["rounds"];
  const agent = data["agent"] === undefined ? "claude" : data["agent"];
  const postFindings = data["postFindings"] === undefined ? false : data["postFindings"];
  if (
    typeof rounds !== "number" ||
    !Number.isInteger(rounds) ||
    rounds < 1 ||
    rounds > 5 ||
    !validAgentId(agent) ||
    typeof postFindings !== "boolean"
  )
    throw new ControlError("invalid_request");
  return { rounds, agent, postFindings };
}

function note(value: unknown, bytes: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Buffer.byteLength(value) > bytes ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  )
    throw new ControlError("invalid_request");
  return value;
}

export function reviewVerdict(value: unknown): ReviewVerdict {
  const data = object(value);
  exact(data, data["verdict"] === "clean" ? ["verdict"] : ["verdict", "findings"]);
  if (data["verdict"] === "clean") return { verdict: "clean" };
  const findings = data["findings"];
  if (
    data["verdict"] !== "findings" ||
    !Array.isArray(findings) ||
    findings.length < 1 ||
    findings.length > 10 ||
    Buffer.byteLength(JSON.stringify(data)) > 8192
  )
    throw new ControlError("invalid_request");
  return {
    verdict: "findings",
    findings: findings.map((value: unknown) => {
      const item = object(value);
      exact(item, ["file", "line", "summary", "scenario"]);
      const file = note(item["file"], 512);
      const line = item["line"];
      if (
        file.startsWith("/") ||
        file.includes(":") ||
        file.includes("\\") ||
        file.split("/").includes("..") ||
        typeof line !== "number" ||
        !Number.isSafeInteger(line) ||
        line < 1
      )
        throw new ControlError("invalid_request");
      return {
        file,
        line,
        summary: note(item["summary"], 1024),
        scenario: note(item["scenario"], 2048),
      };
    }),
  };
}
