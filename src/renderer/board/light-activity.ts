import type { BoardSource } from "./board-source";
import type { BoardRow } from "./board.d";

export const shellOutputLevel = (rate: number): number =>
  Math.min(1, Math.log1p(Math.max(0, rate) / 40) / Math.log1p(100));
// Measured agent redraws already occupy this range; do not saturate them earlier.
export const agentOutputLevel = (rate: number): number => shellOutputLevel(rate);
export const smoothLevel = (previous: number, target: number, elapsed: number): number =>
  previous + (target - previous) * (1 - Math.exp(-elapsed / (target > previous ? 120 : 700)));
export const movingLight = (row: BoardRow): boolean =>
  !row.exited && row.state !== "needs_input" && (row.kind === "shell" || row.state === "working");
export const lightState = (row: BoardRow): string =>
  row.kind === "shell"
    ? row.state === "needs_input" && !row.exited
      ? "needs_input"
      : "shell"
    : row.exited && row.state !== "done" && row.state !== "failed"
      ? "quiet_ok"
      : row.state;

export class LightHistory {
  level = 0;
  private target = 0;
  private targetAt = -Infinity;
  private sampleAt = -Infinity;
  private tracePeak = 0;
  private readonly history: { at: number; level: number }[] = [];
  step(
    rate: number,
    now: number,
    elapsed: number,
    reduced: boolean,
    kind: BoardRow["kind"] = "shell",
  ): { level: number; path: string } | undefined {
    const level = kind === "agent" ? agentOutputLevel(rate) : shellOutputLevel(rate);
    // Trace peaks bypass the glow hold and envelope, so brief output is not lost.
    this.tracePeak = Math.max(this.tracePeak, level);
    // Hold rate targets for at least a third of a second, independently of IPC frequency.
    if (now - this.targetAt >= 1000 / 3) {
      this.target = level;
      this.targetAt = now;
    }
    this.level = smoothLevel(this.level, this.target, elapsed);
    if (now - this.sampleAt < (reduced ? 1000 : 250)) return undefined;
    this.sampleAt = now;
    const shown = reduced ? Math.round(this.level * 3) / 3 : this.level;
    const traceLevel = reduced ? Math.round(this.tracePeak * 3) / 3 : this.tracePeak;
    this.history.push({ at: now, level: traceLevel });
    this.tracePeak = 0;
    while (this.history[0] && (this.history[0].at < now - 8000 || this.history.length > 33))
      this.history.shift();
    return {
      level: shown,
      path: this.history
        .map(
          (sample, i) =>
            `${i ? "L" : "M"}${(34 - ((now - sample.at) * 34) / 8000).toFixed(1)} ${(11 - sample.level * 10).toFixed(1)}`,
        )
        .join(" "),
    };
  }
}

type Target = { row: BoardRow; element: HTMLElement; trace?: SVGPathElement | null | undefined };
/** DOM-only activity, owned and disposed by the mounted sidebar or tile. */
export function subscribeLights(source: BoardSource, targets: () => Target[]): () => void {
  const meters = new Map<string, { history: LightHistory; rate: number; version: number }>();
  const latest = new Map<string, { rate: number; version: number }>();
  const off = source.subscribeActivity((batch) => {
    for (const { id, rate } of batch) {
      const row = source.getSnapshot().find((item) => item.id === id);
      if (row && !row.exited) latest.set(id, { rate, version: row.launchVersion ?? 0 });
    }
  });
  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    const reduced =
      typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const retained = new Set<string>();
    for (const [id, rate] of latest) {
      const row = source.getSnapshot().find((item) => item.id === id);
      if (!row || row.exited || rate.version !== (row.launchVersion ?? 0)) latest.delete(id);
    }
    for (const { row, element, trace } of targets()) {
      if (!movingLight(row)) {
        trace?.setAttribute("d", "");
        continue;
      }
      retained.add(row.id);
      let meter = meters.get(row.id);
      if (!meter || meter.version !== (row.launchVersion ?? 0)) {
        meter = { history: new LightHistory(), rate: row.rate, version: row.launchVersion ?? 0 };
        meters.set(row.id, meter);
      }
      meter.rate = latest.get(row.id)?.rate ?? meter.rate;
      const sample = meter.history.step(meter.rate, now, now - last, reduced, row.kind);
      if (!reduced || sample)
        element.style.setProperty(
          "--activity",
          String(reduced ? sample?.level : meter.history.level),
        );
      if (sample) trace?.setAttribute("d", sample.path);
    }
    for (const id of meters.keys()) if (!retained.has(id)) meters.delete(id);
    last = now;
  };
  tick();
  const timer = window.setInterval(tick, 50);
  return () => {
    off();
    window.clearInterval(timer);
    meters.clear();
    latest.clear();
  };
}
