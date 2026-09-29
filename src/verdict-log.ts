import { randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { evaluateRules } from "./evaluator";
import type { EvaluationInput, VerdictAction, VerdictRecord } from "./shared/evaluator";

/** One main-process writer; append-only metadata, never tails, prompts, or keystrokes. */
export class VerdictLog {
  private writes: Promise<void> = Promise.resolve();
  private readonly pending = new Map<string, string>();

  constructor(private readonly userData: string) {}

  private append(record: unknown): Promise<void> {
    const json = `${JSON.stringify(record)}\n`;
    const write = this.writes.then(async () => {
      await mkdir(this.userData, { recursive: true, mode: 0o700 });
      const file = await open(path.join(this.userData, "verdicts.jsonl"), "a", 0o600);
      try {
        await file.writeFile(json, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
    });
    this.writes = write.catch(() => undefined);
    return write;
  }

  async evaluate(input: EvaluationInput): Promise<VerdictRecord> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.terminalId)) {
      throw new Error("Invalid terminal ID");
    }
    const record: VerdictRecord = {
      id: randomUUID(),
      terminalId: input.terminalId,
      timestamp: new Date().toISOString(),
      verdict: evaluateRules(input),
    };
    await this.append({ type: "verdict", ...record });
    this.pending.set(record.id, record.terminalId);
    return record;
  }

  /** Call explicitly for ignored; opening a terminal is not a reply or dismissal. */
  async recordAction(terminalId: string, verdictId: string, action: VerdictAction): Promise<void> {
    if (
      this.pending.get(verdictId) !== terminalId ||
      !["replied", "dismissed", "ignored"].includes(action)
    ) {
      throw new Error("Invalid verdict feedback");
    }
    // Reserve synchronously so concurrent calls cannot record two next actions.
    this.pending.delete(verdictId);
    try {
      await this.append({
        type: "action",
        terminalId,
        verdictId,
        action,
        timestamp: new Date().toISOString(),
        feedback: action === "dismissed" ? "not_attention" : null,
      });
    } catch (error) {
      this.pending.set(verdictId, terminalId);
      throw error;
    }
  }
}
