import { performance } from "node:perf_hooks";

const RESPONSE_MS = 5000;
const MAX_PROBE_MS = 15000;
const LATE_TURN_MS = 100;

/** One absolute cap, independent of main load. A late turn may grant a fresh
 * response window, clamped to that cap. Always drain messages before deciding.
 * If main was blocked across the cap, retire on its first drain opportunity.
 */
export function watchHostLiveness(unresponsive: () => void): () => void {
  const started = performance.now();
  const limit = started + MAX_PROBE_MS;
  let deadline = started + RESPONSE_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let drain: ReturnType<typeof setTimeout> | undefined;
  let final: ReturnType<typeof setImmediate> | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    if (drain !== undefined) clearTimeout(drain);
    if (final !== undefined) clearImmediate(final);
  };
  const expired = () => {
    // Cross a timer and poll/check turn, allowing already queued host messages
    // to cancel retirement even when the expired timer dispatched first.
    drain = setTimeout(() => {
      drain = undefined;
      final = setImmediate(() => {
        final = undefined;
        if (stopped) return;
        const now = performance.now();
        if (now < limit && now > deadline + LATE_TURN_MS) {
          deadline = Math.min(now + RESPONSE_MS, limit);
          timer = setTimeout(expired, deadline - now);
        } else {
          stop();
          unresponsive();
        }
      });
    }, 0);
  };
  timer = setTimeout(expired, RESPONSE_MS);
  return stop;
}
