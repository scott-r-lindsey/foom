import { randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { evaluateRules } from "./evaluator";
import type {
  EvaluationInput,
  Verdict,
  VerdictAction,
  VerdictRecord,
} from "../../shared/evaluator";

/** One main-process writer; append-only metadata, never tails, prompts, or keystrokes. */
export class VerdictLog {
  private writes: Promise<void> = Promise.resolve();
  private readonly pending = new Map<string, { verdictId: string | null }>();

  constructor(
    private readonly userData: string,
    private readonly classifier: (
      input: EvaluationInput,
    ) => Verdict | Promise<Verdict> = evaluateRules,
  ) {}

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

  /** Classifies without writing, so a storage failure can't hide the verdict. */
  async classify(input: EvaluationInput): Promise<VerdictRecord> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.terminalId)) {
      throw new Error("Invalid terminal ID");
    }
    return {
      id: randomUUID(),
      terminalId: input.terminalId,
      timestamp: new Date().toISOString(),
      verdict: await this.classifier(input),
    };
  }

  /** Writes a classified verdict; only committed verdicts accept feedback. */
  async commit(record: VerdictRecord): Promise<void> {
    const entry = this.pending.get(record.terminalId) ?? { verdictId: null };
    this.pending.set(record.terminalId, entry);
    await this.append({ type: "verdict", ...record });
    // Removal while the write was pending must not recreate feedback entries.
    if (this.pending.get(record.terminalId) === entry) entry.verdictId = record.id;
  }

  /** Drop feedback for a removed terminal, including writes still in flight. */
  forget(terminalId: string): void {
    this.pending.delete(terminalId);
  }

  async evaluate(input: EvaluationInput): Promise<VerdictRecord> {
    const record = await this.classify(input);
    await this.commit(record);
    return record;
  }

  /** Call explicitly for ignored; opening a terminal is not a reply or dismissal. */
  async recordAction(terminalId: string, verdictId: string, action: VerdictAction): Promise<void> {
    const entry = this.pending.get(terminalId);
    if (
      !entry ||
      entry.verdictId !== verdictId ||
      !["replied", "dismissed", "ignored"].includes(action)
    ) {
      throw new Error("Invalid verdict feedback");
    }
    // Reserve synchronously so concurrent calls cannot record two next actions.
    entry.verdictId = null;
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
      const current = this.pending.get(terminalId);
      if (current?.verdictId === null && current === entry) current.verdictId = verdictId;
      throw error;
    }
  }
}
