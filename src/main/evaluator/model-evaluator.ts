import { evaluateRules } from "./evaluator";
import { CHECK_SAMPLE, classifierPrompt, parseModelVerdict } from "./inference-input";
import type { EvaluationInput, Verdict } from "../../shared/evaluator";
import type { InferenceSource, ModelCheck } from "../../shared/inference";

/** One instance per app; no waiting queue, retries, or unbounded background calls. */
export class ModelEvaluator {
  private active = 0;
  constructor(
    private readonly source?: InferenceSource,
    private readonly timeoutMs = 5000,
    private readonly concurrency = 2,
  ) {
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 30_000 ||
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > 4
    ) {
      throw new Error("Invalid evaluator limits");
    }
  }

  async evaluate(input: EvaluationInput): Promise<Verdict> {
    const rules = evaluateRules(input);
    if (rules.signal !== "rules:ambiguous") return rules;
    return (await this.check(input.tail, rules)).verdict;
  }

  /** Setup's Run check deliberately exercises inference even for an obvious sample. */
  runCheck(tail: readonly string[] = [CHECK_SAMPLE]): Promise<ModelCheck> {
    return this.check(tail, evaluateRules({ terminalId: "sample", tail }));
  }

  private async check(tail: readonly string[], fallback: Verdict): Promise<ModelCheck> {
    const start = performance.now();
    const result = (status: ModelCheck["status"], verdict = fallback): ModelCheck => ({
      status,
      verdict,
      elapsedMs: Math.round(performance.now() - start),
    });
    if (!this.source) return result("rules");
    if (this.active >= this.concurrency) return result("busy");
    this.active++;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const prompt = classifierPrompt(tail);
      // Retain the slot until the underlying operation actually settles, even if
      // a broken transport ignores abort. Later calls then fail closed as busy.
      const pending = this.source.complete(prompt, controller.signal).finally(() => {
        this.active--;
      });
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Inference deadline"));
        }, this.timeoutMs);
      });
      const text = await Promise.race([pending, deadline]);
      return result("model", parseModelVerdict(text));
    } catch {
      return result(controller.signal.aborted ? "timeout" : "failed");
    } finally {
      clearTimeout(timer);
      // Input preparation or a synchronous transport failure never occupied a slot.
      if (!timer) this.active--;
    }
  }
}
