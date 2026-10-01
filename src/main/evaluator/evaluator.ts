import type { EvaluationInput, Verdict } from "../../shared/evaluator";

function verdict(
  state: Verdict["state"],
  reason: string,
  signal: string,
  confidence: number,
): Verdict {
  return { state, reason, signal, confidence };
}

/** Quiet-time rules only. No output is executed, interpreted as instructions, or sent out. */
export function evaluateRules(input: EvaluationInput): Verdict {
  // Exit is final: a delayed hook must not resurrect an exited terminal.
  if (input.exitCode !== undefined && Number.isSafeInteger(input.exitCode)) {
    return input.exitCode === 0
      ? verdict("done", "Process exited successfully", "process:exit", 1)
      : verdict("failed", "Process exited with an error", "process:exit", 1);
  }
  if (input.hook?.terminalId === input.terminalId && input.hook.action === "needs_input") {
    return verdict("needs_input", "Agent requests permission", input.hook.signal, 1);
  }
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
  return verdict("working", "Quiet without decisive evidence", "rules:ambiguous", 0.25);
}
