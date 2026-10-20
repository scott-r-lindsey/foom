import type { AgentRule } from "./agent-rule-types";
import { agentProviders } from "../agents/providers/registry";
import { detectAgent } from "./agent-rules";
import type { EvaluationInput, Verdict } from "../../shared/evaluator";

function verdict(
  state: Verdict["state"],
  reason: string,
  signal: string,
  confidence: number,
): Verdict {
  return {
    state,
    reason,
    signal,
    confidence,
    ...(state === "needs_input"
      ? {
          attentionKind:
            signal === "pattern:password"
              ? ("credential" as const)
              : signal === "pattern:confirmation" ||
                  reason === "Agent requests permission" ||
                  reason === "Confirmation requested" ||
                  reason === "Approval requested"
                ? ("permission" as const)
                : ("unknown" as const),
        }
      : {}),
  };
}

/** Quiet-time rules only. No output is executed, interpreted as instructions, or sent out. */
export function evaluateRules(input: EvaluationInput, rules?: AgentRule[]): Verdict {
  // Exit is final: a delayed hook must not resurrect an exited terminal.
  if (input.exitCode !== undefined && Number.isSafeInteger(input.exitCode)) {
    return input.exitCode === 0
      ? verdict("done", "Process exited successfully", "process:exit", 1)
      : verdict("failed", "Process exited with an error", "process:exit", 1);
  }
  if (input.hook?.terminalId === input.terminalId && input.hook.action === "needs_input") {
    return verdict("needs_input", "Agent requests permission", input.hook.signal, 1);
  }
  if (input.hook?.terminalId === input.terminalId && input.hook.action === "failed")
    return verdict(
      "failed",
      "Agent execution ended with an error or step limit",
      input.hook.signal,
      1,
    );
  const detected =
    input.agent && input.evidence
      ? detectAgent(input.agent, input.evidence, input.tail, rules)
      : undefined;
  if (detected?.state === "blocked") {
    const blocked = verdict(
      "needs_input",
      detected.reason,
      `rules:${input.agent ?? ""}:${detected.id}`,
      0.95,
    );
    // Only the packaged adapter selects this namespace; output cannot supply a kind.
    return detected.id.startsWith("provider_") ||
      agentProviders()
        .find((provider) => provider.id === input.agent)
        ?.model.execution.providerRules.includes(detected.id)
      ? { ...blocked, attentionKind: "provider" }
      : blocked;
  }
  if (detected?.state === "working")
    return verdict("working", detected.reason, `rules:${input.agent ?? ""}:${detected.id}`, 0.95);
  if (input.promptReturned === true) {
    return verdict("done", "Shell prompt returned", "process:prompt", 0.95);
  }

  // Old prompts in scrollback aren't evidence of a current request. The host supplies
  // plain-text screen lines; only the last nonblank line can request attention.
  const last =
    input.tail
      .slice(-40)
      .findLast((line) => line.trim().length > 0)
      ?.trim() ?? "";
  if (/^(?:.{0,200}\s)?(?:\(y\/n\)|\[y\/n\]|\[yes\/no\])\s*[?:]?$/i.test(last)) {
    return verdict("needs_input", "Waiting for yes or no", "pattern:confirmation", 0.95);
  }
  if (
    /^(?:(?:enter|type)\s+)?(?:(?:sudo|account|login|\[sudo\])\s+)?password(?: for [^:\r\n]{1,80})?\s*:\s*$/i.test(
      last,
    )
  ) {
    return verdict("needs_input", "Waiting for a password", "pattern:password", 0.95);
  }
  const context =
    last.endsWith("?") || /:\s*$/u.test(last) ? input.tail.slice(-12).join("\n").slice(-6000) : "";
  if (
    /\b(?:password|passphrase|api[ _-]?key|access token|verification code|one.time code)\b/iu.test(
      context,
    )
  )
    return {
      ...verdict("needs_input", "Credential context requires you", "pattern:credential", 0.95),
      attentionKind: "credential",
    };
  if (
    /\b(?:allow|approve|approval|permission|confirm|authorize|trust|proceed|execute)\b|\[y\/n\]|\(y\/n\)/iu.test(
      context,
    )
  )
    return {
      ...verdict("needs_input", "Permission context requires you", "pattern:permission", 0.95),
      attentionKind: "permission",
    };
  if (
    /^(?:what|which|how|where|when|why|do you|would you|should (?:I|we)|can you)\b[^\r\n]{1,500}\?$/iu.test(
      last,
    )
  )
    return {
      ...verdict("needs_input", "Agent asks a question", "pattern:question", 0.9),
      attentionKind: "question",
    };
  if (/^press\s+(?:enter|return)(?:\s+to\s+(?:continue|proceed|exit))?[.!:]?$/i.test(last)) {
    return verdict("needs_input", "Waiting for Enter", "pattern:enter", 0.95);
  }
  if (
    /^(?:FAIL\s+\S.*|Tests:\s+\d+ failed\b.*|Test Files\s+\d+ failed\b.*|\d+ failed(?:, \d+ passed)? in \d.*)$/i.test(
      last,
    )
  ) {
    return verdict("failed", "Test runner reported failures", "pattern:test-failure", 0.9);
  }
  if (
    /^(?:listening on|server (?:running|listening) (?:at|on)|local:)\s+https?:\/\/\S+\s*$/i.test(
      last,
    )
  ) {
    return verdict("quiet_ok", "Server is listening", "pattern:server", 0.9);
  }
  if (detected?.state === "idle")
    return verdict("working", detected.reason, `rules:${input.agent ?? ""}:${detected.id}`, 0.25);
  return verdict("working", "No completion or input request detected", "rules:ambiguous", 0.25);
}
