import { monitorEventLoopDelay, performance } from "node:perf_hooks";

const SAMPLE_MS = 100;
const RESOLUTION_MS = 10;
const WINDOW_MS = 5000;

/** Electron does not report Node's eventLoopUtilization idle clock. Discount
 * main-thread CPU and native loop overruns instead; missed turns reset the window.
 * Overlapping CPU/lag is deliberately discounted twice, conservatively.
 */
export function watchHostLiveness(unresponsive: () => void): () => void {
  const delay = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  delay.enable();
  let previous = performance.now();
  let cpu = process.threadCpuUsage();
  let remaining = WINDOW_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let final: ReturnType<typeof setImmediate> | undefined;
  const observe = (maximumGap: number) => {
    const now = performance.now();
    const nextCpu = process.threadCpuUsage();
    const elapsed = now - previous;
    const busy = Math.max(0, nextCpu.user - cpu.user + nextCpu.system - cpu.system) / 1000;
    const lag = delay.count ? Math.max(0, delay.mean / 1e6 - RESOLUTION_MS) * delay.count : 0;
    delay.reset();
    if (elapsed > maximumGap) {
      remaining = WINDOW_MS;
      // Start a fresh native epoch too: a delayed histogram callback must not
      // charge the old pause again after main has resumed.
      delay.disable();
      delay.enable();
    } else remaining += lag - Math.max(0, Math.min(SAMPLE_MS, elapsed) - busy);
    previous = now;
    cpu = nextCpu;
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    if (final !== undefined) clearImmediate(final);
    delay.disable();
  };
  const sample = () => {
    observe(SAMPLE_MS * 2);
    if (remaining <= 0) {
      // Poll queued port messages before deciding; account for any further main
      // delay before this check-phase turn, including a pending native lag sample.
      final = setImmediate(() => {
        final = undefined;
        if (stopped) return;
        observe(SAMPLE_MS);
        if (remaining > 0) timer = setTimeout(sample, SAMPLE_MS);
        else {
          stop();
          unresponsive();
        }
      });
    } else timer = setTimeout(sample, SAMPLE_MS);
  };
  timer = setTimeout(sample, SAMPLE_MS);
  return stop;
}
