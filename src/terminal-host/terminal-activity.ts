import type { TerminalActivity, TerminalTelemetry } from "../shared/desktop";

type Meter = {
  rate: number;
  bytes: number;
  lastOutput: number;
  pending: number;
  prompt: boolean;
  quiet: boolean;
};

/** One host timer batches all meters; neither parsing nor sampling needs a view. */
export class TerminalActivityMeter {
  private readonly meters = new Map<string, Meter>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private sampled = 0;

  constructor(private readonly events: TerminalTelemetry) {}

  start(id: string): void {
    this.meters.set(id, {
      rate: 0,
      bytes: 0,
      lastOutput: performance.now(),
      pending: 0,
      prompt: false,
      quiet: false,
    });
    this.schedule();
  }

  private schedule(): void {
    if (!this.timer) {
      this.sampled = performance.now();
      this.timer = setInterval(() => {
        this.tick();
      }, 100);
    }
  }

  output(id: string, data: string): void {
    const meter = this.meters.get(id);
    if (!data || !meter) return;
    meter.bytes += Buffer.byteLength(data, "utf8");
    meter.lastOutput = performance.now();
    meter.pending++;
    meter.quiet = false;
    this.schedule();
  }

  parsed(id: string, lastLine: string): void {
    const meter = this.meters.get(id);
    if (!meter) return;
    meter.pending--;
    meter.prompt = /(?:\?|\([yn]\/[yn]\)|password:|press enter[.:]?)\s*$/i.test(lastLine);
  }

  remove(id: string): void {
    this.meters.delete(id);
    if (!this.meters.size) this.dispose();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.meters.clear();
  }

  private tick(): void {
    const now = performance.now();
    const elapsed = (now - this.sampled) / 1000;
    this.sampled = now;
    const decay = Math.exp(-elapsed / 0.5);
    const batch: TerminalActivity[] = [];
    for (const [id, meter] of this.meters) {
      const previous = meter.rate;
      meter.rate = meter.rate * decay + (meter.bytes / elapsed) * (1 - decay);
      meter.bytes = 0;
      if (meter.rate < 0.1) meter.rate = 0;
      if (meter.rate !== previous) batch.push({ id, rate: meter.rate });
      if (
        !meter.quiet &&
        meter.pending === 0 &&
        now - meter.lastOutput >= (meter.prompt ? 500 : 2000)
      ) {
        meter.quiet = true;
        this.events.onQuiet?.(id);
      }
    }
    if (batch.length) this.events.onActivity?.(batch);
    if ([...this.meters.values()].every((meter) => meter.quiet && meter.rate === 0)) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
